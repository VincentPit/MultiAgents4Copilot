/**
 * Diff Viewer — shows before/after diffs using VS Code's built-in diff editor.
 *
 * Instead of streaming raw code into the chat panel, the coder/integrator
 * agents apply files to disk and then open a diff view so the user sees
 * exactly what changed — like how Copilot and Claude show inline edits.
 *
 * For new files, opens the file directly (no diff needed).
 * For modified files, opens a diff between the old content and new content.
 */

import * as vscode from "vscode";
import { logger } from "./logger";

/** In-memory content provider for the "before" side of diffs. */
const SCHEME = "agent-diff";
let _contentProvider: vscode.Disposable | null = null;
const _contentStore: Map<string, string> = new Map();

/** Maximum entries in the in-memory content store to prevent memory leaks. */
export const MAX_DIFF_STORE_SIZE = 50;

/**
 * Register the in-memory content provider.
 * Must be called once at activation (or lazily on first diff).
 */
export function registerDiffProvider(context: vscode.ExtensionContext): void {
  if (_contentProvider) { return; }

  _contentProvider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return _contentStore.get(uri.path) ?? "";
    },
  });

  context.subscriptions.push(_contentProvider);
}

/**
 * Ensure the diff content provider is registered.
 * Safe to call multiple times — only registers once.
 */
function ensureProvider(): void {
  if (_contentProvider) { return; }
  // Lazy registration without context — will work but won't auto-dispose
  _contentProvider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return _contentStore.get(uri.path) ?? "";
    },
  });
}

/**
 * Show a diff for a modified file.
 *
 * @param relPath  — relative path from workspace root (e.g. "src/api/routes.ts")
 * @param oldContent — the content BEFORE the agent's changes
 * @param newUri — URI to the new file on disk (already written)
 */
export async function showFileDiff(
  relPath: string,
  oldContent: string,
  newUri: vscode.Uri,
): Promise<void> {
  try {
    ensureProvider();

    // Store old content in the in-memory provider
    const key = `/${relPath}`;
    // Evict oldest entries if store exceeds cap
    if (_contentStore.size >= MAX_DIFF_STORE_SIZE) {
      const oldest = _contentStore.keys().next().value;
      if (oldest !== undefined) { _contentStore.delete(oldest); }
    }
    _contentStore.set(key, oldContent);
    const oldUri = vscode.Uri.parse(`${SCHEME}:${key}`);

    // Open VS Code's built-in diff editor
    const title = `${relPath} (Agent Changes)`;
    await vscode.commands.executeCommand("vscode.diff", oldUri, newUri, title, {
      preview: true,
      preserveFocus: true,
    });

    logger.info("diffViewer", `Opened diff for ${relPath}`);
  } catch (err: any) {
    logger.warn("diffViewer", `Could not open diff for ${relPath}: ${err.message}`);
  }
}

/**
 * Show a newly created file (no diff — just open it).
 */
export async function showNewFile(fileUri: vscode.Uri): Promise<void> {
  try {
    await vscode.window.showTextDocument(fileUri, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    logger.info("diffViewer", `Opened new file: ${fileUri.fsPath}`);
  } catch (err: any) {
    logger.warn("diffViewer", `Could not open new file: ${err.message}`);
  }
}

/**
 * Show diffs for a batch of written files.
 *
 * Opens at most `maxDiffs` diff views to avoid overwhelming the editor.
 * For files that already existed, shows a before/after diff.
 * For new files, opens the file directly.
 *
 * @param writtenFiles — relative paths of files written by the agent
 * @param oldContents — map of relative path → old content (before agent changes)
 * @param maxDiffs — max number of diff tabs to open (default 5)
 */
export async function showBatchDiffs(
  writtenFiles: string[],
  oldContents: Map<string, string>,
  maxDiffs: number = 5,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot || writtenFiles.length === 0) { return; }

  let opened = 0;
  for (const relPath of writtenFiles) {
    if (opened >= maxDiffs) {
      logger.info("diffViewer", `Reached maxDiffs (${maxDiffs}), skipping remaining ${writtenFiles.length - opened} files`);
      break;
    }

    const fileUri = vscode.Uri.joinPath(workspaceRoot, relPath);
    const oldContent = oldContents.get(relPath);

    if (oldContent !== undefined) {
      // File existed before — show diff
      await showFileDiff(relPath, oldContent, fileUri);
    } else {
      // New file — just open it
      await showNewFile(fileUri);
    }
    opened++;
  }

  logger.info("diffViewer", `Showed ${opened} diff(s) for ${writtenFiles.length} file(s)`);
}

/**
 * Clean up stale entries from the in-memory content store.
 * Call after each graph run to prevent memory leaks.
 */
export function clearDiffStore(): void {
  _contentStore.clear();
}
