/**
 * Workspace context utility — gathers information about the user's
 * open workspace, active files, and project structure so agents
 * can "see" the codebase they're working on.
 */

import * as vscode from "vscode";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

export interface WorkspaceSnapshot {
  /** Root folder paths of the workspace. */
  roots: string[];
  /** The currently active editor's file path + content. */
  activeFile: { path: string; content: string; language: string } | null;
  /** Files currently open in editor tabs. */
  openFiles: { path: string; language: string }[];
  /** A tree listing of the workspace (top 2 levels). */
  fileTree: string;
  /** package.json / pyproject.toml / pom.xml contents (project metadata). */
  projectMeta: { path: string; content: string }[] ;
}

// ── Gather workspace context ─────────────────────────────────────────

const PROJECT_FILES = [
  "package.json", "tsconfig.json", "pyproject.toml", "requirements.txt",
  "Cargo.toml", "pom.xml", "build.gradle", "go.mod", "Gemfile",
  "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
];

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
  "out", ".next", ".nuxt", "target", "coverage", ".turbo", ".cache",
]);

/**
 * Take a snapshot of the user's current workspace for agent context.
 * This is intentionally lightweight — it reads only what's needed
 * and caps content sizes to avoid blowing the model's context.
 */
export async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  // Active file
  let activeFile: WorkspaceSnapshot["activeFile"] = null;
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const content = doc.getText();
    activeFile = {
      path: vscode.workspace.asRelativePath(doc.uri),
      content: truncate(content, 3000),
      language: doc.languageId,
    };
  }

  // Open editor tabs
  const openFiles: WorkspaceSnapshot["openFiles"] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input && typeof (tab.input as any).uri?.fsPath === "string") {
        const uri = (tab.input as any).uri as vscode.Uri;
        openFiles.push({
          path: vscode.workspace.asRelativePath(uri),
          language: languageFromPath(uri.fsPath),
        });
      }
    }
  }

  // File tree (top 2 levels)
  let fileTree = "";
  if (roots.length > 0) {
    try {
      fileTree = await buildFileTree(vscode.Uri.file(roots[0]), 2);
    } catch (err: any) {
      logger.warn("workspace", `File tree scan failed: ${err.message}`);
    }
  }

  // Project metadata files
  const projectMeta: WorkspaceSnapshot["projectMeta"] = [];
  for (const name of PROJECT_FILES) {
    const files = await vscode.workspace.findFiles(name, "**/node_modules/**", 1);
    if (files.length > 0) {
      try {
        const doc = await vscode.workspace.openTextDocument(files[0]);
        projectMeta.push({
          path: vscode.workspace.asRelativePath(files[0]),
          content: truncate(doc.getText(), 1500),
        });
      } catch { /* skip unreadable */ }
    }
  }

  logger.info("workspace", `Snapshot: ${roots.length} roots, ${openFiles.length} open files, active=${activeFile?.path ?? "none"}`);
  return { roots, activeFile, openFiles, fileTree, projectMeta };
}

// ── File tree builder ────────────────────────────────────────────────

async function buildFileTree(root: vscode.Uri, maxDepth: number, indent: string = "", depth: number = 0): Promise<string> {
  if (depth >= maxDepth) { return ""; }

  const entries = await vscode.workspace.fs.readDirectory(root);
  // Sort: folders first, then files
  entries.sort((a, b) => {
    if (a[1] !== b[1]) { return b[1] - a[1]; } // folders first
    return a[0].localeCompare(b[0]);
  });

  const lines: string[] = [];
  let fileCount = 0;
  const MAX_ENTRIES = 40; // cap to prevent huge trees

  for (const [name, type] of entries) {
    if (fileCount >= MAX_ENTRIES) {
      lines.push(`${indent}  … and more`);
      break;
    }

    if (type === vscode.FileType.Directory) {
      if (IGNORED_DIRS.has(name) || name.startsWith(".")) { continue; }
      lines.push(`${indent}📁 ${name}/`);
      const subTree = await buildFileTree(
        vscode.Uri.joinPath(root, name), maxDepth, indent + "  ", depth + 1
      );
      if (subTree) { lines.push(subTree); }
    } else {
      lines.push(`${indent}📄 ${name}`);
    }
    fileCount++;
  }

  return lines.join("\n");
}

// ── Format snapshot as LLM context ───────────────────────────────────

/**
 * Convert a workspace snapshot into a text block suitable for
 * injection into an agent's system prompt.
 */
export function formatSnapshotForLLM(snapshot: WorkspaceSnapshot): string {
  const parts: string[] = [];

  parts.push("## User's Workspace Context");

  if (snapshot.roots.length > 0) {
    parts.push(`\n**Workspace root:** ${snapshot.roots[0]}`);
  }

  if (snapshot.fileTree) {
    // Cap file tree to 1000 chars
    const tree = snapshot.fileTree.length > 1000
      ? snapshot.fileTree.slice(0, 1000) + "\n  … (truncated)"
      : snapshot.fileTree;
    parts.push(`\n### Project Structure\n\`\`\`\n${tree}\n\`\`\``);
  }

  // Only include the first project metadata file (usually package.json)
  if (snapshot.projectMeta.length > 0) {
    const meta = snapshot.projectMeta[0];
    const content = meta.content.length > 800
      ? meta.content.slice(0, 800) + "\n… (truncated)"
      : meta.content;
    parts.push(`\n### ${meta.path}\n\`\`\`\n${content}\n\`\`\``);
  }

  if (snapshot.openFiles.length > 0) {
    const list = snapshot.openFiles.slice(0, 8).map(f => `- ${f.path} (${f.language})`).join("\n");
    parts.push(`\n### Open files\n${list}`);
  }

  if (snapshot.activeFile) {
    // Cap active file content to keep total small
    const content = snapshot.activeFile.content.length > 1500
      ? snapshot.activeFile.content.slice(0, 1500) + "\n// … (truncated)"
      : snapshot.activeFile.content;
    parts.push(
      `\n### Active file: ${snapshot.activeFile.path} (${snapshot.activeFile.language})\n` +
      `\`\`\`${snapshot.activeFile.language}\n${content}\n\`\`\``
    );
  }

  // Hard-cap total output to 4000 chars (~1000 tokens)
  const result = parts.join("\n");
  if (result.length > 4000) {
    return result.slice(0, 4000) + "\n[… workspace context truncated]";
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) { return text; }
  return text.slice(0, maxChars) + `\n\n… [truncated — ${text.length - maxChars} chars omitted]`;
}

function languageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp", cpp: "cpp",
    c: "c", rb: "ruby", swift: "swift", kt: "kotlin", html: "html", css: "css",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown", toml: "toml",
    sql: "sql", sh: "shellscript", bash: "shellscript", dockerfile: "dockerfile",
  };
  return map[ext] ?? ext;
}
