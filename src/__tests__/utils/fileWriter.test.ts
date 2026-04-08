/**
 * Tests for src/utils/fileWriter.ts — code-block parser.
 */

import { parseFileBlocks, MAX_FILE_BLOCKS, type ParsedFileBlock } from "../../utils/fileWriter";

describe("parseFileBlocks", () => {
  it("returns empty array when there are no code blocks", () => {
    expect(parseFileBlocks("Just some plain text.")).toEqual([]);
  });

  it("returns empty array when code blocks have no identifiable file path", () => {
    const input = "```typescript\nconsole.log('hello');\n```";
    expect(parseFileBlocks(input)).toEqual([]);
  });

  // ── Heading-based path detection ──────────────────────────────────

  it("parses a block preceded by ### `path`", () => {
    const input = [
      "### `src/utils/helper.ts`",
      "```typescript",
      "export function hello() { return 'hi'; }",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/utils/helper.ts");
    expect(blocks[0].language).toBe("typescript");
    expect(blocks[0].content).toContain("export function hello");
  });

  it("parses a block preceded by ### path (no backticks)", () => {
    const input = [
      "### src/index.ts",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/index.ts");
  });

  it("parses a block preceded by **path**", () => {
    const input = [
      "**src/app.py**",
      "```python",
      "print('hello')",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/app.py");
    expect(blocks[0].language).toBe("python");
  });

  it("parses a block preceded by File: path", () => {
    const input = [
      "File: src/main.rs",
      "```rust",
      "fn main() {}",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/main.rs");
  });

  // ── Annotation-based path detection (```ts:src/foo.ts) ────────────

  it("parses a code fence with lang:path annotation", () => {
    const input = [
      "```typescript:src/models/user.ts",
      "export interface User { name: string; }",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/models/user.ts");
    expect(blocks[0].language).toBe("typescript");
  });

  // ── Multiple blocks ───────────────────────────────────────────────

  it("parses multiple file blocks from one output", () => {
    const input = [
      "Here are the files:",
      "",
      "### `src/a.ts`",
      "```typescript",
      "export const A = 1;",
      "```",
      "",
      "And the second file:",
      "",
      "### `src/b.ts`",
      "```typescript",
      "export const B = 2;",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].filePath).toBe("src/a.ts");
    expect(blocks[1].filePath).toBe("src/b.ts");
  });

  // ── Path normalization ────────────────────────────────────────────

  it("strips leading ./ from paths", () => {
    const input = [
      "### `./src/foo.ts`",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/foo.ts");
  });

  it("strips leading / from paths", () => {
    const input = [
      "### `/src/foo.ts`",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe("src/foo.ts");
  });

  // ── Language guessing ─────────────────────────────────────────────

  it("guesses language from file extension when fence has no tag", () => {
    const input = [
      "### `src/style.css`",
      "```",
      "body { color: red; }",
      "```",
    ].join("\n");

    const blocks = parseFileBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe("css");
  });
});

// ── writeFileBlocks security tests ──────────────────────────────────

import { writeFileBlocks, type WriteResult } from "../../utils/fileWriter";
import * as vscode from "vscode";

describe("writeFileBlocks — security hardening", () => {
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
    // Consent approved by default
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue("Apply Changes");
  });

  it("rejects files with blocked extensions (.exe)", async () => {
    const stream = mockStream();
    const blocks = [{ filePath: "malware.exe", content: "MZ...", language: "binary" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("blocked extension");
  });

  it("rejects files with blocked extensions (.dll)", async () => {
    const stream = mockStream();
    const blocks = [{ filePath: "hack.dll", content: "data", language: "binary" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.skipped[0].reason).toContain("blocked extension");
  });

  it("rejects files with blocked extensions (.so)", async () => {
    const stream = mockStream();
    const blocks = [{ filePath: "lib.so", content: "data", language: "binary" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.skipped[0].reason).toContain("blocked extension");
  });

  it("rejects files that exceed max size", async () => {
    const stream = mockStream();
    const hugeContent = "x".repeat(6 * 1024 * 1024); // 6 MB
    const blocks = [{ filePath: "huge.ts", content: hugeContent, language: "typescript" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("too large");
  });

  it("rejects path traversal attempts (..)", async () => {
    const stream = mockStream();
    const blocks = [{ filePath: "../../../etc/passwd", content: "data", language: "text" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("..");
  });

  it("allows safe file extensions (.ts, .py, .json)", async () => {
    const stream = mockStream();
    const blocks = [
      { filePath: "src/app.ts", content: "const x = 1;", language: "typescript" },
    ];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toBe("src/app.ts");
  });

  it("skips all files when user declines consent", async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue("Cancel");
    const stream = mockStream();
    const blocks = [{ filePath: "src/app.ts", content: "const x = 1;", language: "typescript" }];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("declined");
  });

  it("handles mixed safe and unsafe blocks", async () => {
    const stream = mockStream();
    const blocks = [
      { filePath: "src/app.ts", content: "const x = 1;", language: "typescript" },
      { filePath: "evil.exe", content: "binary", language: "binary" },
      { filePath: "../escape.txt", content: "escape", language: "text" },
      { filePath: "src/utils.ts", content: "export {};", language: "typescript" },
    ];

    const result = await writeFileBlocks(blocks, stream);
    expect(result.written).toHaveLength(2); // app.ts and utils.ts
    expect(result.skipped).toHaveLength(2); // evil.exe and ../escape.txt
  });
});

// ── MAX_FILE_BLOCKS constant ─────────────────────────────────────────

describe("MAX_FILE_BLOCKS", () => {
  it("is exported as a positive number", () => {
    expect(MAX_FILE_BLOCKS).toBeGreaterThan(0);
    expect(typeof MAX_FILE_BLOCKS).toBe("number");
  });

  it("equals 30", () => {
    expect(MAX_FILE_BLOCKS).toBe(30);
  });
});

describe("parseFileBlocks cap", () => {
  it("caps output at MAX_FILE_BLOCKS entries", () => {
    // Build an LLM output with more blocks than the cap
    const lines: string[] = [];
    for (let i = 0; i < MAX_FILE_BLOCKS + 10; i++) {
      lines.push(
        `### \`src/file${i}.ts\``,
        "```typescript",
        `export const x${i} = ${i};`,
        "```",
        "",
      );
    }
    const blocks = parseFileBlocks(lines.join("\n"));
    expect(blocks.length).toBeLessThanOrEqual(MAX_FILE_BLOCKS);
  });
});
