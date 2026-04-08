/**
 * Build validator — runs the project's build/compile step and captures
 * structured error information that agents can use to fix their mistakes.
 *
 * This is the critical missing piece: after an agent writes code,
 * this module validates it actually compiles/lints, and returns
 * actionable diagnostics so the agent can self-correct.
 *
 * Supports:
 *   • TypeScript (tsc --noEmit)
 *   • npm/yarn build scripts
 *   • Generic lint commands
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

export interface BuildDiagnostic {
  /** File path (relative to workspace root). */
  file: string;
  /** Line number (1-based). */
  line: number;
  /** Column number (1-based). */
  column: number;
  /** Error code (e.g., "TS2345"). */
  code: string;
  /** Human-readable error message. */
  message: string;
}

export interface BuildResult {
  /** Whether the build succeeded (exit code 0). */
  success: boolean;
  /** Parsed diagnostics from the build output. */
  diagnostics: BuildDiagnostic[];
  /** Raw stdout from the build command. */
  stdout: string;
  /** Raw stderr from the build command. */
  stderr: string;
  /** The command that was run. */
  command: string;
  /** How long the build took (ms). */
  durationMs: number;
  /** Total number of errors. */
  errorCount: number;
}

// ── Build command detection ──────────────────────────────────────────

/** Max timeout for a build validation step (30s — just checking, not full build). */
export const BUILD_TIMEOUT_MS = 30_000;

/** Max output to capture (50 KB). */
export const MAX_OUTPUT_SIZE = 50 * 1024;

/**
 * Detect the appropriate build/check command for the workspace.
 * Checks for common project files and returns the best validation command.
 */
export async function detectBuildCommand(workspaceRoot: string): Promise<string | null> {
  const fs = vscode.workspace.fs;
  const root = vscode.Uri.file(workspaceRoot);

  // 1. TypeScript project → tsc --noEmit (fastest check)
  try {
    await fs.stat(vscode.Uri.joinPath(root, "tsconfig.json"));
    return "npx tsc --noEmit";
  } catch { /* no tsconfig */ }

  // 2. package.json with "build" or "check" script
  try {
    const pkgUri = vscode.Uri.joinPath(root, "package.json");
    const pkgBytes = await fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString("utf-8"));
    if (pkg.scripts?.typecheck) { return "npm run typecheck"; }
    if (pkg.scripts?.check) { return "npm run check"; }
    if (pkg.scripts?.lint) { return "npm run lint"; }
    // Don't use "npm run build" — too slow for validation cycles
  } catch { /* no package.json or parse error */ }

  // 3. Python project
  try {
    await fs.stat(vscode.Uri.joinPath(root, "pyproject.toml"));
    return "python -m py_compile";  // basic syntax check
  } catch { /* no pyproject */ }

  // 4. Rust project
  try {
    await fs.stat(vscode.Uri.joinPath(root, "Cargo.toml"));
    return "cargo check";
  } catch { /* no Cargo.toml */ }

  // 5. Go project
  try {
    await fs.stat(vscode.Uri.joinPath(root, "go.mod"));
    return "go build ./...";
  } catch { /* no go.mod */ }

  return null;
}

// ── Build execution ──────────────────────────────────────────────────

/**
 * Run the build/check command and return structured results.
 * This is designed to be fast — it runs `tsc --noEmit` or similar,
 * NOT a full production build.
 */
export async function runBuildValidation(
  workspaceRoot: string,
  customCommand?: string,
): Promise<BuildResult> {
  const command = customCommand ?? await detectBuildCommand(workspaceRoot) ?? null;

  if (!command) {
    logger.info("buildValidator", "No build command detected — skipping validation");
    return {
      success: true,
      diagnostics: [],
      stdout: "",
      stderr: "",
      command: "(none)",
      durationMs: 0,
      errorCount: 0,
    };
  }

  const start = Date.now();
  logger.info("buildValidator", `Running: ${command}`);

  return new Promise<BuildResult>((resolve) => {
    const proc = cp.exec(command, {
      cwd: workspaceRoot,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const rawOutput = (stdout ?? "") + "\n" + (stderr ?? "");
      const diagnostics = parseDiagnostics(rawOutput);

      const result: BuildResult = {
        success: !error,
        diagnostics,
        stdout: truncateOutput(stdout ?? ""),
        stderr: truncateOutput(stderr ?? ""),
        command,
        durationMs,
        errorCount: diagnostics.length,
      };

      logger.info("buildValidator",
        `Build ${result.success ? "PASSED" : "FAILED"}: ${diagnostics.length} error(s) in ${durationMs}ms`
      );

      resolve(result);
    });

    // Safety: kill if it hangs
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, BUILD_TIMEOUT_MS + 1000);
    timer.unref();
  });
}

