/**
 * Integration tests for src/utils/fileWriter.ts — writeFileBlocks & applyCodeToWorkspace.
 *
 * Verifies that:
 *   1. LLM output with code blocks is parsed AND written to the workspace
 *   2. User consent is requested before any writes
 *   3. Declining consent skips all writes
 *   4. Path traversal attempts are blocked
 *   5. New vs existing files are tracked correctly
 */

import * as vscode from "vscode";
import {
  applyCodeToWorkspace,
  writeFileBlocks,
  parseFileBlocks,
  type ParsedFileBlock,
} from "../../utils/fileWriter";

// Shorthand for the mocked functions
const mockWriteFile = vscode.workspace.fs.writeFile as jest.Mock;
const mockStat = vscode.workspace.fs.stat as jest.Mock;
const mockShowWarning = vscode.window.showWarningMessage as jest.Mock;

/** Helper: create a mock ChatResponseStream */
function mockStream() {
  return {
    markdown: jest.fn(),
    progress: jest.fn(),
    reference: jest.fn(),
    button: jest.fn(),
    anchor: jest.fn(),
  } as unknown as vscode.ChatResponseStream;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: user consents, files are new (stat rejects)
  mockShowWarning.mockResolvedValue("Apply Changes");
  mockStat.mockRejectedValue(new Error("not found"));
  mockWriteFile.mockResolvedValue(undefined);
});

// ── applyCodeToWorkspace (end-to-end: parse → consent → write) ──────

describe("applyCodeToWorkspace", () => {
  it("parses code blocks from LLM output and writes them to workspace", async () => {
    const llmOutput = [
      "Here's the file:",
      "",
      "### `src/hello.ts`",
      "```typescript",
      "export function hello() { return 'world'; }",
      "```",
    ].join("\n");

    const stream = mockStream();
    const result = await applyCodeToWorkspace(llmOutput, stream);

    // Should have written 1 file
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toBe("src/hello.ts");

    // writeFile should have been called with the correct URI and content
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [uri, content] = mockWriteFile.mock.calls[0];
    expect(uri.fsPath).toContain("src/hello.ts");
    // Content should be a Buffer of the code
    expect(Buffer.from(content).toString()).toContain("export function hello");
  });

  it("writes multiple files from a single LLM response", async () => {
    const llmOutput = [
      "### `src/a.ts`",
      "```typescript",
      "export const A = 1;",
      "```",
      "",
      "### `src/b.ts`",
      "```typescript",
      "export const B = 2;",
      "```",
      "",
      "### `src/c.ts`",
      "```typescript",
      "export const C = 3;",
      "```",
    ].join("\n");

    const stream = mockStream();
    const result = await applyCodeToWorkspace(llmOutput, stream);

    expect(result.written).toHaveLength(3);
    expect(result.written).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(mockWriteFile).toHaveBeenCalledTimes(3);
  });

  it("returns empty result when LLM output has no file blocks", async () => {
    const llmOutput = "Sure, here's a simple explanation of closures…";
    const stream = mockStream();
    const result = await applyCodeToWorkspace(llmOutput, stream);

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it("streams confirmation markdown for each written file", async () => {
    const llmOutput = [
      "### `src/index.ts`",
      "```typescript",
      "console.log('init');",
      "```",
    ].join("\n");

    const stream = mockStream();
    await applyCodeToWorkspace(llmOutput, stream);

    // Stream should have received markdown with "Created" confirmation
    const allCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasCreated = allCalls.some((msg: string) => msg.includes("Created") && msg.includes("src/index.ts"));
    expect(hasCreated).toBe(true);
  });
});

// ── User consent ────────────────────────────────────────────────────

describe("applyCodeToWorkspace — user consent", () => {
  it("asks for user consent before writing", async () => {
    const llmOutput = [
      "### `src/file.ts`",
      "```typescript",
      "const x = 1;",
      "```",
    ].join("\n");

    const stream = mockStream();
    await applyCodeToWorkspace(llmOutput, stream);

    // showWarningMessage should have been called for consent
    expect(mockShowWarning).toHaveBeenCalledTimes(1);
    const [msg] = mockShowWarning.mock.calls[0];
    expect(msg).toContain("write");
  });

  it("skips all writes when user declines consent", async () => {
    mockShowWarning.mockResolvedValue("Cancel");

    const llmOutput = [
      "### `src/a.ts`",
      "```typescript",
      "export const A = 1;",
      "```",
      "",
      "### `src/b.ts`",
      "```typescript",
      "export const B = 2;",
      "```",
    ].join("\n");

    const stream = mockStream();
    const result = await applyCodeToWorkspace(llmOutput, stream);

    // No files should have been written
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("declined");
    expect(mockWriteFile).not.toHaveBeenCalled();

    // Stream should indicate changes were declined
    const allCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasDeclined = allCalls.some((msg: string) => msg.includes("declined"));
    expect(hasDeclined).toBe(true);
  });

  it("skips all writes when user dismisses the dialog (undefined)", async () => {
    mockShowWarning.mockResolvedValue(undefined);

    const llmOutput = [
      "### `src/file.ts`",
      "```typescript",
      "const x = 1;",
      "```",
    ].join("\n");

    const stream = mockStream();
    const result = await applyCodeToWorkspace(llmOutput, stream);

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ── Safety: path traversal ──────────────────────────────────────────

describe("writeFileBlocks — safety", () => {
  it("rejects file paths containing '..'", async () => {
    const blocks: ParsedFileBlock[] = [
      { filePath: "../../../etc/passwd", content: "hacked", language: "text" },
    ];

    const stream = mockStream();
    const result = await writeFileBlocks(blocks, stream);

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("..");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("allows normal nested paths", async () => {
    const blocks: ParsedFileBlock[] = [
      { filePath: "src/deeply/nested/file.ts", content: "ok", language: "typescript" },
    ];

    const stream = mockStream();
    const result = await writeFileBlocks(blocks, stream);

    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toBe("src/deeply/nested/file.ts");
  });
});

// ── Existing vs new files ───────────────────────────────────────────

describe("writeFileBlocks — new vs existing files", () => {
  it("reports 'Created' for new files", async () => {
    mockStat.mockRejectedValue(new Error("not found"));

    const blocks: ParsedFileBlock[] = [
      { filePath: "src/new-file.ts", content: "new content", language: "typescript" },
    ];

    const stream = mockStream();
    await writeFileBlocks(blocks, stream);

    const allCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasCreated = allCalls.some((msg: string) => msg.includes("Created"));
    expect(hasCreated).toBe(true);
  });

  it("reports 'Updated' for existing files", async () => {
    // stat succeeds → file exists
    mockStat.mockResolvedValue({ type: 1, size: 100 });

    const blocks: ParsedFileBlock[] = [
      { filePath: "src/existing.ts", content: "updated content", language: "typescript" },
    ];

    const stream = mockStream();
    await writeFileBlocks(blocks, stream);

    const allCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasUpdated = allCalls.some((msg: string) => msg.includes("Updated"));
    expect(hasUpdated).toBe(true);
  });
});

// ── No workspace folder ─────────────────────────────────────────────

describe("writeFileBlocks — no workspace", () => {
  it("returns empty result when no workspace folder is open", async () => {
    const original = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = undefined;

    const blocks: ParsedFileBlock[] = [
      { filePath: "src/file.ts", content: "content", language: "typescript" },
    ];

    const stream = mockStream();
    const result = await writeFileBlocks(blocks, stream);

    expect(result.written).toHaveLength(0);
    expect(mockWriteFile).not.toHaveBeenCalled();

    // Restore
    (vscode.workspace as any).workspaceFolders = original;
  });
});
