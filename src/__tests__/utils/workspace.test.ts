/**
 * Tests for src/utils/workspace.ts — formatSnapshotForLLM and snapshot helpers.
 */

import { formatSnapshotForLLM, type WorkspaceSnapshot } from "../../utils/workspace";

// ── Helpers ──────────────────────────────────────────────────────────

function emptySnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    roots: [],
    activeFile: null,
    openFiles: [],
    fileTree: "",
    projectMeta: [],
    ...overrides,
  };
}

// ── formatSnapshotForLLM ─────────────────────────────────────────────

describe("formatSnapshotForLLM", () => {
  it("returns a header even for an empty snapshot", () => {
    const result = formatSnapshotForLLM(emptySnapshot());
    expect(result).toContain("## User's Workspace Context");
  });

  it("includes workspace root when provided", () => {
    const result = formatSnapshotForLLM(emptySnapshot({ roots: ["/home/user/project"] }));
    expect(result).toContain("**Workspace root:** /home/user/project");
  });

  it("includes file tree section", () => {
    const result = formatSnapshotForLLM(emptySnapshot({
      fileTree: "📁 src/\n  📄 index.ts",
    }));
    expect(result).toContain("### Project Structure");
    expect(result).toContain("📁 src/");
  });

  it("includes project metadata files", () => {
    const result = formatSnapshotForLLM(emptySnapshot({
      projectMeta: [{ path: "package.json", content: '{"name": "test"}' }],
    }));
    expect(result).toContain("### package.json");
    expect(result).toContain('"name": "test"');
  });

  it("includes open files list", () => {
    const result = formatSnapshotForLLM(emptySnapshot({
      openFiles: [
        { path: "src/a.ts", language: "typescript" },
        { path: "src/b.py", language: "python" },
      ],
    }));
    expect(result).toContain("### Open files");
    expect(result).toContain("- src/a.ts (typescript)");
    expect(result).toContain("- src/b.py (python)");
  });

  it("includes active file content", () => {
    const result = formatSnapshotForLLM(emptySnapshot({
      activeFile: {
        path: "src/main.ts",
        content: "console.log('hello');",
        language: "typescript",
      },
    }));
    expect(result).toContain("### Active file: src/main.ts (typescript)");
    expect(result).toContain("console.log('hello');");
  });

  it("caps open files at 15 entries", () => {
    const openFiles = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file${i}.ts`,
      language: "typescript",
    }));
    const result = formatSnapshotForLLM(emptySnapshot({ openFiles }));
    // Should include file14 but not file15
    expect(result).toContain("src/file14.ts");
    expect(result).not.toContain("src/file15.ts");
  });

  it("truncates total output to maxChars", () => {
    const bigContent = "x".repeat(50_000);
    const result = formatSnapshotForLLM(
      emptySnapshot({
        activeFile: { path: "big.ts", content: bigContent, language: "typescript" },
        fileTree: "y".repeat(50_000),
        roots: ["/root"],
        projectMeta: [{ path: "package.json", content: "z".repeat(50_000) }],
      }),
      500,
    );
    expect(result.length).toBeLessThanOrEqual(600); // small margin for suffix
    expect(result).toContain("[… workspace context truncated]");
  });

  it("truncates file tree when it exceeds 10% of maxChars", () => {
    const bigTree = "📄 file.ts\n".repeat(2000);
    const result = formatSnapshotForLLM(emptySnapshot({ fileTree: bigTree }), 10_000);
    expect(result).toContain("… (truncated)");
  });

  it("truncates active file content at 40% of maxChars", () => {
    const content = "a".repeat(20_000);
    const result = formatSnapshotForLLM(
      emptySnapshot({
        activeFile: { path: "a.ts", content, language: "typescript" },
      }),
      20_000,
    );
    // Active file should be capped to ~40% of 20_000 = 8_000 or 15_000 (min)
    // The result should contain the truncation comment
    expect(result).toContain("// … (truncated)");
  });
});