// ── Diagnostic parsing ───────────────────────────────────────────────

/**
 * TypeScript error pattern:
 *   src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable...
 *   src/foo.ts:10:5 - error TS2345: Argument of type...
 */
const TS_ERROR_PATTERN = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[-:]\s*error\s+(TS\d+)\s*:\s*(.+)$/;

/**
 * ESLint error pattern:
 *   /path/to/file.ts:10:5  error  Some message  rule-name
 *   src/foo.ts  10:5  error  ...
 */
const ESLINT_ERROR_PATTERN = /^(.+?)\s+(\d+):(\d+)\s+error\s+(.+?)(?:\s{2,}(\S+))?\s*$/;

/**
 * Generic "file:line:col: message" pattern (gcc, rustc, go, etc.)
 */
const GENERIC_ERROR_PATTERN = /^(.+?):(\d+):(\d+):\s*(?:error|Error)\s*(?:\[\w+\])?\s*:?\s*(.+)$/;

/**
 * Parse structured diagnostics from build output.
 * Handles TypeScript, ESLint, and generic compiler output formats.
 */
export function parseDiagnostics(output: string): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>(); // deduplicate

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    let diag: BuildDiagnostic | null = null;

    // Try TypeScript pattern
    const tsMatch = trimmed.match(TS_ERROR_PATTERN);
    if (tsMatch) {
      diag = {
        file: tsMatch[1].trim(),
        line: parseInt(tsMatch[2] ?? tsMatch[4], 10),
        column: parseInt(tsMatch[3] ?? tsMatch[5], 10),
        code: tsMatch[6],
        message: tsMatch[7].trim(),
      };
    }

    // Try ESLint pattern
    if (!diag) {
      const eslintMatch = trimmed.match(ESLINT_ERROR_PATTERN);
      if (eslintMatch) {
        diag = {
          file: eslintMatch[1].trim(),
          line: parseInt(eslintMatch[2], 10),
          column: parseInt(eslintMatch[3], 10),
          code: eslintMatch[5] ?? "lint",
          message: eslintMatch[4].trim(),
        };
      }
    }

    // Try generic pattern
    if (!diag) {
      const genericMatch = trimmed.match(GENERIC_ERROR_PATTERN);
      if (genericMatch) {
        diag = {
          file: genericMatch[1].trim(),
          line: parseInt(genericMatch[2], 10),
          column: parseInt(genericMatch[3], 10),
          code: "E0",
          message: genericMatch[4].trim(),
        };
      }
    }

    if (diag) {
      const key = `${diag.file}:${diag.line}:${diag.column}:${diag.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diag);
      }
    }
  }

  return diagnostics;
}

// ── Format for LLM consumption ───────────────────────────────────────

/**
 * Format build errors into a concise prompt section that an LLM can
 * understand and act on to fix the issues.
 */
export function formatBuildErrorsForLLM(result: BuildResult): string {
  if (result.success) {
    return "✅ **Build passed** — no compilation errors.";
  }

  const parts: string[] = [
    `❌ **Build FAILED** with ${result.errorCount} error(s):`,
    "",
  ];

  // Group diagnostics by file for clarity
  const byFile = new Map<string, BuildDiagnostic[]>();
  for (const d of result.diagnostics) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }

  for (const [file, diags] of byFile) {
    parts.push(`### \`${file}\``);
    for (const d of diags.slice(0, 10)) { // cap at 10 per file
      parts.push(`- **Line ${d.line}:** [${d.code}] ${d.message}`);
    }
    if (diags.length > 10) {
      parts.push(`- … and ${diags.length - 10} more errors in this file`);
    }
    parts.push("");
  }

  // Also include raw output for context (capped)
  if (result.stderr && result.diagnostics.length === 0) {
    // If we couldn't parse diagnostics, give the raw output
    parts.push("### Raw build output:");
    parts.push("```");
    parts.push(result.stderr.slice(0, 3000));
    parts.push("```");
  }

  return parts.join("\n");
}

/**
 * Format build errors targeting specific files that a particular agent wrote.
 * This gives the agent ONLY its own errors, not other agents' mistakes.
 */
export function filterErrorsForFiles(
  result: BuildResult,
  ownedFiles: string[],
): BuildDiagnostic[] {
  if (result.success) { return []; }

  const ownedSet = new Set(ownedFiles.map(f => f.replace(/^\.\//, "")));
  return result.diagnostics.filter(d => {
    const normalised = d.file.replace(/^\.\//, "");
    return ownedSet.has(normalised);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncateOutput(output: string): string {
  if (output.length <= 5000) { return output; }
  return output.slice(0, 5000) + "\n[… truncated]";
}
