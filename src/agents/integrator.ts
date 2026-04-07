/**
 * Integrator agent — the Integration Engineer / Tech Lead.
 *
 * Runs after the Coder Pool to merge all domain branches, run
 * production-level tests, and implement a FEEDBACK LOOP that
 * routes failures back to the specific coder who caused them.
 *
 * Responsibilities:
 *   • Receive BranchResult[] from the Coder Pool
 *   • Verify cross-domain interface contracts are satisfied
 *   • Create shared type definitions, barrel exports, glue code
 *   • Wire up DI, configuration, and entry points
 *   • Run FULL CI pipeline (build + lint + ALL tests)
 *   • If tests fail, IDENTIFY which domain caused the failure
 *     and dispatch a targeted fix request back to that coder
 *   • Generate production-level integration tests
 *
 * Think of this as the Staff Engineer who merges all feature branches,
 * runs the full test suite, then walks back to the engineer whose
 * branch broke the build and asks them to fix it.
 */

import * as vscode from "vscode";
import {
  AgentState,
  AgentMessage,
  type DomainAssignment,
  type BranchResult,
  type TerminalResult,
} from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput } from "../utils/terminalRunner";
import {
  runFullQualityGate,
  formatQualityReportForLLM,
  filterDiagnosticsForFiles,
  type QualityGateResult,
  type BuildDiagnostic,
} from "../utils/qualityGate";
import { AgentOutputManager } from "../utils/agentOutputManager";
import { showBatchDiffs } from "../utils/diffViewer";

const SYSTEM_PROMPT = `You are the Integration Engineer — a Staff-level tech lead who merges
the parallel output of multiple domain engineers into a cohesive codebase
and generates PRODUCTION-LEVEL integration tests.

Your teammates just finished coding in parallel. Each owned a specific
domain with defined file patterns, API specs, and interface contracts.
You also have their BranchResults showing test status and files written.

YOUR JOB:
1. Review all domain outputs for interface contract compliance.
2. Check that imports between domains resolve correctly.
3. Create any missing GLUE CODE:
   - Shared type definition files (types.ts, interfaces.ts)
   - Barrel export files (index.ts) that re-export from domains
   - Configuration wiring (dependency injection, env config)
   - Entry point files (main.ts, app.ts) that tie everything together
4. Ensure consistent error handling, naming, and patterns across domains.
5. GENERATE PRODUCTION-LEVEL INTEGRATION TESTS:
   - End-to-end flows that cross domain boundaries
   - Contract verification tests between domains
   - Error handling / edge case tests
   - Performance / concurrency tests where applicable
6. Write an INTEGRATION REPORT summarizing what you validated and fixed.

CRITICAL RULES:
- Do NOT rewrite domain code — only add integration/glue files.
- If a domain's code violates its contract, note it in your report
  and write a minimal adapter if possible.
- Use the same file format rules (### \`path\` + fenced code blocks).
- Be concise — only create files that are actually needed.
- Include a \`\`\`bash block if any commands need to run (e.g. npm install).
- Production tests go in the appropriate test directory (e.g., __tests__/integration/).

OUTPUT FORMAT:
1. First, write any integration files using ### \`path\` format.
2. Then write production integration tests using ### \`path\` format.
3. Finally write an "## Integration Report" section summarizing:
   - ✅ Contracts validated
   - 🔗 Glue files created
   - 🧪 Integration tests written
   - ⚠️ Issues found (if any)
   - 🔄 Branches that need feedback (if any)

AFTER INTEGRATION, YOUR CODE RUNS THROUGH THE FULL CI PIPELINE:
  • Full project type-check (tsc --noEmit)
  • Full project lint (eslint)
  • Full test suite — catch regressions!
  • Full diff review — architecture consistency
You are the LAST LINE OF DEFENSE before code review. If your integration
breaks tests or introduces regressions, YOU must fix it.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself. The extension's own source code (src/agents/, src/graph/,
src/utils/, etc.) must never be written to. Self-modification is blocked.`;

