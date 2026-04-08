/**
 * Tests for src/utils/diffViewer.ts — diff store management and batch diffs.
 */

import * as vscode from "vscode";
import {
  MAX_DIFF_STORE_SIZE,
  clearDiffStore,
  showFileDiff,
  showNewFile,
  showBatchDiffs,
} from "../../utils/diffViewer";

// ── MAX_DIFF_STORE_SIZE export ────────────────────────────────────────

describe("MAX_DIFF_STORE_SIZE", () => {
  it("is exported and is a positive number", () => {
    expect(MAX_DIFF_STORE_SIZE).toBeGreaterThan(0);
    expect(typeof MAX_DIFF_STORE_SIZE).toBe("number");
  });

  it("equals 50", () => {
    expect(MAX_DIFF_STORE_SIZE).toBe(50);
  });
});

// ── clearDiffStore ────────────────────────────────────────────────────

describe("clearDiffStore", () => {
  it("is exported as a function", () => {
    expect(typeof clearDiffStore).toBe("function");
  });

  it("does not throw when called on an empty store", () => {
    expect(() => clearDiffStore()).not.toThrow();
  });
});

// ── showFileDiff ──────────────────────────────────────────────────────

describe("showFileDiff", () => {
  beforeEach(() => {
    (vscode.commands.executeCommand as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it("opens a diff via vscode.commands.executeCommand", async () => {
    await showFileDiff(
      "src/app.ts",
      "old content",
      vscode.Uri.file("/workspace/src/app.ts") as any,
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "src/app.ts (Agent Changes)",
      expect.objectContaining({ preview: true }),
    );
  });

  it("does not throw when executeCommand rejects", async () => {
    (vscode.commands.executeCommand as jest.Mock).mockRejectedValueOnce(new Error("tab limit reached"));

    await expect(
      showFileDiff("f.ts", "x", vscode.Uri.file("/f.ts") as any)
    ).resolves.toBeUndefined();
  });
});

// ── showNewFile ───────────────────────────────────────────────────────

describe("showNewFile", () => {
  beforeEach(() => {
    (vscode.window.showTextDocument as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it("opens the file in a side column", async () => {
    await showNewFile(vscode.Uri.file("/workspace/new.ts") as any);

    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preview: true,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Beside,
      }),
    );
  });

  it("does not throw when showTextDocument rejects", async () => {
    (vscode.window.showTextDocument as jest.Mock).mockRejectedValueOnce(new Error("no editor"));

    await expect(
      showNewFile(vscode.Uri.file("/x.ts") as any)
    ).resolves.toBeUndefined();
  });
});

// ── showBatchDiffs ────────────────────────────────────────────────────

describe("showBatchDiffs", () => {
  beforeEach(() => {
    (vscode.commands.executeCommand as jest.Mock).mockReset().mockResolvedValue(undefined);
    (vscode.window.showTextDocument as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it("returns early for empty file list", async () => {
    (vscode.commands.executeCommand as jest.Mock).mockClear();

    await showBatchDiffs([], new Map());

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.diff", expect.anything(), expect.anything(), expect.anything(), expect.anything()
    );
  });

  it("respects maxDiffs limit", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    const oldContents = new Map<string, string>();

    await showBatchDiffs(files, oldContents, 3);

    // showTextDocument should only have been called 3 times (new files)
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(3);
  });

  it("opens diffs for modified files and new files for new ones", async () => {
    const files = ["existing.ts", "new.ts"];
    const oldContents = new Map([["existing.ts", "old code"]]);

    await showBatchDiffs(files, oldContents, 5);

    // Should have opened a diff for existing.ts
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      "existing.ts (Agent Changes)",
      expect.anything(),
    );
    // Should have opened new.ts directly
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });
});
