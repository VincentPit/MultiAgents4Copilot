/**
 * Self-modification protection — prevents the multi-agent copilot from
 * modifying its own source files.
 *
 * ## The Problem
 * When the user opens the extension's own workspace as a project, agents
 * can see the extension's source files in workspace context. The LLM may
 * then "helpfully" rewrite these files, causing corruption, truncation,
 * and broken builds.
 *
 * ## The Solution
 * 1. **Extension root tracking**: At activation, store the extension's own
 *    root directory (from `context.extensionUri`).
 * 2. **File write guard**: Before any file write, check if the target path
 *    falls inside the extension's source tree. Hard-block if yes.
 * 3. **Workspace context filter**: Strip the extension's own files from
 *    the workspace tree so agents don't even "see" them.
 * 4. **Pattern-based detection**: Even without the extensionUri, detect
 *    writes to known extension source paths by package name matching.
 */

import * as path from "path";
import { logger } from "./logger";

// ── Extension identity ──────────────────────────────────────────────

/** Absolute path to the extension's own root directory (set at activation). */
let _extensionRootPath: string | null = null;

/** The extension's own package name (for pattern-based detection). */
const EXTENSION_PACKAGE_NAME = "multi-agent-copilot";

/**
 * Known directory patterns that indicate extension source files.
 * Used as a fallback even if the extension root path isn't set.
 */
const SELF_SOURCE_PATTERNS: RegExp[] = [
  // Direct extension source paths
  /^src\/agents\//,
  /^src\/graph\//,
  /^src\/security\//,
  /^src\/utils\//,
  /^src\/go-worker\//,
  /^src\/types\//,
  /^src\/__mocks__\//,
  /^src\/__tests__\//,
  /^src\/extension\.ts$/,
  /^out\//,
];

/**
 * Files that should never be written by agents (extension config/meta files).
 */
const PROTECTED_ROOT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "jest.config.js",
  ".vscodeignore",
  ".eslintrc.json",
  "webpack.config.js",
  "esbuild.js",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Register the extension's own root path. Call this once from `activate()`.
 * This enables precise self-modification detection.
 */
export function registerExtensionRoot(extensionRootPath: string): void {
  _extensionRootPath = path.resolve(extensionRootPath);
  logger.info("selfProtection", `Extension root registered: ${_extensionRootPath}`);
}

/**
 * Get the registered extension root path (for testing/debugging).
 */
export function getExtensionRootPath(): string | null {
  return _extensionRootPath;
}

/**
 * Check if a file path targets the extension's own source files.
 *
 * @param targetPath - Absolute or relative file path to check.
 * @param workspaceRoot - Absolute path to the workspace root.
 * @returns `true` if the file is part of the extension's own source tree.
 */
export function isExtensionOwnFile(targetPath: string, workspaceRoot: string): boolean {
  // Normalise to absolute
  const absTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath);

  // 1. If the extension root is registered and the target is inside it,
  //    check whether it's a known source path (not just any file).
  if (_extensionRootPath) {
    const normalizedRoot = _extensionRootPath + path.sep;
    if (absTarget.startsWith(normalizedRoot) || absTarget === _extensionRootPath) {
      const relFromExtRoot = path.relative(_extensionRootPath, absTarget);
      if (isSelfSourcePath(relFromExtRoot)) {
        return true;
      }
    }
  }

  // 2. Check if the workspace IS the extension's own directory
  //    (i.e., the user opened the extension folder as their workspace)
  if (isWorkspaceTheExtension(workspaceRoot)) {
    // In this case, check if the relative path matches known extension source
    const relPath = path.relative(workspaceRoot, absTarget);
    if (isSelfSourcePath(relPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the current workspace root IS the extension's own directory.
 * Uses multiple signals: extensionUri match, package.json name, known file patterns.
 */
export function isWorkspaceTheExtension(workspaceRoot: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);

  // 1. Direct match with registered extension root
  if (_extensionRootPath && resolvedRoot === _extensionRootPath) {
    return true;
  }

  // 2. Check if the workspace root's directory name matches
  //    (this catches common cases like /Users/foo/Desktop/MultiAgentCopilt)
  const dirName = path.basename(resolvedRoot).toLowerCase();
  if (dirName === "multiagentcopilt" || dirName === "multi-agent-copilot" || dirName === "multiagents4copilot") {
    return true;
  }

  return false;
}

/**
 * Check if a relative path matches known extension source patterns.
 */
function isSelfSourcePath(relPath: string): boolean {
  // Normalise separators to forward slashes for pattern matching
  const normalised = relPath.replace(/\\/g, "/");

  // Check against protected root files
  if (PROTECTED_ROOT_FILES.has(normalised)) {
    return true;
  }

  // Check against source directory patterns
  return SELF_SOURCE_PATTERNS.some(pattern => pattern.test(normalised));
}

/**
 * Known directory names that are part of the extension's source tree.
 * Used for file tree filtering where we only see individual names, not full paths.
 */
const SELF_DIR_NAMES = new Set([
  "agents", "graph", "security", "utils", "types",
  "__mocks__", "__tests__", "out", "go-worker",
]);

/**
 * Known file names at the extension source root level.
 */
const SELF_FILE_NAMES = new Set([
  "extension.ts",
]);

/**
 * Filter file tree lines to remove the extension's own source files.
 * Returns a cleaned tree that agents can safely see.
 *
 * @param fileTree - The raw file tree string.
 * @param workspaceRoot - Absolute path to the workspace root.
 * @returns Filtered file tree (or original if workspace isn't the extension).
 */
export function filterSelfFromFileTree(fileTree: string, workspaceRoot: string): string {
  if (!isWorkspaceTheExtension(workspaceRoot)) {
    return fileTree; // Not our extension — no filtering needed
  }

  // Filter out lines that reference extension source directories or files
  const lines = fileTree.split("\n");
  const filtered = lines.filter(line => {
    // Strip tree drawing chars, emojis, and indentation to extract the bare name
    const trimmed = line.replace(/^[\s│├└─]+/, "")    // tree drawing + indent
                        .replace(/^📁\s*/, "")         // folder emoji
                        .replace(/^📄\s*/, "")         // file emoji
                        .replace(/\/$/, "")             // trailing slash
                        .trim();
    if (!trimmed) { return true; } // keep blank/structural lines
    // Block known extension directory names and file names
    if (SELF_DIR_NAMES.has(trimmed)) { return false; }
    if (SELF_FILE_NAMES.has(trimmed)) { return false; }
    if (PROTECTED_ROOT_FILES.has(trimmed)) { return false; }
    return true;
  });

  // If we filtered everything, return a note
  if (filtered.every(l => !l.trim())) {
    return "[Extension source files hidden from agents for safety]";
  }

  return filtered.join("\n");
}

/**
 * Get a human-readable reason why a file write was blocked.
 */
export function selfProtectionBlockReason(targetPath: string): string {
  return `BLOCKED: "${targetPath}" is part of the Multi-Agent Copilot extension's own source code. ` +
    `Agents must never modify the extension that is running them. ` +
    `This protection exists because previous self-modifications caused file corruption.`;
}
