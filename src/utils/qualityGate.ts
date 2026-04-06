/**
 * Quality Gate — the CI pipeline that real engineers run before submitting code.
 *
 * Models the engineering workflow at top-tier tech companies:
 *   1. Build / type-check  (tsc --noEmit)
 *   2. Lint                (eslint)
 *   3. Run relevant tests  (jest --findRelatedTests)
 *   4. Generate diff       (git diff)
 *
 * Two orchestrators:
 *   - runQualityGate()      — scoped checks for individual engineers
 *   - runFullQualityGate()  — full-project checks for staff engineer
 *
 * This is the automated version of what a Meta/Google engineer does
 * before running `arc diff` or pushing to a PR.
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "./logger";
import {
  runBuildValidation,
  formatBuildErrorsForLLM,
  parseDiagnostics,
  type BuildResult,
  type BuildDiagnostic,
} from "./buildValidator";

// ── Types ────────────────────────────────────────────────────────────

export interface TestFailure {
  /** Name of the individual test. */
  testName: string;
  /** Name of the test suite / describe block. */
  suiteName: string;
  /** Failure message (assertion, error, etc.). */
  message: string;
}

export interface TestResult {
  success: boolean;
  passed: number;
  failed: number;
  total: number;
  skipped: number;
  failures: TestFailure[];
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

export interface LintResult {
  success: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: BuildDiagnostic[];
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

export interface QualityGateResult {
  /** Build / type-check results. */
  build: BuildResult;
  /** Lint results (null if no linter detected). */
  lint: LintResult | null;
  /** Test results (null if no test runner detected). */
  tests: TestResult | null;
  /** Git diff of changes (for self-review). */
  diff: string;
  /** Whether ALL checks passed. */
  passed: boolean;
  /** One-line summary, e.g. "Build: ✅ | Lint: ✅ | Tests: ✅ (42/42)" */
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────

/** Timeout for lint and test commands (60s). */
const QG_TIMEOUT_MS = 60_000;

/** Max stdout/stderr capture (100 KB). */
const MAX_OUTPUT_SIZE = 100 * 1024;

// ── Re-exports from buildValidator (so agents only import qualityGate) ──

export { formatBuildErrorsForLLM, type BuildResult, type BuildDiagnostic };

// ── Lint Detection & Execution ───────────────────────────────────────

/**
 * Detect the lint command for the workspace.
 * Checks for eslint in devDependencies, or a "lint" script.
 */
export async function detectLintCommand(workspaceRoot: string): Promise<string | null> {
  const fs = vscode.workspace.fs;
  const root = vscode.Uri.file(workspaceRoot);

  try {
    const pkgUri = vscode.Uri.joinPath(root, "package.json");
    const pkgBytes = await fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString("utf-8"));

    // Prefer direct eslint invocation (allows file targeting)
    if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
      return "npx eslint";
    }
    if (pkg.scripts?.lint) {
      return "npm run lint --silent";
    }
  } catch { /* no package.json or parse error */ }

  // Python project
  try {
    await fs.stat(vscode.Uri.joinPath(root, "pyproject.toml"));
    return "python -m flake8 .";
  } catch { /* no pyproject */ }

