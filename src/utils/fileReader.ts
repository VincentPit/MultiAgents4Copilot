/**
 * File reader utility — reads workspace files by path or glob pattern
 * so agents can "see" existing source code, not just a file tree.
 *
 * Usage:
 *   const files = await readFilesMatching(["src/api/**\/*.ts"], { maxFiles: 20 });
 *   const context = formatFilesForLLM(files, "Existing source files");
 *
 * Safety:
 *   - Total content is capped to prevent blowing the model's context window.
 *   - Binary files and enormous files are skipped automatically.
 *   - Extension's own source files are never returned (self-protection).
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { isExtensionOwnFile } from "./selfProtection";

// ── Types ────────────────────────────────────────────────────────────

export interface FileContent {
  /** Workspace-relative path (e.g. "src/api/routes.ts"). */
  path: string;
  /** File content — may be truncated if over maxCharsPerFile. */
  content: string;
  /** Detected language from extension. */
  language: string;
  /** Original size in chars (before truncation). */
  sizeChars: number;
}

export interface ReadFilesOptions {
  /** Max number of files to read (default 30). */
  maxFiles?: number;
  /** Max chars to read per file (default 8_000). */
  maxCharsPerFile?: number;
  /** Max total chars across all files (default 60_000). */
  maxTotalChars?: number;
  /** Glob pattern to exclude (default: node_modules, .git, dist, out, etc.). */
  excludePattern?: string;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE =
  "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**," +
  "**/coverage/**,**/__pycache__/**,**/target/**,**/.venv/**,**/venv/**," +
  "**/*.vsix,**/*.min.js,**/*.min.css,**/*.map,**/*.lock,**/package-lock.json," +
  "**/yarn.lock,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.ico,**/*.svg," +
  "**/*.woff,**/*.woff2,**/*.ttf,**/*.eot,**/*.mp3,**/*.mp4,**/*.zip," +
  "**/*.tar,**/*.gz,**/*.pdf,**/*.wasm,**/*.pyc,**/*.class,**/*.o,**/*.so," +
  "**/*.dylib,**/*.exe,**/*.dll}";

/** Binary or non-text extensions to skip entirely. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "svg", "bmp", "webp",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "avi", "mov", "webm", "ogg", "wav",
  "zip", "tar", "gz", "bz2", "7z", "rar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "wasm", "pyc", "class", "o", "so", "dylib", "exe", "dll",
  "vsix", "min.js", "min.css", "map",
]);

/** Language detection from file extension. */
function langFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact",
    js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go",
    java: "java", cs: "csharp", cpp: "cpp", c: "c",
    rb: "ruby", swift: "swift", kt: "kotlin",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", toml: "toml", sql: "sql",
    sh: "shellscript", bash: "shellscript",
    dockerfile: "dockerfile", xml: "xml",
    graphql: "graphql", gql: "graphql",
    prisma: "prisma", env: "dotenv",
    gradle: "groovy", properties: "properties",
  };
  return map[ext] ?? ext;
}

/** Check if a file path points to a binary/non-text file. */
function isBinaryPath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

// ── Request-scoped read cache ────────────────────────────────────────
// Multiple agents within a single graph run frequently re-read the same
// globs (coder revision loop, integrator re-reads written files, etc.).
// We cache by (patterns + options) and invalidate whenever fileWriter
// touches the workspace. The cache is module-scoped — callers should
// invoke clearFileReadCache() at the start of each graph run.

const _readCache = new Map<string, FileContent[]>();

function cacheKey(patterns: string[], options?: ReadFilesOptions): string {
  return JSON.stringify({
    p: [...patterns].sort(),
    f: options?.maxFiles ?? null,
    c: options?.maxCharsPerFile ?? null,
    t: options?.maxTotalChars ?? null,
    e: options?.excludePattern ?? null,
  });
}

/** Clear the file-read cache. Called by fileWriter after writes and at run start. */
export function clearFileReadCache(): void {
  if (_readCache.size > 0) {
    logger.info("fileReader", `Cache invalidated (${_readCache.size} entries)`);
    _readCache.clear();
  }
}

// ── Core read functions ──────────────────────────────────────────────

/**
 * Read files matching one or more glob patterns.
 * Returns file contents capped by maxFiles / maxCharsPerFile / maxTotalChars.
 *
 * Patterns use VS Code glob syntax (e.g. "src/api/**\/*.ts", "**\/*.py").
 */
