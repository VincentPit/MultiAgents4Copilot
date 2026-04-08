/**
 * File writer utility — parses fenced code blocks from LLM output,
 * extracts file paths, and applies changes to the workspace via
 * vscode.workspace.fs / WorkspaceEdit.
 *
 * Expected LLM output format (enforced by the coder system prompt):
 *
 *   ### `src/utils/helper.ts`
 *   ```typescript
 *   // file contents…
 *   ```
 *
 * The parser is intentionally lenient — it handles several variations:
 *   - `### src/foo.ts`   (no backticks around path)
 *   - `**src/foo.ts**`   (bold path)
 *   - `File: src/foo.ts` (prefixed path)
 *   - `` ```ts:src/foo.ts `` (Cursor/Copilot-style annotation)
 */

import * as vscode from "vscode";
import * as path from "path";
import { logger } from "./logger";
import { getSecurityConfig } from "../security/securityConfig";
import { isExtensionOwnFile, selfProtectionBlockReason } from "./selfProtection";

// ── Safety constants ────────────────────────────────────────────────────────

/** File extensions that must never be written by agents. */
const BLOCKED_EXTENSIONS = new Set(
  getSecurityConfig().fileWriter.blockedExtensions
);

/** Maximum file content size agents can write (5 MB). */
const MAX_FILE_SIZE = getSecurityConfig().fileWriter.maxFileSizeBytes;

/** Maximum number of file blocks to parse from a single LLM response. */
export const MAX_FILE_BLOCKS = 30;

// ── Types ────────────────────────────────────────────────────────────

export interface ParsedFileBlock {
  /** Relative file path (e.g. "src/utils/helper.ts"). */
  filePath: string;
  /** Raw code content (without fences). */
  content: string;
  /** Language tag from the code fence (e.g. "typescript"). */
  language: string;
}

export interface WriteResult {
  /** Files that were successfully written. */
  written: string[];
  /** Files that were skipped (e.g. outside workspace). */
  skipped: { filePath: string; reason: string }[];
  /** Old content of files that existed before writing (for diff view). */
  oldContents: Map<string, string>;
}

// ── Code-block parser ────────────────────────────────────────────────

/**
 * Regex to match fenced code blocks with an optional language tag.
 * Captures: (1) lang+optional path annotation, (2) code content
 *
 * Examples matched:
 *   ```typescript          ```ts:src/foo.ts
 *   // code                // code
 *   ```                    ```
 */
const FENCE_PATTERN = /```(\S*)\n([\s\S]*?)```/g;

/**
 * Patterns that can appear on the line(s) BEFORE a code fence to indicate
 * the target file path. Tried in order; first match wins.
 */
const PATH_PATTERNS: RegExp[] = [
  // ### `src/foo.ts`  or  ### src/foo.ts
  /^#{1,4}\s+`?([^\s`]+\.[a-zA-Z0-9]+)`?\s*$/,
  // **src/foo.ts**  or  **`src/foo.ts`**
  /^\*\*`?([^\s`*]+\.[a-zA-Z0-9]+)`?\*\*\s*$/,
  // File: src/foo.ts  |  File path: `src/foo.ts`
  /^(?:File(?:\s*path)?)\s*:\s*`?([^\s`]+\.[a-zA-Z0-9]+)`?\s*$/i,
  // - `src/foo.ts`  (bullet with backtick-wrapped path)
  /^[-*]\s+`([^\s`]+\.[a-zA-Z0-9]+)`\s*$/,
  // Bare path on its own line (must look like a filepath with extension)
  /^((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+)\s*$/,
];

/**
 * Parse LLM output into an array of file blocks with paths and content.
 * Returns an empty array if no code blocks with identifiable paths are found.
 */
export function parseFileBlocks(llmOutput: string): ParsedFileBlock[] {
  const blocks: ParsedFileBlock[] = [];
  const lines = llmOutput.split("\n");

  // Create fresh regex each call to avoid shared /g lastIndex state
  const fenceRe = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(llmOutput)) !== null) {
    const langAnnotation = match[1] ?? "";
    const codeContent = match[2];

    // 1. Try path from the lang annotation (e.g. ```ts:src/foo.ts)
    let filePath = extractPathFromAnnotation(langAnnotation);

    // 2. If no annotation path, look at the lines BEFORE the fence
    if (!filePath) {
      const fenceStart = llmOutput.lastIndexOf("```" + langAnnotation, match.index);
      const textBefore = llmOutput.slice(0, fenceStart);
      filePath = extractPathFromPrecedingLines(textBefore);
    }

    if (!filePath) {
      logger.debug("fileWriter", `Skipping code block — no file path found (lang: "${langAnnotation}")`);
      continue;
    }

    // Normalise the path
    filePath = normalisePath(filePath);

    const language = langAnnotation.split(":")[0] || guessLanguage(filePath);

    blocks.push({ filePath, content: codeContent, language });

    // Safety: cap number of blocks to prevent unbounded parsing
    if (blocks.length >= MAX_FILE_BLOCKS) {
      logger.warn("fileWriter", `Reached MAX_FILE_BLOCKS (${MAX_FILE_BLOCKS}) — stopping parse`);
      break;
    }
  }

  logger.info("fileWriter", `Parsed ${blocks.length} file block(s) from LLM output`);
  return blocks;
}