  return null;
}

/**
 * Run lint validation, optionally scoped to specific files.
 * Returns structured results with diagnostics.
 */
export async function runLintValidation(
  workspaceRoot: string,
  files?: string[],
): Promise<LintResult> {
  const baseCommand = await detectLintCommand(workspaceRoot);

  if (!baseCommand) {
    return {
      success: true, errorCount: 0, warningCount: 0,
      diagnostics: [], stdout: "", stderr: "",
      command: "(none)", durationMs: 0,
    };
  }

  // Scope to specific files if eslint is available
  let command = baseCommand;
  if (files && files.length > 0 && baseCommand.includes("eslint")) {
    const fileArgs = files.map(f => `"${f}"`).join(" ");
    command = `npx eslint ${fileArgs} --no-error-on-unmatched-pattern`;
  } else if (baseCommand.includes("eslint")) {
    command = `npx eslint src --ext ts,tsx,js,jsx --no-error-on-unmatched-pattern`;
  }

  const start = Date.now();
  logger.info("qualityGate:lint", `Running: ${command}`);

  return new Promise<LintResult>((resolve) => {
    cp.exec(command, {
      cwd: workspaceRoot,
      timeout: QG_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const rawOutput = (stdout ?? "") + "\n" + (stderr ?? "");
      const diagnostics = parseDiagnostics(rawOutput);

      const warningMatch = rawOutput.match(/(\d+)\s+warning/);
      const warningCount = warningMatch ? parseInt(warningMatch[1], 10) : 0;

      const result: LintResult = {
        success: !error,
        errorCount: diagnostics.length,
        warningCount,
        diagnostics,
        stdout: (stdout ?? "").slice(0, 5000),
        stderr: (stderr ?? "").slice(0, 5000),
        command,
        durationMs,
      };

      logger.info("qualityGate:lint",
        `Lint ${result.success ? "PASSED" : "FAILED"}: ` +
        `${result.errorCount} error(s), ${result.warningCount} warning(s) in ${durationMs}ms`
      );

      resolve(result);
    });
  });
}

// ── Test Detection & Execution ───────────────────────────────────────

/**
 * Detect the test command for the workspace.
 * Prefers direct jest invocation for JSON output support.
 */
export async function detectTestCommand(workspaceRoot: string): Promise<string | null> {
  const fs = vscode.workspace.fs;
  const root = vscode.Uri.file(workspaceRoot);

  try {
    const pkgUri = vscode.Uri.joinPath(root, "package.json");
    const pkgBytes = await fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString("utf-8"));

    if (pkg.devDependencies?.jest || pkg.dependencies?.jest) { return "npx jest"; }
    if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) { return "npx vitest run"; }
    if (pkg.scripts?.test) { return "npm test --"; }
  } catch { /* no package.json or parse error */ }

  // Python project
  try {
    await fs.stat(vscode.Uri.joinPath(root, "pyproject.toml"));
    return "python -m pytest";
  } catch { /* no pyproject */ }

  return null;
}

/**
 * Run tests, optionally scoped to files related to the given source files.
 * Uses Jest's --findRelatedTests for precise per-domain testing.
 */
export async function runTestValidation(
  workspaceRoot: string,
  relatedFiles?: string[],
): Promise<TestResult> {
  const baseCommand = await detectTestCommand(workspaceRoot);

  if (!baseCommand) {
    return {
      success: true, passed: 0, failed: 0, total: 0, skipped: 0,
      failures: [], stdout: "", stderr: "",
      command: "(none)", durationMs: 0,
    };
  }

  // Build the test command with appropriate flags
  let command: string;
  if (relatedFiles && relatedFiles.length > 0 && baseCommand.includes("jest")) {
    const absFiles = relatedFiles.map(f =>
      path.isAbsolute(f) ? f : path.join(workspaceRoot, f)
    );
    command = `npx jest --findRelatedTests ${absFiles.join(" ")} --json --no-coverage --forceExit`;
  } else if (baseCommand.includes("jest")) {
    command = `npx jest --json --no-coverage --forceExit`;
  } else {
    command = baseCommand;
  }

  const start = Date.now();
  logger.info("qualityGate:test", `Running: ${command}`);

  return new Promise<TestResult>((resolve) => {
    cp.exec(command, {
      cwd: workspaceRoot,
      timeout: QG_TIMEOUT_MS * 2, // tests can be slow — 2 min
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const parsed = parseTestOutput(stdout ?? "", stderr ?? "");

      const result: TestResult = {
        ...parsed,
        stdout: (stdout ?? "").slice(0, 5000),
        stderr: (stderr ?? "").slice(0, 5000),
        command,
        durationMs,
      };

      logger.info("qualityGate:test",
        `Tests ${result.success ? "PASSED" : "FAILED"}: ` +
        `${result.passed} passed, ${result.failed} failed, ${result.total} total in ${durationMs}ms`
      );

      resolve(result);
    });
  });
}

/**
 * Parse Jest JSON output (--json flag) into structured test results.
 * Falls back to regex parsing of human-readable output.
 */
