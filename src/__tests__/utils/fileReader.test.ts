/**
 * Tests for src/utils/fileReader.ts — glob helpers and LLM formatting.
 */

import { domainPatternsToGlobs, formatFilesForLLM, type FileContent } from "../../utils/fileReader";

// ── domainPatternsToGlobs ─────────────────────────────────────────────

describe("domainPatternsToGlobs", () => {
  it("appends /* to patterns ending with /**", () => {
    expect(domainPatternsToGlobs(["src/api/**"])).toEqual(["src/api/**/*"]);
  });

  it("appends **/* to patterns ending with /", () => {
    expect(domainPatternsToGlobs(["src/api/"])).toEqual(["src/api/**/*"]);
  });

  it("leaves patterns with file extensions unchanged", () => {
    expect(domainPatternsToGlobs(["src/config.ts"])).toEqual(["src/config.ts"]);
  });

  it("leaves patterns with *.* unchanged", () => {
    expect(domainPatternsToGlobs(["src/**/*.*"])).toEqual(["src/**/*.*"]);
  });

  it("leaves patterns with ** in the middle unchanged", () => {
    expect(domainPatternsToGlobs(["src/**/utils"])).toEqual(["src/**/utils"]);
  });

  it("appends /**/* to bare directory names", () => {
    expect(domainPatternsToGlobs(["src/api"])).toEqual(["src/api/**/*"]);
  });

  it("handles multiple patterns", () => {
    const input = ["src/api/**", "src/utils/", "src/index.ts"];
    const result = domainPatternsToGlobs(input);
    expect(result).toEqual(["src/api/**/*", "src/utils/**/*", "src/index.ts"]);
  });

  it("handles empty array", () => {
    expect(domainPatternsToGlobs([])).toEqual([]);
  });
});

// ── formatFilesForLLM ─────────────────────────────────────────────────

describe("formatFilesForLLM", () => {
  const sampleFiles: FileContent[] = [
    { path: "src/app.ts", content: "const x = 1;", language: "typescript", sizeChars: 12 },
    { path: "src/utils.ts", content: "export {};", language: "typescript", sizeChars: 10 },
  ];

  it("returns empty string for empty file array", () => {
    expect(formatFilesForLLM([])).toBe("");
  });

  it("includes file paths as headings", () => {
    const result = formatFilesForLLM(sampleFiles);
    expect(result).toContain("`src/app.ts`");
    expect(result).toContain("`src/utils.ts`");
  });

  it("wraps content in language-tagged fenced code blocks", () => {
    const result = formatFilesForLLM(sampleFiles);
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
  });

  it("includes a file count footer", () => {
    const result = formatFilesForLLM(sampleFiles);
    expect(result).toContain("2 file(s) shown");
  });

  it("includes a header when provided", () => {
    const result = formatFilesForLLM(sampleFiles, "Existing source");
    expect(result).toContain("## Existing source");
  });

  it("omits header section when not provided", () => {
    const result = formatFilesForLLM(sampleFiles);
    // Should not contain a top-level ## header (### for files is fine)
    expect(result).not.toMatch(/^## /m);
  });

  it("handles a single file", () => {
    const result = formatFilesForLLM([sampleFiles[0]]);
    expect(result).toContain("1 file(s) shown");
    expect(result).toContain("`src/app.ts`");
  });
});