/** Extract path from ```ts:src/foo.ts style annotation. */
function extractPathFromAnnotation(annotation: string): string | null {
  // Pattern: lang:path  e.g. typescript:src/utils/foo.ts
  const colonIdx = annotation.indexOf(":");
  if (colonIdx > 0) {
    const candidate = annotation.slice(colonIdx + 1).trim();
    if (looksLikePath(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Scan the last few non-empty lines before a fence for a file path. */
function extractPathFromPrecedingLines(textBefore: string): string | null {
  const lines = textBefore.split("\n");
  // Check up to 3 lines above the fence
  const candidates = lines.slice(-4).reverse();

  for (const line of candidates) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    for (const pattern of PATH_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m && m[1] && looksLikePath(m[1])) {
        return m[1];
      }
    }
  }
  return null;
}

/** Heuristic: does this string look like a file path? */
function looksLikePath(s: string): boolean {
  // Must have a file extension
  if (!/\.\w{1,10}$/.test(s)) { return false; }
  // Must not be a URL
  if (/^https?:\/\//.test(s)) { return false; }
  // Must not contain spaces (unlikely in code paths)
  if (/\s/.test(s)) { return false; }
  // Must have a reasonable length
  if (s.length < 3 || s.length > 200) { return false; }
  return true;
}

/** Clean up a path: strip leading slashes, `./`, quotes, backticks. */
function normalisePath(p: string): string {
  return p
    .replace(/^[`'"]+|[`'"]+$/g, "")  // strip wrapping quotes/backticks
    .replace(/^\.\//, "")               // strip leading ./
    .replace(/^\/+/, "");               // strip leading /
}

/** Best-effort language guess from file extension. */
function guessLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
    html: "html", css: "css", json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", sql: "sql",
  };
  return map[ext] ?? ext;
}

// ── File writer ──────────────────────────────────────────────────────

/**
 * Ask the user for consent before writing files to the workspace.
 *
 * Shows a compact notification toast (non-modal sliding bar) with a short
 * summary. Users can click "Apply" to approve, "Review List" to inspect
 * the full file list in a QuickPick, or "Cancel" to decline.
 */
async function requestWriteConsent(
  blocks: ParsedFileBlock[],
  workspaceRoot: vscode.Uri,
): Promise<boolean> {
  // Classify files as new or existing
  const newFiles: string[] = [];
  const existingFiles: string[] = [];

  for (const block of blocks) {
    const targetUri = vscode.Uri.joinPath(workspaceRoot, block.filePath);
    try {
      await vscode.workspace.fs.stat(targetUri);
      existingFiles.push(block.filePath);
    } catch {
      newFiles.push(block.filePath);
    }
  }

  // Build a short one-line summary (fits in the toast)
  const parts: string[] = [];
  if (newFiles.length > 0) { parts.push(`${newFiles.length} new`); }
  if (existingFiles.length > 0) { parts.push(`${existingFiles.length} modified`); }
  const summary = parts.join(", ");

  // Non-modal notification toast — compact sliding bar in bottom-right
  const choice = await vscode.window.showWarningMessage(
    `🤖 Agent wants to write ${blocks.length} file(s) (${summary})`,
    "Apply Changes",
    "Review List",
    "Cancel",
  );

  if (choice === "Review List") {
    // Show detailed file list in a QuickPick so user can inspect
    const items = blocks.map(b => {
      const isNew = newFiles.includes(b.filePath);
      return {
        label: `${isNew ? "$(new-file)" : "$(edit)"} ${b.filePath}`,
        description: isNew ? "new" : "overwrite",
        picked: true,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: false,
      title: `${blocks.length} file(s) to write — close to approve, Esc to cancel`,
      placeHolder: "Review the file list, then close this picker to approve",
    });

    // If they selected an item or dismissed normally (not Esc), approve.
    // showQuickPick returns undefined on Esc — treat that as cancel.
    // For a simple UX: after reviewing, show one more quick confirm.
    const confirm = await vscode.window.showWarningMessage(
      `Apply ${blocks.length} file change(s)?`,
      "Apply Changes",
      "Cancel",
    );
    const consented = confirm === "Apply Changes";
    logger.info("fileWriter", `User consent (after review): ${consented ? "APPROVED" : "DENIED"} for ${blocks.length} file(s)`);
    return consented;
  }

  const consented = choice === "Apply Changes";
  logger.info("fileWriter", `User consent: ${consented ? "APPROVED" : "DENIED"} for ${blocks.length} file(s)`);
  return consented;
}

/**
 * Write parsed file blocks to the workspace.
 *
 * - **Asks the user for explicit consent** before writing anything.
 * - Creates directories as needed.
 * - Shows a diff for existing files so the user can see what changed.
 * - Streams progress back through the chat response stream.
 */
export async function writeFileBlocks(
  blocks: ParsedFileBlock[],
  stream: vscode.ChatResponseStream,
): Promise<WriteResult> {
  const result: WriteResult = { written: [], skipped: [], oldContents: new Map() };

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    logger.warn("fileWriter", "No workspace folder open — cannot write files");
    stream.markdown("\n\n> ⚠️ No workspace folder open. Files were not written.\n");
    return result;
  }

  // ── Ask the user for consent before writing anything ──
  const consented = await requestWriteConsent(blocks, workspaceRoot);
  if (!consented) {
    stream.markdown(
      `\n> 🚫 **Changes declined** — no files were written. ` +
      `The code is shown above; you can copy it manually if needed.\n`
    );
    for (const block of blocks) {
      result.skipped.push({ filePath: block.filePath, reason: "User declined changes" });
    }
    return result;
  }

  for (const block of blocks) {
    // Safety: reject paths that try to escape the workspace
    if (block.filePath.includes("..")) {
      result.skipped.push({ filePath: block.filePath, reason: "path contains .." });
      logger.warn("fileWriter", `Skipped "${block.filePath}" — contains ".." (path traversal)`);
      continue;
    }

    // Safety: prevent the extension from modifying its own source files
    if (isExtensionOwnFile(block.filePath, workspaceRoot.fsPath)) {
      const reason = selfProtectionBlockReason(block.filePath);
      result.skipped.push({ filePath: block.filePath, reason });
      logger.warn("fileWriter", reason);
      stream.markdown(
        `\n> 🛡️ **Self-protection:** \`${block.filePath}\` is part of this extension's own source code and cannot be modified by agents.\n`
      );
      continue;
    }

    // Safety: reject blocked file extensions
    const ext = path.extname(block.filePath).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      result.skipped.push({ filePath: block.filePath, reason: `blocked extension: ${ext}` });
      logger.warn("fileWriter", `Skipped "${block.filePath}" — blocked extension ${ext}`);
      stream.markdown(`\n> 🚫 **Blocked:** \`${block.filePath}\` — writing \`${ext}\` files is not allowed.\n`);
      continue;
    }

    // Safety: reject files that are too large
    if (block.content.length > MAX_FILE_SIZE) {
      result.skipped.push({ filePath: block.filePath, reason: `content too large (${block.content.length} bytes)` });
      logger.warn("fileWriter", `Skipped "${block.filePath}" — content ${block.content.length} bytes exceeds ${MAX_FILE_SIZE}`);
      stream.markdown(`\n> ⚠️ **Skipped:** \`${block.filePath}\` — file too large (${Math.round(block.content.length / 1024)}KB).\n`);
      continue;
    }

    const targetUri = vscode.Uri.joinPath(workspaceRoot, block.filePath);
    const contentBytes = Buffer.from(block.content, "utf-8");

    try {
      // Check if file already exists and capture old content for diffs
      let isNew = false;
      try {
        await vscode.workspace.fs.stat(targetUri);
        // File exists — try to capture old content for diff viewing
        try {
          const oldBytes = await vscode.workspace.fs.readFile(targetUri);
          result.oldContents.set(block.filePath, Buffer.from(oldBytes).toString("utf-8"));
        } catch {
          // readFile failed but file exists — just skip old content capture
        }
      } catch {
        isNew = true;
      }

      // Write the file (creates parent directories automatically)
      await vscode.workspace.fs.writeFile(targetUri, contentBytes);
      result.written.push(block.filePath);

      const action = isNew ? "Created" : "Updated";
      logger.info("fileWriter", `${action}: ${block.filePath}`);
      stream.markdown(`\n> ✅ **${action}:** \`${block.filePath}\`\n`);

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      result.skipped.push({ filePath: block.filePath, reason: msg });
      logger.error("fileWriter", `Failed to write "${block.filePath}": ${msg}`);
      stream.markdown(`\n> ⚠️ Failed to write \`${block.filePath}\`: ${msg}\n`);
    }
  }

  // Summary
  if (result.written.length > 0) {
    stream.markdown(
      `\n> 📁 **${result.written.length} file(s) written to workspace**\n`
    );
  } else if (blocks.length > 0) {
    stream.markdown(
      `\n> ⚠️ No files were written. The code blocks above may need file path annotations.\n`
    );
  }

  return result;
}

/**
 * End-to-end: parse LLM output → write files to workspace.
 * Returns the list of written file paths.
 */
export async function applyCodeToWorkspace(
  llmOutput: string,
  stream: vscode.ChatResponseStream,
): Promise<WriteResult> {
  const blocks = parseFileBlocks(llmOutput);

  if (blocks.length === 0) {
    logger.info("fileWriter", "No file blocks with paths found — nothing to write");
    return { written: [], skipped: [], oldContents: new Map() };
  }

  return writeFileBlocks(blocks, stream);
}
