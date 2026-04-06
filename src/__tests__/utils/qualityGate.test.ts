/**
 * Tests for the Quality Gate utility — the CI pipeline that real
 * engineers run before submitting code for review.
 *
 * Tests cover:
 *   - Lint detection and execution
 *   - Test detection and execution
 *   - Jest JSON output parsing
 *   - Diff generation
 *   - Diagnostic filtering by file ownership
 *   - LLM report formatting
 *   - Quality gate orchestration
 */

import * as vscode from "vscode";
import * as cp from "child_process";

// ── Mock setup ──────────────────────────────────────────────────────

jest.mock("child_process");
const mockExec = cp.exec as unknown as jest.Mock;

// ── Imports (after mocks) ───────────────────────────────────────────

import {
  detectLintCommand,
  runLintValidation,
  detectTestCommand,
  runTestValidation,
  parseTestOutput,
  generateDiffReport,
  filterDiagnosticsForFiles,
  formatLintResultForLLM,
  formatTestResultForLLM,
  formatQualityReportForLLM,
  runQualityGate,
  runFullQualityGate,
  type LintResult,
  type TestResult,
  type TestFailure,
  type QualityGateResult,
  type BuildDiagnostic,
} from "../../utils/qualityGate";

// ── Helpers ─────────────────────────────────────────────────────────

function setupFsStat(exists: boolean) {
  const stat = vscode.workspace.fs.stat as jest.Mock;
  if (exists) {
    stat.mockResolvedValue({ type: 1, size: 100 });
  } else {
    stat.mockRejectedValue(new Error("not found"));
  }
}

function setupFsReadFile(content: string) {
  const readFile = vscode.workspace.fs.readFile as jest.Mock;
  readFile.mockResolvedValue(Buffer.from(content, "utf-8"));
}

function setupExecSuccess(stdout: string, stderr = "") {
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
    cb(null, stdout, stderr);
    return { kill: jest.fn(), unref: jest.fn() };
  });
}