export function parseTestOutput(
  stdout: string,
  stderr: string,
): Omit<TestResult, "stdout" | "stderr" | "command" | "durationMs"> {
  // Try Jest JSON output first
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
    if (jsonMatch) {
      const json = JSON.parse(jsonMatch[0]);
      const failures: TestFailure[] = [];

      if (Array.isArray(json.testResults)) {
        for (const suite of json.testResults) {
          if (Array.isArray(suite.assertionResults)) {
            for (const test of suite.assertionResults) {
              if (test.status === "failed") {
                failures.push({
                  testName: test.title ?? test.fullName ?? "unknown",
                  suiteName: suite.name ? path.basename(suite.name) : "unknown",
                  message: Array.isArray(test.failureMessages)
                    ? test.failureMessages.join("\n").slice(0, 500)
                    : String(test.failureMessages ?? "").slice(0, 500),
                });
              }
            }
          }
        }
      }

      return {
        success: json.success !== false && (json.numFailedTests ?? 0) === 0,
        passed: json.numPassedTests ?? 0,
        failed: json.numFailedTests ?? 0,
        total: json.numTotalTests ?? 0,
        skipped: json.numPendingTests ?? 0,
        failures,
      };
    }
  } catch { /* JSON parse failed — fall through to regex */ }

  // Fallback: regex on human-readable Jest output
  const combined = stdout + "\n" + stderr;
  const passMatch = combined.match(/Tests:\s+(?:\d+ failed,\s+)?(\d+)\s+passed/);
  const failMatch = combined.match(/Tests:\s+(\d+)\s+failed/);
  const totalMatch = combined.match(/Tests:\s+.*?(\d+)\s+total/);
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;

  return {
    success: failed === 0 && total > 0,
    passed,
    failed,
    total,
    skipped: Math.max(0, total - passed - failed),
    failures: [],
  };
}

// ── Diff Generation ──────────────────────────────────────────────────

/**
 * Generate a git diff for specific files or all unstaged changes.
 * Used for self-review — engineers review their own changes before submitting.
 */
export async function generateDiffReport(
  workspaceRoot: string,
  files?: string[],
): Promise<string> {
  return new Promise<string>((resolve) => {
    let command: string;
    if (files && files.length > 0) {
      const fileArgs = files.map(f => `"${f}"`).join(" ");
      command = `git diff -- ${fileArgs}`;
    } else {
      command = "git diff";
    }

    cp.exec(command, {
      cwd: workspaceRoot,
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    }, (error, stdout) => {
      if (error || !(stdout ?? "").trim()) {
        // Try staged changes (files might have been git added)
        const stagedCmd = command.replace("git diff", "git diff --cached");
        cp.exec(stagedCmd, {
          cwd: workspaceRoot,
          timeout: 10_000,
          maxBuffer: MAX_OUTPUT_SIZE,
        }, (_err2, stdout2) => {
          resolve((stdout2 ?? "").slice(0, 10_000));
        });
        return;
      }
      resolve((stdout ?? "").slice(0, 10_000));
    });
  });
}

// ── Diagnostic Filtering ─────────────────────────────────────────────

/**
 * Filter diagnostics (build or lint) to only those affecting the specified files.
 * Used by the coder pool to give each domain coder only their own errors.
 */