export async function readFilesMatching(
  patterns: string[],
  options?: ReadFilesOptions
): Promise<FileContent[]> {
  const key = cacheKey(patterns, options);
  const cached = _readCache.get(key);
  if (cached) {
    logger.info("fileReader", `Cache hit for ${patterns.length} pattern(s) (${cached.length} files)`);
    return cached;
  }

  const maxFiles = options?.maxFiles ?? 30;
  const maxCharsPerFile = options?.maxCharsPerFile ?? 8_000;
  const maxTotalChars = options?.maxTotalChars ?? 60_000;
  const exclude = options?.excludePattern ?? DEFAULT_EXCLUDE;

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  // Collect unique file URIs from all patterns
  const seenPaths = new Set<string>();
  const allUris: vscode.Uri[] = [];

  for (const pattern of patterns) {
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude, maxFiles * 2);
      for (const uri of uris) {
        const relPath = vscode.workspace.asRelativePath(uri);
        if (!seenPaths.has(relPath)) {
          seenPaths.add(relPath);
          allUris.push(uri);
        }
      }
    } catch (err: any) {
      logger.warn("fileReader", `findFiles("${pattern}") failed: ${err?.message}`);
    }
  }

  // Sort by path for deterministic order, then cap
  allUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  const capped = allUris.slice(0, maxFiles);

  logger.info("fileReader", `Found ${allUris.length} files matching ${patterns.length} pattern(s), reading ${capped.length}`);

  const result = await readUris(capped, wsRoot, maxCharsPerFile, maxTotalChars);
  _readCache.set(key, result);
  return result;
}

/**
 * Read specific files by workspace-relative path.
 * Skips files that don't exist or can't be read.
 */
export async function readFilesByPath(
  paths: string[],
  options?: ReadFilesOptions
): Promise<FileContent[]> {
  const maxFiles = options?.maxFiles ?? 30;
  const maxCharsPerFile = options?.maxCharsPerFile ?? 8_000;
  const maxTotalChars = options?.maxTotalChars ?? 60_000;

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  if (!wsRoot) { return []; }

  const uris: vscode.Uri[] = [];
  for (const p of paths.slice(0, maxFiles)) {
    const absPath = p.startsWith("/") ? p : `${wsRoot}/${p}`;
    uris.push(vscode.Uri.file(absPath));
  }

  return readUris(uris, wsRoot, maxCharsPerFile, maxTotalChars);
}

/**
 * Read files that were written to disk (by path list).
 * Useful for the integrator to read the actual on-disk state after domain coders run.
 */
export async function readWrittenFiles(
  writtenPaths: string[],
  options?: ReadFilesOptions
): Promise<FileContent[]> {
  return readFilesByPath(writtenPaths, {
    maxFiles: options?.maxFiles ?? 50,
    maxCharsPerFile: options?.maxCharsPerFile ?? 6_000,
    maxTotalChars: options?.maxTotalChars ?? 80_000,
    ...options,
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

async function readUris(
  uris: vscode.Uri[],
  wsRoot: string,
  maxCharsPerFile: number,
  maxTotalChars: number
): Promise<FileContent[]> {
  const results: FileContent[] = [];
  let totalChars = 0;

  for (const uri of uris) {
    if (totalChars >= maxTotalChars) {
      logger.info("fileReader", `Reached total char cap (${maxTotalChars}), stopping`);
      break;
    }

    const relPath = vscode.workspace.asRelativePath(uri);

    // Skip binary files
    if (isBinaryPath(relPath)) { continue; }

    // Self-protection: skip the extension's own source files
    if (isExtensionOwnFile(relPath, wsRoot)) { continue; }

    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const fullContent = Buffer.from(raw).toString("utf-8");

      // Skip files that look binary (contain null bytes)
      if (fullContent.includes("\0")) { continue; }

      const sizeChars = fullContent.length;
      const remaining = maxTotalChars - totalChars;
      const effectiveMax = Math.min(maxCharsPerFile, remaining);

      const content = sizeChars > effectiveMax
        ? fullContent.slice(0, effectiveMax) + `\n// … [truncated — ${sizeChars} chars total]`
        : fullContent;

      results.push({
        path: relPath,
        content,
        language: langFromPath(relPath),
        sizeChars,
      });

      totalChars += content.length;
    } catch {
      // File unreadable — skip silently (may have been deleted between findFiles and read)
    }
  }

  logger.info("fileReader", `Read ${results.length} file(s), ${totalChars} total chars`);
  return results;
}

// ── LLM formatting ──────────────────────────────────────────────────

/**
 * Format file contents for injection into an LLM prompt.
 * Produces a fenced-code-block per file with the path as a heading.
 */
export function formatFilesForLLM(files: FileContent[], header?: string): string {
  if (files.length === 0) { return ""; }

  const parts: string[] = [];
  if (header) {
    parts.push(`\n## ${header}\n`);
  }

  for (const f of files) {
    parts.push(`### \`${f.path}\`\n\`\`\`${f.language}\n${f.content}\n\`\`\``);
  }

  parts.push(`\n_(${files.length} file(s) shown)_`);
  return parts.join("\n\n");
}

/**
 * Build glob patterns from domain file patterns.
 * Domain patterns like "src/api/**" need to become "src/api/**\/*"
 * for VS Code's findFiles to match actual files.
 */
export function domainPatternsToGlobs(filePatterns: string[]): string[] {
  return filePatterns.map(p => {
    // If pattern already ends with a file extension or wildcard, use as-is
    if (p.includes("*.*") || /\.\w+$/.test(p)) { return p; }
    // If pattern ends with /**, add /* to match files
    if (p.endsWith("/**")) { return p + "/*"; }
    // If pattern ends with /, add **/*
    if (p.endsWith("/")) { return p + "**/*"; }
    // If pattern has ** anywhere, use as-is
    if (p.includes("**")) { return p; }
    // Otherwise assume it's a directory, add /**/*
    return p + "/**/*";
  });
}