const FEEDBACK_FIX_PROMPT = `You are a domain coder receiving FEEDBACK from the Integration Engineer.

Your code FAILED during integration. The Integration Engineer identified
specific issues with YOUR files. You must fix ONLY your files.

RULES:
1. Output ONLY the files that need fixing — not all your files.
2. Keep your fixes minimal and targeted — don't restructure everything.
3. Preserve the interface contracts you were given.
4. Your fix will be re-tested immediately.
5. Use the same file format rules (### \`path\` + fenced code blocks).`;

export async function integratorNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  stream.markdown(
    `---\n\n` +
    `#### 🔗 Integration Engineer — Merging & Testing domain outputs\n\n`
  );

  const outputMgr = AgentOutputManager.getInstance();
  const taskSummary = `Integrating ${state.domainAssignments.length} domain outputs`;
  outputMgr.startRun("integrator", taskSummary);
  outputMgr.reveal("integrator");

  const domains = state.domainAssignments;
  const branchResults = state.branchResults ?? [];

  // ── 1. Display branch status from coder pool ──
  if (branchResults.length > 0) {
    const passed = branchResults.filter(r => r.testsPassed).length;
    const failed = branchResults.filter(r => r.errors.length > 0 || !r.testsPassed).length;
    stream.markdown(
      `> 📊 **Branch Status**: ${passed} passed, ${failed} need attention\n\n` +
      `| Domain | Tests | Files | Fix Attempts | Errors |\n` +
      `|--------|-------|-------|--------------|--------|\n` +
      branchResults.map(r =>
        `| **${r.domain}** | ${r.testsPassed ? "✅" : "❌"} | ${r.filesWritten.length} | ${r.fixAttempts} | ${r.errors.length > 0 ? r.errors[0].slice(0, 40) : "—"} |`
      ).join("\n") +
      `\n\n`
    );
  }

  // ── 2. Build rich context from branch results ──
  const domainSummaries = domains
    .map((d) => {
      const br = branchResults.find(r => r.domainId === d.id);
      const code = br?.code ?? state.artifacts[`domain_code:${d.id}`] ?? "(no output)";
      const capped = code.length > 4_000
        ? code.slice(0, 4_000) + "\n[… truncated]"
        : code;

      let summary = `### Domain: ${d.domain} (${d.id})\n` +
        `Files: ${d.filePatterns.join(", ")}\n` +
        `Provides: ${d.provides}\n` +
        `Consumes: ${d.consumes}\n`;

      if (d.apiSpec) {
        summary += `Endpoints: ${d.apiSpec.endpoints?.map(e => `${e.method} ${e.path}`).join(", ") ?? "none"}\n`;
        summary += `Interfaces: ${d.apiSpec.interfaces?.map(i => i.name).join(", ") ?? "none"}\n`;
      }

      if (br) {
        summary += `Test Status: ${br.testsPassed ? "PASSED" : "FAILED"}\n`;
        summary += `Files Written: ${br.filesWritten.join(", ") || "none"}\n`;
        if (br.errors.length > 0) {
          summary += `Errors: ${br.errors.join("; ")}\n`;
        }
        if (!br.testsPassed && br.testOutput) {
          summary += `Test Output:\n${br.testOutput.slice(0, 1000)}\n`;
        }
      }

      summary += `\n${capped}`;
      return summary;
    })
    .join("\n\n---\n\n");

  const contractMap = domains
    .map(d => `• ${d.domain}: provides [${d.provides}], consumes [${d.consumes}]`)
    .join("\n");

  let sysPrompt = SYSTEM_PROMPT;
  sysPrompt += `\n\n## Domain Contract Map\n${contractMap}`;
  sysPrompt += `\n\n## Domain Outputs\n${capContext(domainSummaries, 30_000)}`;

  // Inject quality issues from coder pool
  const priorQualityErrors = state.artifacts["quality_errors"] ?? state.artifacts["build_errors"] ?? "";
  if (priorQualityErrors) {
    sysPrompt += `\n\n## ⚠️ EXISTING QUALITY ISSUES FROM CODERS\n` +
      `The domain coders left these unresolved quality issues:\n\n${capContext(priorQualityErrors, 5_000)}`;
  }

  const lastUserContent =
    [...state.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: `Integrate the outputs of ${domains.length} domain coders. Task: ${lastUserContent}`,
    maxSystemChars: 40_000,
    maxWorkspaceChars: 6_000,
    maxReferencesChars: 4_000,
  });

  // ── 3. Generate integration code + production tests ──
  outputMgr.append("integrator", "Generating integration code + production tests…\n");
  const response = await callModel(model, messages, null, token, "integrator");

  let writtenFiles: string[] = [];
  let allOldContents: Map<string, string> = new Map();
  let lastResponse = response;

  try {
    const result = await applyCodeToWorkspace(response, stream);
    writtenFiles = result.written;
    allOldContents = result.oldContents;
    if (writtenFiles.length > 0) {
      await showBatchDiffs(writtenFiles, allOldContents);
      outputMgr.append("integrator", `Wrote ${writtenFiles.length} file(s): ${writtenFiles.join(", ")}\n`);
      stream.markdown(`> ✅ **${writtenFiles.length} integration file(s)** written — diffs shown in editor\n`);
      logger.info("integrator", `Wrote ${writtenFiles.length} integration file(s): ${writtenFiles.join(", ")}`);
    }
  } catch (err: any) {
    logger.error("integrator", `File write failed: ${err?.message}`);
    stream.markdown(`\n> ⚠️ Integration file write error: ${err?.message}\n`);
  }

  // ── 4. Full CI Pipeline + Feedback Loop ──
  // Run the FULL CI pipeline. If it fails, identify which domain
  // caused the failure and route the fix request back to that coder.
  const MAX_INTEGRATOR_FIX_RETRIES = 2;
  const MAX_FEEDBACK_ROUNDS = 2;
  let qaReport: QualityGateResult | null = null;
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Track which domains have been sent back for fixes
  const feedbackHistory: Map<string, number> = new Map();

  if (wsRoot) {
    for (let attempt = 0; attempt <= MAX_INTEGRATOR_FIX_RETRIES; attempt++) {
      if (token.isCancellationRequested) { break; }

      qaReport = await runFullQualityGate(wsRoot);

      if (qaReport.passed) {
        stream.markdown(`\n> ✅ **Full CI pipeline passed** — ${qaReport.summary}\n`);
        break;
      }

      if (attempt >= MAX_INTEGRATOR_FIX_RETRIES) {
        stream.markdown(
          `\n> ⚠️ **CI pipeline still failing** after ${MAX_INTEGRATOR_FIX_RETRIES} fix round(s). ` +
          `${qaReport.summary}\n`
        );
        break;
      }

      // ── Feedback Loop: Route failures to specific coders ──
      // Analyze diagnostics to identify which domain owns the failing files.
      // Send targeted fix requests only to the coder(s) whose code broke.
      const allDiags: BuildDiagnostic[] = [
        ...qaReport.build.diagnostics,
        ...(qaReport.lint?.diagnostics ?? []),
      ];
      const testFailSummary = qaReport.tests && !qaReport.tests.success
        ? qaReport.tests.failures.map(f =>
            `- **${f.suiteName} › ${f.testName}**: ${f.message.slice(0, 200)}`
          ).join("\n")
        : "";

      // Identify which domains are responsible for failures
      const domainFixRequests: { domain: DomainAssignment; errors: string; files: string[] }[] = [];
      const integrationErrors: string[] = [];

      for (const domain of domains) {
        const br = branchResults.find(r => r.domainId === domain.id);
        const domainFiles = br?.filesWritten ?? [];
        if (domainFiles.length === 0) { continue; }

        const domainDiags = filterDiagnosticsForFiles(allDiags, domainFiles);
        if (domainDiags.length === 0 && !testFailSummary) { continue; }

        // Check feedback attempt count
        const feedbackCount = feedbackHistory.get(domain.id) ?? 0;
        if (feedbackCount >= MAX_FEEDBACK_ROUNDS) {
          stream.markdown(
            `> ℹ️ **${domain.domain}** already got ${feedbackCount} fix round(s) — ` +
            `remaining issues go to integrator.\n`
          );
          const diagText = domainDiags.map(d =>
            `- ${d.file}:${d.line} [${d.code}] ${d.message}`
          ).join("\n");
          integrationErrors.push(`## ${domain.domain}\n${diagText}`);
          continue;
        }

        let errorReport = domainDiags.map(d =>
          `- **${d.file}:${d.line}** [${d.code}] ${d.message}`
        ).join("\n");

        if (testFailSummary) {
          errorReport += `\n\n### Test Failures (may relate to your domain):\n${testFailSummary}`;
        }

        domainFixRequests.push({
          domain,
          errors: errorReport,
          files: domainFiles,
        });
      }

      if (domainFixRequests.length > 0) {
        stream.markdown(
          `\n> 🔄 **Feedback Loop** — sending failures back to ` +
          `${domainFixRequests.length} coder(s) for targeted fixes ` +
          `(round ${attempt + 1}/${MAX_INTEGRATOR_FIX_RETRIES})…\n\n`
        );

        // Dispatch fix requests to failing coders in parallel
        const fixPromises = domainFixRequests.map(async (req) => {
          feedbackHistory.set(req.domain.id, (feedbackHistory.get(req.domain.id) ?? 0) + 1);

          stream.markdown(
            `> 🔧 **${req.domain.domain}**: ${req.errors.split("\n").length} issue(s) — sending back\n`
          );

          const fixPrompt = FEEDBACK_FIX_PROMPT +
            `\n\n## Your Domain: ${req.domain.domain}\n` +
            `Files you own: ${req.domain.filePatterns.join(", ")}\n` +
            `Provides: ${req.domain.provides}\n` +
            `Consumes: ${req.domain.consumes}\n` +
            (req.domain.apiSpec ? `\nAPI Spec:\n${JSON.stringify(req.domain.apiSpec, null, 2).slice(0, 2000)}` : "") +
            `\n\n## ❌ FAILURES IN YOUR CODE\n${req.errors}\n\n` +
            `Fix ONLY these files: ${req.files.join(", ")}`;

          const fixMessages = buildMessages({
            systemPrompt: fixPrompt,
            workspaceContext: state.workspaceContext,
            chatHistory: "",
            userQuestion: `Fix the failures in your domain files.`,
            maxSystemChars: 14_000,
            maxWorkspaceChars: 4_000,
          });

          try {
            const fixResponse = await callModel(
              model, fixMessages, null, token, `feedback:${req.domain.id}`
            );

            const fixResult = await applyCodeToWorkspace(fixResponse, stream);
            if (fixResult.written.length > 0) {
              writtenFiles.push(...fixResult.written);
              for (const [k, v] of fixResult.oldContents) { allOldContents.set(k, v); }
              await showBatchDiffs(fixResult.written, fixResult.oldContents);
              stream.markdown(
                `> ✅ **${req.domain.domain}**: fixed ${fixResult.written.length} file(s)\n`
              );
              logger.info(`feedback:${req.domain.id}`, `Fix wrote ${fixResult.written.length} file(s)`);
            }
          } catch (err: any) {
            logger.error(`feedback:${req.domain.id}`, `Feedback fix failed: ${err?.message}`);
            stream.markdown(`> ⚠️ **${req.domain.domain}** fix failed: ${err?.message}\n`);
          }
        });

        await Promise.allSettled(fixPromises);
      }

      // If there are also integration-level errors (or no domain-specific fixes),
      // the integrator itself tries to fix cross-domain issues
      if (domainFixRequests.length === 0 || integrationErrors.length > 0) {
        const qualityReport = formatQualityReportForLLM(qaReport);
        stream.markdown(
          `\n> 🔧 **Integrator** fixing cross-domain issues ` +
          `(attempt ${attempt + 1}/${MAX_INTEGRATOR_FIX_RETRIES})…\n`
        );

        const fixMessages = buildMessages({
          systemPrompt: SYSTEM_PROMPT +
            `\n\n## ❌ CI PIPELINE FAILED — FIX ALL ISSUES\n` +
            `The full CI pipeline found issues after integration.\n` +
            `These may be cross-domain import issues, missing types, lint violations,\n` +
            `or test regressions. You must fix them ALL.\n` +
            `Rewrite ONLY the files that need changes.\n\n${qualityReport}` +
            (integrationErrors.length > 0
              ? `\n\n## Domain-specific errors (coders exhausted fix attempts):\n${integrationErrors.join("\n\n")}`
              : ""),
          workspaceContext: state.workspaceContext,
          chatHistory: "",
          userQuestion: `Fix ALL CI pipeline failures. Output corrected files using ### \`path\` format.`,
          maxSystemChars: 20_000,
          maxWorkspaceChars: 6_000,
        });

        outputMgr.append("integrator", `CI fix attempt ${attempt + 1}…\n`);
        const fixResponse = await callModel(model, fixMessages, null, token, `integrator-fix-${attempt + 1}`);
        lastResponse = fixResponse;

        try {
          const fixResult = await applyCodeToWorkspace(fixResponse, stream);
          if (fixResult.written.length > 0) {
            writtenFiles.push(...fixResult.written);
            for (const [k, v] of fixResult.oldContents) { allOldContents.set(k, v); }
            await showBatchDiffs(fixResult.written, fixResult.oldContents);
            logger.info("integrator", `Fix attempt ${attempt + 1}: wrote ${fixResult.written.length} file(s)`);
          }
        } catch (err: any) {
          logger.error("integrator", `Fix attempt ${attempt + 1} write failed: ${err?.message}`);
        }
      }
    }
  }

  // ── 5. Run integration commands ──
  const terminalResults: TerminalResult[] = [];
  try {
    const cmdResult = await runCommandsFromOutput(response, stream);
    for (const executed of cmdResult.executed) {
      terminalResults.push({
        command: executed.command,
        success: executed.success,
        stdout: executed.stdout,
        stderr: executed.stderr,
        agent: "integrator",
      });
    }
  } catch (err: any) {
    logger.error("integrator", `Terminal command failed: ${err?.message}`);
  }

  const finalCapped = lastResponse.length > 6_000
    ? lastResponse.slice(0, 6_000) + "\n[… truncated in state]"
    : lastResponse;

  outputMgr.endRun("integrator", Date.now(), writtenFiles.length > 0);

  // ── 6. Build feedback summary for the user ──
  const feedbackSummary = feedbackHistory.size > 0
    ? `\n> 🔄 **Feedback Loop**: ${feedbackHistory.size} coder(s) received fixes ` +
      `(${[...feedbackHistory.entries()].map(([id, n]) => `${id}: ${n} round(s)`).join(", ")})\n`
    : "";

  stream.markdown(
    `\n---\n\n` +
    `> ✅ **Integration complete** — ${writtenFiles.length} file(s) written` +
    (qaReport ? ` · ${qaReport.passed ? "CI passed ✅" : "CI issues ⚠️"}` : "") +
    `\n${feedbackSummary}`
  );

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "integrator",
    content: finalCapped,
  };

  return {
    messages: [newMessage],
    artifacts: {
      integration_report: finalCapped,
      ...(writtenFiles.length > 0
        ? { integration_files: writtenFiles.join(", ") }
        : {}),
      ...(qaReport ? { build_status: qaReport.build.success ? "passed" : `failed:${qaReport.build.errorCount}` } : {}),
      ...(qaReport ? { quality_summary: qaReport.summary } : {}),
      ...(qaReport?.tests ? { test_results: qaReport.tests.success ? `passed:${qaReport.tests.passed}/${qaReport.tests.total}` : `failed:${qaReport.tests.failed}/${qaReport.tests.total}` } : {}),
      ...(qaReport?.lint ? { lint_results: qaReport.lint.success ? "passed" : `errors:${qaReport.lint.errorCount}` } : {}),
      ...(qaReport && !qaReport.passed ? { quality_errors: formatQualityReportForLLM(qaReport) } : {}),
      ...(feedbackHistory.size > 0 ? { feedback_summary: [...feedbackHistory.entries()].map(([id, n]) => `${id}:${n}`).join(",") } : {}),
    },
    terminalResults,
  };
}