export function filterDiagnosticsForFiles(
  diagnostics: BuildDiagnostic[],
  ownedFiles: string[],
): BuildDiagnostic[] {
  const ownedSet = new Set(ownedFiles.map(f => f.replace(/^\.\//, "")));
  return diagnostics.filter(d => {
    const normalised = d.file.replace(/^\.\//, "");
    return ownedSet.has(normalised);
  });
}

// ── LLM Formatters ───────────────────────────────────────────────────

/** Format lint results into a concise report for the LLM. */
export function formatLintResultForLLM(result: LintResult): string {
  if (result.success && result.errorCount === 0) {
    return "✅ **Lint passed** — no issues found.";
  }

  const parts: string[] = [
    `⚠️ **Lint: ${result.errorCount} error(s), ${result.warningCount} warning(s):**`,
    "",
  ];

  for (const d of result.diagnostics.slice(0, 15)) {
    parts.push(`- **${d.file}:${d.line}** [${d.code}] ${d.message}`);
  }
  if (result.diagnostics.length > 15) {
    parts.push(`- … and ${result.diagnostics.length - 15} more`);
  }

  return parts.join("\n");
}

/** Format test results into a concise report for the LLM. */
export function formatTestResultForLLM(result: TestResult): string {
  if (result.success) {
    return `✅ **Tests passed** — ${result.passed} passed, ${result.total} total.`;
  }

  const parts: string[] = [
    `❌ **Tests FAILED** — ${result.failed} failed, ${result.passed} passed, ${result.total} total:`,
    "",
  ];

  for (const f of result.failures.slice(0, 10)) {
    parts.push(`- **${f.suiteName} › ${f.testName}**`);
    if (f.message) {
      const msg = f.message.split("\n").map(l => `    ${l}`).join("\n");
      parts.push(msg);
    }
  }
  if (result.failures.length > 10) {
    parts.push(`- … and ${result.failures.length - 10} more failures`);
  }

  return parts.join("\n");
}

/**
 * Format the full quality gate report for the LLM.
 * Includes build, lint, test results, and diff — everything the
 * engineer needs to diagnose and fix failures.
 */
export function formatQualityReportForLLM(report: QualityGateResult): string {
  const sections: string[] = [
    "# 🔍 Quality Gate Report\n",
  ];

  // Build / type check
  sections.push("## Build / Type Check");
  sections.push(formatBuildErrorsForLLM(report.build));
  sections.push("");

  // Lint
  if (report.lint) {
    sections.push("## Lint");
    sections.push(formatLintResultForLLM(report.lint));
    sections.push("");
  }

  // Tests
  if (report.tests && report.tests.total > 0) {
    sections.push("## Tests");
    sections.push(formatTestResultForLLM(report.tests));
    sections.push("");
  }

  // Diff summary (context for fixing)
  if (report.diff && report.diff.length > 50) {
    sections.push("## Your Changes (diff)");
    sections.push("```diff");
    sections.push(report.diff.slice(0, 5000));
    sections.push("```");
    sections.push("");
  }

  // Overall verdict
  sections.push(`---\n**Overall: ${report.passed ? "✅ ALL CHECKS PASSED" : "❌ QUALITY GATE FAILED"}**`);
  sections.push(report.summary);

  return sections.join("\n");
}

// ── Quality Gate Orchestrators ───────────────────────────────────────

/**
 * Run the individual engineer's quality gate — scoped to their files.
 * Like Meta's `arc lint && arc unit` pipeline.
 *
 * Runs: build (full project) → lint (scoped) → tests (related) → diff
 */
export async function runQualityGate(
  workspaceRoot: string,
  writtenFiles?: string[],
): Promise<QualityGateResult> {
  // 1. Build check (always full project — types are shared)
  const build = await runBuildValidation(workspaceRoot);

  // 2. Lint (scoped to written files if possible)
  const lint = await runLintValidation(workspaceRoot, writtenFiles);

  // 3. Tests (find related tests for written files)
  const tests = await runTestValidation(workspaceRoot, writtenFiles);

  // 4. Diff (for self-review)
  const diff = await generateDiffReport(workspaceRoot, writtenFiles);

  // 5. Compute overall result
  const passed = build.success &&
                 lint.success &&
                 (tests.success || tests.total === 0);

  const parts: string[] = [];
  parts.push(build.success ? "Build: ✅" : `Build: ❌ (${build.errorCount} errors)`);
  parts.push(lint.success ? "Lint: ✅" : `Lint: ⚠️ (${lint.errorCount} errors)`);
  parts.push(tests.total > 0
    ? (tests.success ? `Tests: ✅ (${tests.passed}/${tests.total})` : `Tests: ❌ (${tests.failed} failed)`)
    : "Tests: ⏭️ (none found)");

  return { build, lint, tests, diff, passed, summary: parts.join(" | ") };
}

/**
 * Run the staff engineer's quality gate — full project scope.
 * Like the full CI pipeline before merging to main.
 *
 * Runs: build (full) → lint (full) → ALL tests → full diff
 */
export async function runFullQualityGate(
  workspaceRoot: string,
): Promise<QualityGateResult> {
  // 1. Build check
  const build = await runBuildValidation(workspaceRoot);

  // 2. Full project lint
  const lint = await runLintValidation(workspaceRoot);

  // 3. Full test suite (catch regressions!)
  const tests = await runTestValidation(workspaceRoot);

  // 4. Full diff
  const diff = await generateDiffReport(workspaceRoot);

  // 5. Compute overall result
  const passed = build.success &&
                 lint.success &&
                 (tests.success || tests.total === 0);

  const parts: string[] = [];
  parts.push(build.success ? "Build: ✅" : `Build: ❌ (${build.errorCount} errors)`);
  parts.push(lint.success ? "Lint: ✅" : `Lint: ⚠️ (${lint.errorCount} errors)`);
  parts.push(tests.total > 0
    ? (tests.success ? `Tests: ✅ (${tests.passed}/${tests.total})` : `Tests: ❌ (${tests.failed} failed)`)
    : "Tests: ⏭️ (none found)");

  return { build, lint, tests, diff, passed, summary: parts.join(" | ") };
}
