/**
 * Tests for src/utils/buildValidator.ts — build validation, diagnostic parsing,
 * error formatting for LLM consumption, and per-file error filtering.
 *
 * These tests cover the critical "error feedback loop" pipeline:
 *   build output → parseDiagnostics → formatBuildErrorsForLLM → agent retry
 */

import {
  parseDiagnostics,
  formatBuildErrorsForLLM,
  filterErrorsForFiles,
  type BuildDiagnostic,
  type BuildResult,
} from "../../utils/buildValidator";

// ── Helper: create a BuildResult ─────────────────────────────────────

function makeBuildResult(
  overrides: Partial<BuildResult> = {},
): BuildResult {
  return {
    success: false,
    diagnostics: [],
    stdout: "",
    stderr: "",
    command: "npx tsc --noEmit",
    durationMs: 123,
    errorCount: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// parseDiagnostics
// ═══════════════════════════════════════════════════════════════════════

describe("parseDiagnostics", () => {
  // ── TypeScript errors ────────────────────────────────────────────

  it("parses TypeScript errors with parenthesised location: file(line,col)", () => {
    const output = `src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual<BuildDiagnostic>({
      file: "src/foo.ts",
      line: 10,
      column: 5,
      code: "TS2345",
      message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    });
  });

  it("parses TypeScript errors with colon location: file:line:col", () => {
    const output = `src/bar.ts:42:12 - error TS1005: ';' expected.`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("src/bar.ts");
    expect(diags[0].line).toBe(42);
    expect(diags[0].column).toBe(12);
    expect(diags[0].code).toBe("TS1005");
    expect(diags[0].message).toBe("';' expected.");
  });

  it("parses multiple TypeScript errors", () => {
    const output = [
      `src/a.ts(1,1): error TS2304: Cannot find name 'foo'.`,
      `src/a.ts(3,10): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `src/b.ts(7,5): error TS7006: Parameter 'x' implicitly has an 'any' type.`,
    ].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(3);
    expect(diags[0].file).toBe("src/a.ts");
    expect(diags[1].file).toBe("src/a.ts");
    expect(diags[2].file).toBe("src/b.ts");
    expect(diags[0].code).toBe("TS2304");
    expect(diags[1].code).toBe("TS2322");
    expect(diags[2].code).toBe("TS7006");
  });

  it("handles mixed TS error formats in one output", () => {
    const output = [
      `src/types.ts(2,3): error TS2339: Property 'bar' does not exist on type 'Foo'.`,
      `src/utils.ts:15:8 - error TS2551: Property 'lenght' does not exist on type 'string'. Did you mean 'length'?`,
    ].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(2);
    expect(diags[0].file).toBe("src/types.ts");
    expect(diags[0].line).toBe(2);
    expect(diags[1].file).toBe("src/utils.ts");
    expect(diags[1].line).toBe(15);
  });

  // ── ESLint errors ────────────────────────────────────────────────

  it("parses ESLint errors with rule names", () => {
    const output = `src/index.ts  5:10  error  'x' is assigned a value but never used  no-unused-vars`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("src/index.ts");
    expect(diags[0].line).toBe(5);
    expect(diags[0].column).toBe(10);
    expect(diags[0].code).toBe("no-unused-vars");
    expect(diags[0].message).toBe("'x' is assigned a value but never used");
  });

  it("parses ESLint errors without rule names", () => {
    const output = `src/app.ts  12:3  error  Unexpected token`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("src/app.ts");
    expect(diags[0].line).toBe(12);
    expect(diags[0].column).toBe(3);
    expect(diags[0].code).toBe("lint");
    expect(diags[0].message).toBe("Unexpected token");
  });

  // ── Generic compiler errors ──────────────────────────────────────

  it("parses generic file:line:col: error format (gcc-style)", () => {
    const output = `main.c:10:3: error: expected ';' after expression`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("main.c");
    expect(diags[0].line).toBe(10);
    expect(diags[0].column).toBe(3);
    expect(diags[0].code).toBe("E0");
    expect(diags[0].message).toBe("expected ';' after expression");
  });

  it("parses generic errors with 'Error' capitalisation", () => {
    const output = `src/lib.rs:5:1: Error[E0277]: the trait bound is not satisfied`;
    const diags = parseDiagnostics(output);

    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe("src/lib.rs");
    expect(diags[0].line).toBe(5);
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it("returns empty array for empty input", () => {
    expect(parseDiagnostics("")).toEqual([]);
  });

  it("returns empty array when output has no errors", () => {
    const output = [
      "Compiling project...",
      "Build succeeded.",
      "0 errors, 0 warnings",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([]);
  });

  it("skips non-error lines mixed with real errors", () => {
    const output = [
      "Starting compilation...",
      "Processing src/foo.ts...",
      `src/foo.ts(5,3): error TS2304: Cannot find name 'bar'.`,
      "Watching for changes...",
      "1 error found.",
    ].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("TS2304");
  });

  it("deduplicates identical diagnostics", () => {
    const sameLine = `src/x.ts(1,1): error TS2304: Cannot find name 'z'.`;
    const output = [sameLine, sameLine, sameLine].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(1);
  });

  it("does NOT deduplicate diagnostics at different locations", () => {
    const output = [
      `src/x.ts(1,1): error TS2304: Cannot find name 'z'.`,
      `src/x.ts(2,1): error TS2304: Cannot find name 'z'.`,
    ].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(2);
  });

  it("handles lines with only whitespace", () => {
    const output = "\n   \n\t\n";
    expect(parseDiagnostics(output)).toEqual([]);
  });

  it("handles Windows-style paths in errors", () => {
    const output = `src\\models\\user.ts(3,7): error TS2345: Argument of type 'string' is not assignable.`;
    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toContain("user.ts");
  });

  // ── Mixed format output ──────────────────────────────────────────

  it("parses mixed TypeScript + generic errors", () => {
    const output = [
      `src/main.ts(1,10): error TS2305: Module '"./lib"' has no exported member 'foo'.`,
      `lib/helper.c:20:5: error: undeclared variable 'x'`,
    ].join("\n");

    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(2);
    expect(diags[0].code).toBe("TS2305");
    expect(diags[1].code).toBe("E0");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatBuildErrorsForLLM
// ═══════════════════════════════════════════════════════════════════════

describe("formatBuildErrorsForLLM", () => {
  it("returns success message when build passed", () => {
    const result = makeBuildResult({ success: true, diagnostics: [], errorCount: 0 });
    const formatted = formatBuildErrorsForLLM(result);

    expect(formatted).toContain("Build passed");
    expect(formatted).toContain("✅");
    expect(formatted).not.toContain("❌");
  });

  it("formats a single error", () => {
    const diag: BuildDiagnostic = {
      file: "src/foo.ts",
      line: 10,
      column: 5,
      code: "TS2345",
      message: "Type mismatch",
    };
    const result = makeBuildResult({
      diagnostics: [diag],
      errorCount: 1,
    });

    const formatted = formatBuildErrorsForLLM(result);
    expect(formatted).toContain("❌");
    expect(formatted).toContain("1 error(s)");
    expect(formatted).toContain("src/foo.ts");
    expect(formatted).toContain("Line 10");
    expect(formatted).toContain("TS2345");
    expect(formatted).toContain("Type mismatch");
  });

  it("groups errors by file", () => {
    const diags: BuildDiagnostic[] = [
      { file: "src/a.ts", line: 1, column: 1, code: "TS1", message: "err1" },
      { file: "src/a.ts", line: 5, column: 1, code: "TS2", message: "err2" },
      { file: "src/b.ts", line: 2, column: 1, code: "TS3", message: "err3" },
    ];
    const result = makeBuildResult({ diagnostics: diags, errorCount: 3 });
    const formatted = formatBuildErrorsForLLM(result);

    // Should have both file headings
    expect(formatted).toContain("src/a.ts");
    expect(formatted).toContain("src/b.ts");
    expect(formatted).toContain("3 error(s)");
  });

  it("caps errors at 10 per file", () => {
    const diags: BuildDiagnostic[] = Array.from({ length: 15 }, (_, i) => ({
      file: "src/big.ts",
      line: i + 1,
      column: 1,
      code: `TS${i}`,
      message: `error ${i}`,
    }));
    const result = makeBuildResult({ diagnostics: diags, errorCount: 15 });
    const formatted = formatBuildErrorsForLLM(result);

    // Should mention truncation
    expect(formatted).toContain("5 more errors");
    // Should still show the total count
    expect(formatted).toContain("15 error(s)");
  });

  it("includes raw stderr when no diagnostics were parsed", () => {
    const result = makeBuildResult({
      diagnostics: [],
      errorCount: 0,
      stderr: "Some unparseable build error occurred\nAt unknown location",
    });
    const formatted = formatBuildErrorsForLLM(result);

    expect(formatted).toContain("Raw build output");
    expect(formatted).toContain("Some unparseable build error occurred");
  });

  it("does NOT include raw stderr when diagnostics exist", () => {
    const result = makeBuildResult({
      diagnostics: [{ file: "x.ts", line: 1, column: 1, code: "TS1", message: "err" }],
      errorCount: 1,
      stderr: "Some noise",
    });
    const formatted = formatBuildErrorsForLLM(result);

    expect(formatted).not.toContain("Raw build output");
    expect(formatted).not.toContain("Some noise");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// filterErrorsForFiles
// ═══════════════════════════════════════════════════════════════════════

describe("filterErrorsForFiles", () => {
  const allDiags: BuildDiagnostic[] = [
    { file: "src/api/routes.ts", line: 10, column: 5, code: "TS2304", message: "Cannot find name" },
    { file: "src/api/middleware.ts", line: 3, column: 1, code: "TS2345", message: "Type mismatch" },
    { file: "src/db/models.ts", line: 7, column: 2, code: "TS7006", message: "Implicit any" },
    { file: "src/ui/App.tsx", line: 15, column: 8, code: "TS2322", message: "Type error" },
  ];

  const failedResult = makeBuildResult({
    success: false,
    diagnostics: allDiags,
    errorCount: 4,
  });

  it("returns only errors for owned files", () => {
    const filtered = filterErrorsForFiles(failedResult, [
      "src/api/routes.ts",
      "src/api/middleware.ts",
    ]);

    expect(filtered).toHaveLength(2);
    expect(filtered[0].file).toBe("src/api/routes.ts");
    expect(filtered[1].file).toBe("src/api/middleware.ts");
  });

  it("returns empty when no owned files have errors", () => {
    const filtered = filterErrorsForFiles(failedResult, [
      "src/config/env.ts",
      "src/utils/helpers.ts",
    ]);

    expect(filtered).toHaveLength(0);
  });

  it("returns empty for a successful build", () => {
    const successResult = makeBuildResult({ success: true, diagnostics: [], errorCount: 0 });
    const filtered = filterErrorsForFiles(successResult, ["src/api/routes.ts"]);
    expect(filtered).toHaveLength(0);
  });

  it("handles ./prefix normalisation", () => {
    const diagsWithPrefix: BuildDiagnostic[] = [
      { file: "./src/api/routes.ts", line: 10, column: 5, code: "TS1", message: "err" },
    ];
    const result = makeBuildResult({
      success: false,
      diagnostics: diagsWithPrefix,
      errorCount: 1,
    });

    // Owned file without prefix should still match
    const filtered = filterErrorsForFiles(result, ["src/api/routes.ts"]);
    expect(filtered).toHaveLength(1);
  });

  it("handles owned files with ./prefix", () => {
    const filtered = filterErrorsForFiles(failedResult, [
      "./src/db/models.ts",
    ]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].file).toBe("src/db/models.ts");
  });

  it("filters correctly with mixed domains", () => {
    // Simulate coderPool: backend domain owns api/, data domain owns db/
    const backendErrors = filterErrorsForFiles(failedResult, [
      "src/api/routes.ts",
      "src/api/middleware.ts",
    ]);
    const dataErrors = filterErrorsForFiles(failedResult, [
      "src/db/models.ts",
    ]);
    const uiErrors = filterErrorsForFiles(failedResult, [
      "src/ui/App.tsx",
    ]);

    expect(backendErrors).toHaveLength(2);
    expect(dataErrors).toHaveLength(1);
    expect(uiErrors).toHaveLength(1);

    // Total should equal all errors
    expect(backendErrors.length + dataErrors.length + uiErrors.length).toBe(allDiags.length);
  });

  it("handles empty ownedFiles list", () => {
    const filtered = filterErrorsForFiles(failedResult, []);
    expect(filtered).toHaveLength(0);
  });

  it("handles empty diagnostics list", () => {
    const result = makeBuildResult({ success: false, diagnostics: [], errorCount: 0 });
    const filtered = filterErrorsForFiles(result, ["src/anything.ts"]);
    expect(filtered).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// detectBuildCommand (async — relies on vscode.workspace.fs)
// ═══════════════════════════════════════════════════════════════════════

describe("detectBuildCommand", () => {
  // We import the actual function; the vscode mock's fs.stat rejects by default.
  const { detectBuildCommand } = require("../../utils/buildValidator");
  const vscode = require("vscode");

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all stat calls reject (file not found)
    vscode.workspace.fs.stat.mockRejectedValue(new Error("not found"));
    vscode.workspace.fs.readFile = jest.fn().mockRejectedValue(new Error("not found"));
  });

  it("returns 'npx tsc --noEmit' when tsconfig.json exists", async () => {
    vscode.workspace.fs.stat.mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("tsconfig.json") || uri.path?.includes("tsconfig.json")) {
        return Promise.resolve({ type: 1 }); // FileType.File
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("npx tsc --noEmit");
  });

  it("returns npm script command when package.json has typecheck script", async () => {
    vscode.workspace.fs.stat.mockRejectedValue(new Error("not found")); // no tsconfig
    vscode.workspace.fs.readFile = jest.fn().mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("package.json") || uri.path?.includes("package.json")) {
        return Promise.resolve(
          Buffer.from(JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))
        );
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("npm run typecheck");
  });

  it("returns npm run lint when package.json has lint script", async () => {
    vscode.workspace.fs.stat.mockRejectedValue(new Error("not found"));
    vscode.workspace.fs.readFile = jest.fn().mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("package.json") || uri.path?.includes("package.json")) {
        return Promise.resolve(
          Buffer.from(JSON.stringify({ scripts: { lint: "eslint ." } }))
        );
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("npm run lint");
  });

  it("returns 'cargo check' when Cargo.toml exists", async () => {
    vscode.workspace.fs.stat.mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("Cargo.toml") || uri.path?.includes("Cargo.toml")) {
        return Promise.resolve({ type: 1 });
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("cargo check");
  });

  it("returns 'go build ./...' when go.mod exists", async () => {
    vscode.workspace.fs.stat.mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("go.mod") || uri.path?.includes("go.mod")) {
        return Promise.resolve({ type: 1 });
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("go build ./...");
  });

  it("returns null when no project files are found", async () => {
    const cmd = await detectBuildCommand("/empty-project");
    expect(cmd).toBeNull();
  });

  it("prefers tsconfig.json over package.json scripts", async () => {
    // Both tsconfig and package.json exist
    vscode.workspace.fs.stat.mockImplementation((uri: any) => {
      const p = uri.fsPath ?? uri.path ?? "";
      if (p.includes("tsconfig.json")) {
        return Promise.resolve({ type: 1 });
      }
      return Promise.reject(new Error("not found"));
    });
    vscode.workspace.fs.readFile = jest.fn().mockImplementation((uri: any) => {
      if (uri.fsPath?.includes("package.json") || uri.path?.includes("package.json")) {
        return Promise.resolve(
          Buffer.from(JSON.stringify({ scripts: { lint: "eslint ." } }))
        );
      }
      return Promise.reject(new Error("not found"));
    });

    const cmd = await detectBuildCommand("/project");
    expect(cmd).toBe("npx tsc --noEmit"); // tsconfig wins
  });
});

// ═══════════════════════════════════════════════════════════════════════
// runBuildValidation (integration-ish, uses child_process)
// ═══════════════════════════════════════════════════════════════════════

describe("runBuildValidation", () => {
  // Use the real import to test the full function signature
  const { runBuildValidation } = require("../../utils/buildValidator");
  const vscode = require("vscode");

  beforeEach(() => {
    // Must use mockReset (not clearAllMocks) to remove implementations
    // that previous tests may have set via mockImplementation
    vscode.workspace.fs.stat.mockReset();
    vscode.workspace.fs.stat.mockRejectedValue(new Error("not found"));
    vscode.workspace.fs.readFile.mockReset();
    vscode.workspace.fs.readFile.mockRejectedValue(new Error("not found"));
  });

  it("returns success with no diagnostics when no build command detected", async () => {
    // No project files → no build command → skip validation
    const result = await runBuildValidation("/nonexistent-project");

    expect(result.success).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.command).toBe("(none)");
    expect(result.errorCount).toBe(0);
  });

  it("returns a BuildResult with correct shape from customCommand", async () => {
    // Use a trivial command that always succeeds
    const result = await runBuildValidation("/tmp", "echo 'ok'");

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("diagnostics");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("command", "echo 'ok'");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("errorCount");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports success for a command that exits 0", async () => {
    const result = await runBuildValidation("/tmp", "true");

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it("reports failure for a command that exits non-zero", async () => {
    const result = await runBuildValidation("/tmp", "false");

    expect(result.success).toBe(false);
  });

  it("parses TypeScript errors from real tsc-like output", async () => {
    // Simulate tsc output via echo
    const fakeOutput = `echo "src/test.ts(5,3): error TS2304: Cannot find name 'foo'."`;
    const result = await runBuildValidation("/tmp", fakeOutput);

    // The command succeeds (echo exits 0), but diagnostics may be parsed from stdout
    expect(result.success).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    if (result.diagnostics.length > 0) {
      expect(result.diagnostics[0].code).toBe("TS2304");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// End-to-end: parseDiagnostics → filterErrorsForFiles pipeline
// ═══════════════════════════════════════════════════════════════════════

describe("Diagnostic pipeline (parse → filter)", () => {
  it("filters parsed diagnostics to a single domain's files", () => {
    const tscOutput = [
      `src/api/routes.ts(10,5): error TS2304: Cannot find name 'Handler'.`,
      `src/api/routes.ts(15,1): error TS2345: Argument of type 'string' is not assignable.`,
      `src/db/models.ts(3,7): error TS7006: Parameter 'x' implicitly has an 'any' type.`,
      `src/ui/App.tsx(20,10): error TS2322: Type 'string' is not assignable to type 'number'.`,
    ].join("\n");

    const diags = parseDiagnostics(tscOutput);
    expect(diags).toHaveLength(4);

    const buildResult = makeBuildResult({
      success: false,
      diagnostics: diags,
      errorCount: diags.length,
    });

    // API domain only sees its own 2 errors
    const apiErrors = filterErrorsForFiles(buildResult, [
      "src/api/routes.ts",
      "src/api/middleware.ts",
    ]);
    expect(apiErrors).toHaveLength(2);
    expect(apiErrors.every(d => d.file.startsWith("src/api/"))).toBe(true);

    // DB domain only sees its 1 error
    const dbErrors = filterErrorsForFiles(buildResult, ["src/db/models.ts"]);
    expect(dbErrors).toHaveLength(1);
    expect(dbErrors[0].code).toBe("TS7006");

    // UI domain only sees its 1 error
    const uiErrors = filterErrorsForFiles(buildResult, ["src/ui/App.tsx"]);
    expect(uiErrors).toHaveLength(1);
    expect(uiErrors[0].code).toBe("TS2322");
  });

  it("correctly handles the format pipeline: parse → format → check content", () => {
    const output = `src/server.ts(22,14): error TS2339: Property 'listen' does not exist on type 'App'.`;
    const diags = parseDiagnostics(output);
    const result = makeBuildResult({
      success: false,
      diagnostics: diags,
      errorCount: 1,
    });

    const formatted = formatBuildErrorsForLLM(result);
    expect(formatted).toContain("src/server.ts");
    expect(formatted).toContain("Line 22");
    expect(formatted).toContain("TS2339");
    expect(formatted).toContain("listen");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Robustness: malformed / edge-case build outputs
// ═══════════════════════════════════════════════════════════════════════

describe("Robustness edge cases", () => {
  it("handles extremely long error output without crashing", () => {
    // 1000 identical error lines
    const errorLine = `src/huge.ts(1,1): error TS9999: Some repeated error.`;
    const output = Array(1000).fill(errorLine).join("\n");
    const diags = parseDiagnostics(output);

    // Deduplicated: all same file:line:col:code → only 1
    expect(diags).toHaveLength(1);
  });

  it("handles unicode in error messages", () => {
    const output = `src/i18n.ts(5,1): error TS2304: Cannot find name '日本語'.`;
    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("日本語");
  });

  it("handles paths with spaces", () => {
    const output = `src/my folder/app.ts(1,1): error TS2304: Cannot find name 'x'.`;
    const diags = parseDiagnostics(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toContain("my folder");
  });

  it("formatBuildErrorsForLLM handles zero diagnostics on failed build", () => {
    const result = makeBuildResult({
      success: false,
      diagnostics: [],
      errorCount: 0,
      stderr: "Compilation failed with unknown error",
    });

    const formatted = formatBuildErrorsForLLM(result);
    expect(formatted).toContain("❌");
    expect(formatted).toContain("Raw build output");
    expect(formatted).toContain("Compilation failed with unknown error");
  });

  it("filterErrorsForFiles is case-sensitive on file paths", () => {
    const diags: BuildDiagnostic[] = [
      { file: "src/App.tsx", line: 1, column: 1, code: "TS1", message: "err" },
    ];
    const result = makeBuildResult({ success: false, diagnostics: diags, errorCount: 1 });

    // Lowercase mismatch
    const filtered = filterErrorsForFiles(result, ["src/app.tsx"]);
    expect(filtered).toHaveLength(0);

    // Exact match
    const filteredExact = filterErrorsForFiles(result, ["src/App.tsx"]);
    expect(filteredExact).toHaveLength(1);
  });
});
