/**
 * Tests for src/utils/fileWriter.ts — code-block parser.
 */

import { parseFileBlocks, type ParsedFileBlock } from "../../utils/fileWriter";

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