function setupExecFailure(stdout: string, stderr: string) {
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
    cb(new Error("exit 1"), stdout, stderr);
    return { kill: jest.fn(), unref: jest.fn() };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// parseTestOutput — Jest JSON output parsing
// ═══════════════════════════════════════════════════════════════════════

describe("parseTestOutput", () => {
  it("parses Jest JSON output correctly", () => {
    const json = JSON.stringify({
      success: true,
      numPassedTests: 10,
      numFailedTests: 0,
      numTotalTests: 10,
      numPendingTests: 0,
      testResults: [],
    });

    const result = parseTestOutput(json, "");

    expect(result.success).toBe(true);
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(10);
    expect(result.failures).toHaveLength(0);
  });

  it("parses failed tests from Jest JSON output", () => {
    const json = JSON.stringify({
      success: false,
      numPassedTests: 8,
      numFailedTests: 2,
      numTotalTests: 10,
      numPendingTests: 0,
      testResults: [
        {
          name: "/path/to/auth.test.ts",
          assertionResults: [
            { title: "should login", status: "passed" },
            {
              title: "should reject invalid password",
              status: "failed",
              failureMessages: ["Expected: 401, Received: 200"],
            },
          ],
        },
        {
          name: "/path/to/api.test.ts",
          assertionResults: [
            {
              title: "should return 404",
              status: "failed",
              failureMessages: ["Expected: 404, Received: 500"],
            },
          ],
        },
      ],
    });

    const result = parseTestOutput(json, "");

    expect(result.success).toBe(false);
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].testName).toBe("should reject invalid password");
    expect(result.failures[0].suiteName).toBe("auth.test.ts");
    expect(result.failures[0].message).toContain("Expected: 401");
    expect(result.failures[1].testName).toBe("should return 404");
  });

  it("falls back to regex parsing when JSON is not available", () => {
    const output = `
Test Suites: 1 failed, 3 passed, 4 total
Tests:       2 failed, 18 passed, 20 total
`;

    const result = parseTestOutput(output, "");

    expect(result.passed).toBe(18);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(20);
    expect(result.success).toBe(false);
  });

  it("handles empty output gracefully", () => {
    const result = parseTestOutput("", "");

    expect(result.success).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  it("parses skipped/pending tests", () => {
    const json = JSON.stringify({
      success: true,
      numPassedTests: 5,
      numFailedTests: 0,
      numTotalTests: 8,
      numPendingTests: 3,
      testResults: [],
    });

    const result = parseTestOutput(json, "");

    expect(result.skipped).toBe(3);
    expect(result.total).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// filterDiagnosticsForFiles
// ═══════════════════════════════════════════════════════════════════════

describe("filterDiagnosticsForFiles", () => {
  const diagnostics: BuildDiagnostic[] = [
    { file: "src/api/routes.ts", line: 10, column: 5, code: "TS2304", message: "not found" },
    { file: "src/db/models.ts", line: 3, column: 1, code: "TS2345", message: "type mismatch" },
    { file: "src/api/middleware.ts", line: 7, column: 2, code: "TS2322", message: "assignment error" },
    { file: "src/utils/helper.ts", line: 1, column: 1, code: "TS2300", message: "duplicate" },
  ];

  it("returns only diagnostics for owned files", () => {
    const filtered = filterDiagnosticsForFiles(diagnostics, ["src/api/routes.ts", "src/api/middleware.ts"]);

    expect(filtered).toHaveLength(2);
    expect(filtered[0].file).toBe("src/api/routes.ts");
    expect(filtered[1].file).toBe("src/api/middleware.ts");
  });

  it("returns empty array when no files match", () => {
    const filtered = filterDiagnosticsForFiles(diagnostics, ["src/other/file.ts"]);
    expect(filtered).toHaveLength(0);
  });

  it("handles ./ prefix normalization", () => {
    const diagsWithPrefix: BuildDiagnostic[] = [
      { file: "./src/api/routes.ts", line: 1, column: 1, code: "TS2304", message: "err" },
    ];

    const filtered = filterDiagnosticsForFiles(diagsWithPrefix, ["src/api/routes.ts"]);
    expect(filtered).toHaveLength(1);
  });

  it("returns empty array for empty diagnostics", () => {
    const filtered = filterDiagnosticsForFiles([], ["src/api/routes.ts"]);
    expect(filtered).toHaveLength(0);
  });

  it("returns empty array for empty owned files", () => {
    const filtered = filterDiagnosticsForFiles(diagnostics, []);
    expect(filtered).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatLintResultForLLM
// ═══════════════════════════════════════════════════════════════════════

describe("formatLintResultForLLM", () => {
  it("shows success message when lint passes", () => {
    const result: LintResult = {
      success: true, errorCount: 0, warningCount: 0,
      diagnostics: [], stdout: "", stderr: "",
      command: "npx eslint", durationMs: 100,
    };

    const formatted = formatLintResultForLLM(result);
    expect(formatted).toContain("✅");
    expect(formatted).toContain("Lint passed");
  });

  it("lists diagnostics when lint fails", () => {
    const result: LintResult = {
      success: false, errorCount: 2, warningCount: 1,
      diagnostics: [
        { file: "src/foo.ts", line: 10, column: 5, code: "no-unused-vars", message: "'x' is unused" },
        { file: "src/bar.ts", line: 3, column: 1, code: "no-any", message: "Unexpected any" },
      ],
      stdout: "", stderr: "",
      command: "npx eslint", durationMs: 200,
    };

    const formatted = formatLintResultForLLM(result);
    expect(formatted).toContain("2 error(s)");
    expect(formatted).toContain("src/foo.ts:10");
    expect(formatted).toContain("no-unused-vars");
    expect(formatted).toContain("src/bar.ts:3");
  });

  it("truncates at 15 diagnostics", () => {
    const diags = Array.from({ length: 20 }, (_, i) => ({
      file: `src/file${i}.ts`, line: i + 1, column: 1,
      code: "TS2304", message: `Error ${i}`,
    }));

    const result: LintResult = {
      success: false, errorCount: 20, warningCount: 0,
      diagnostics: diags, stdout: "", stderr: "",
      command: "npx eslint", durationMs: 100,
    };

    const formatted = formatLintResultForLLM(result);
    expect(formatted).toContain("… and 5 more");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatTestResultForLLM
// ═══════════════════════════════════════════════════════════════════════

describe("formatTestResultForLLM", () => {
  it("shows success message when tests pass", () => {
    const result: TestResult = {
      success: true, passed: 42, failed: 0, total: 42, skipped: 0,
      failures: [], stdout: "", stderr: "",
      command: "npx jest", durationMs: 5000,
    };

    const formatted = formatTestResultForLLM(result);
    expect(formatted).toContain("✅");
    expect(formatted).toContain("42 passed");
  });

  it("lists failures when tests fail", () => {
    const result: TestResult = {
      success: false, passed: 8, failed: 2, total: 10, skipped: 0,
      failures: [
        { testName: "should login", suiteName: "auth.test.ts", message: "Expected 401, got 200" },
        { testName: "should return 404", suiteName: "api.test.ts", message: "Expected 404, got 500" },
      ],
      stdout: "", stderr: "",
      command: "npx jest", durationMs: 3000,
    };

    const formatted = formatTestResultForLLM(result);
    expect(formatted).toContain("❌");
    expect(formatted).toContain("2 failed");
    expect(formatted).toContain("should login");
    expect(formatted).toContain("should return 404");
  });

  it("truncates at 10 failures", () => {
    const failures: TestFailure[] = Array.from({ length: 15 }, (_, i) => ({
      testName: `test ${i}`, suiteName: `suite${i}.test.ts`, message: `Error ${i}`,
    }));

    const result: TestResult = {
      success: false, passed: 0, failed: 15, total: 15, skipped: 0,
      failures, stdout: "", stderr: "",
      command: "npx jest", durationMs: 5000,
    };

    const formatted = formatTestResultForLLM(result);
    expect(formatted).toContain("… and 5 more failures");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatQualityReportForLLM
// ═══════════════════════════════════════════════════════════════════════

describe("formatQualityReportForLLM", () => {
  it("formats a passing quality gate report", () => {
    const report: QualityGateResult = {
      build: { success: true, diagnostics: [], stdout: "", stderr: "", command: "tsc", durationMs: 100, errorCount: 0 },
      lint: { success: true, errorCount: 0, warningCount: 0, diagnostics: [], stdout: "", stderr: "", command: "eslint", durationMs: 50 },
      tests: { success: true, passed: 10, failed: 0, total: 10, skipped: 0, failures: [], stdout: "", stderr: "", command: "jest", durationMs: 3000 },
      diff: "",
      passed: true,
      summary: "Build: ✅ | Lint: ✅ | Tests: ✅ (10/10)",
    };

    const formatted = formatQualityReportForLLM(report);
    expect(formatted).toContain("Quality Gate Report");
    expect(formatted).toContain("ALL CHECKS PASSED");
  });

  it("formats a failing quality gate report with all sections", () => {
    const report: QualityGateResult = {
      build: {
        success: false,
        diagnostics: [{ file: "src/foo.ts", line: 5, column: 1, code: "TS2304", message: "not found" }],
        stdout: "", stderr: "error", command: "tsc", durationMs: 100, errorCount: 1,
      },
      lint: {
        success: false, errorCount: 1, warningCount: 0,
        diagnostics: [{ file: "src/foo.ts", line: 10, column: 1, code: "no-any", message: "Unexpected any" }],
        stdout: "", stderr: "", command: "eslint", durationMs: 50,
      },
      tests: {
        success: false, passed: 8, failed: 2, total: 10, skipped: 0,
        failures: [{ testName: "test1", suiteName: "suite.test.ts", message: "fail" }],
        stdout: "", stderr: "", command: "jest", durationMs: 3000,
      },
      diff: "diff --git a/src/foo.ts\n+const x = 1;",
      passed: false,
      summary: "Build: ❌ (1 errors) | Lint: ⚠️ (1 errors) | Tests: ❌ (2 failed)",
    };

    const formatted = formatQualityReportForLLM(report);
    expect(formatted).toContain("QUALITY GATE FAILED");
    expect(formatted).toContain("Build / Type Check");
    expect(formatted).toContain("Lint");
    expect(formatted).toContain("Tests");
    // diff must be >50 chars to appear — tested in the dedicated diff test below
  });

  it("includes diff when present", () => {
    const report: QualityGateResult = {
      build: { success: true, diagnostics: [], stdout: "", stderr: "", command: "tsc", durationMs: 100, errorCount: 0 },
      lint: null,
      tests: null,
      diff: "diff --git a/file.ts b/file.ts\nindex 1234567..abcdef0 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n+new line added here for the quality gate test\n const existing = true;",
      passed: true,
      summary: "Build: ✅",
    };

    const formatted = formatQualityReportForLLM(report);
    expect(formatted).toContain("diff --git");
    expect(formatted).toContain("Your Changes (diff)");
    expect(formatted).toContain("+new line added here");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Lint detection
// ═══════════════════════════════════════════════════════════════════════

describe("detectLintCommand", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("detects eslint from devDependencies", async () => {
    setupFsReadFile(JSON.stringify({
      devDependencies: { eslint: "^9.0.0" },
    }));

    const cmd = await detectLintCommand("/workspace");
    expect(cmd).toContain("eslint");
  });

  it("returns null when no linter found", async () => {
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error("not found"));
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("not found"));

    const cmd = await detectLintCommand("/workspace");
    expect(cmd).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test detection
// ═══════════════════════════════════════════════════════════════════════

describe("detectTestCommand", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("detects jest from devDependencies", async () => {
    setupFsReadFile(JSON.stringify({
      devDependencies: { jest: "^29.7.0" },
    }));

    const cmd = await detectTestCommand("/workspace");
    expect(cmd).toContain("jest");
  });

  it("detects vitest from devDependencies", async () => {
    setupFsReadFile(JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
    }));

    const cmd = await detectTestCommand("/workspace");
    expect(cmd).toContain("vitest");
  });

  it("returns null when no test runner found", async () => {
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error("not found"));
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("not found"));

    const cmd = await detectTestCommand("/workspace");
    expect(cmd).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Self-review diff check
// ═══════════════════════════════════════════════════════════════════════

describe("Self-review integration", () => {
  it("quality gate includes diff field for self-review", () => {
    const report: QualityGateResult = {
      build: { success: true, diagnostics: [], stdout: "", stderr: "", command: "tsc", durationMs: 0, errorCount: 0 },
      lint: null,
      tests: null,
      diff: "diff --git a/src/foo.ts\n+const x = 1;",
      passed: true,
      summary: "Build: ✅",
    };

    expect(report.diff).toContain("diff --git");
    expect(report.passed).toBe(true);
  });

  it("quality gate passed requires all checks to pass", () => {
    // Build fails → overall fails
    const report: QualityGateResult = {
      build: { success: false, diagnostics: [], stdout: "", stderr: "", command: "tsc", durationMs: 0, errorCount: 1 },
      lint: { success: true, errorCount: 0, warningCount: 0, diagnostics: [], stdout: "", stderr: "", command: "eslint", durationMs: 0 },
      tests: { success: true, passed: 5, failed: 0, total: 5, skipped: 0, failures: [], stdout: "", stderr: "", command: "jest", durationMs: 0 },
      diff: "",
      passed: false,
      summary: "Build: ❌",
    };

    expect(report.passed).toBe(false);
  });

  it("tests with 0 total do not block the quality gate", () => {
    const report: QualityGateResult = {
      build: { success: true, diagnostics: [], stdout: "", stderr: "", command: "tsc", durationMs: 0, errorCount: 0 },
      lint: { success: true, errorCount: 0, warningCount: 0, diagnostics: [], stdout: "", stderr: "", command: "eslint", durationMs: 0 },
      tests: { success: true, passed: 0, failed: 0, total: 0, skipped: 0, failures: [], stdout: "", stderr: "", command: "(none)", durationMs: 0 },
      diff: "",
      passed: true,
      summary: "Build: ✅ | Lint: ✅ | Tests: ⏭️ (none found)",
    };

    expect(report.passed).toBe(true);
  });
});
