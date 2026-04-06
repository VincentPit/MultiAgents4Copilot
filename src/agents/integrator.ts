/**
 * Integrator agent — the Integration Engineer / Tech Lead.
 *
 * Runs after the Coder Pool to validate and merge the work of
 * multiple domain-scoped coders into a cohesive codebase.
 *
 * Responsibilities:
 *   • Verify cross-domain interface contracts are satisfied
 *   • Create shared type definitions and barrel exports
 *   • Wire up dependency injection, configuration, and entry points
 *   • Fix missing imports between domains
 *   • Flag conflicts or inconsistencies for re-routing
 *
 * Think of this as the engineer who merges all the feature branches,
 * runs the integration tests, and opens a unified PR.
 */

import * as vscode from "vscode";
import {
  AgentState,
  AgentMessage,
  type DomainAssignment,
} from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput } from "../utils/terminalRunner";
import {
  runFullQualityGate,
  formatQualityReportForLLM,
  type QualityGateResult,
} from "../utils/qualityGate";
import { AgentOutputManager } from "../utils/agentOutputManager";
import { showBatchDiffs } from "../utils/diffViewer";
import type { TerminalResult } from "../graph/state";

const SYSTEM_PROMPT = `You are the Integration Engineer — a Staff-level tech lead who merges
the parallel output of multiple domain engineers into a cohesive codebase.

Your teammates just finished coding in parallel. Each owned a specific
domain with defined file patterns and interface contracts.

YOUR JOB:
1. Review all domain outputs for interface contract compliance.
2. Check that imports between domains resolve correctly.
3. Create any missing GLUE CODE:
   - Shared type definition files (types.ts, interfaces.ts)
   - Barrel export files (index.ts) that re-export from domains
   - Configuration wiring (dependency injection, env config)
   - Entry point files (main.ts, app.ts) that tie everything together
4. Ensure consistent error handling, naming, and patterns across domains.
5. Write an INTEGRATION REPORT summarizing what you validated and fixed.

CRITICAL RULES:
- Do NOT rewrite domain code — only add integration/glue files.
- If a domain's code violates its contract, note it in your report
  and write a minimal adapter if possible.
- Use the same file format rules (### \`path\` + fenced code blocks).
- Be concise — only create files that are actually needed.
- Include a \`\`\`bash block if any commands need to run (e.g. npm install).

OUTPUT FORMAT:
1. First, write any integration files using ### \`path\` format.
2. Then write an "## Integration Report" section summarizing:
   - ✅ Contracts validated
   - 🔗 Glue files created
   - ⚠️ Issues found (if any)

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

export async function integratorNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  stream.markdown(
    `---\n\n` +
    `#### 🔗 Integration Engineer — Merging domain outputs\n\n`
  );

  // ── Set up output channel for detailed LLM output ──
  const outputMgr = AgentOutputManager.getInstance();
  const taskSummary = `Integrating ${state.domainAssignments.length} domain outputs`;
  outputMgr.startRun("integrator", taskSummary);
  outputMgr.reveal("integrator");
  stream.markdown(`> 📺 _Detailed output streaming to **Integration Engineer** output channel_\n\n`);

  const domains = state.domainAssignments;

  // Build a summary of what each domain produced
  const domainSummaries = domains
    .map((d) => {
      const code = state.artifacts[`domain_code:${d.id}`] ?? "(no output)";
      const capped = code.length > 4_000
        ? code.slice(0, 4_000) + "\n[… truncated]"
        : code;
      return (
        `### Domain: ${d.domain} (${d.id})\n` +
        `Files: ${d.filePatterns.join(", ")}\n` +
        `Provides: ${d.provides}\n` +
        `Consumes: ${d.consumes}\n` +
        `\n${capped}`
      );
    })
    .join("\n\n---\n\n");

  // Build the contract map for validation
  const contractMap = domains
    .map(
      (d) =>
        `• ${d.domain}: provides [${d.provides}], consumes [${d.consumes}]`
    )
    .join("\n");

  let sysPrompt = SYSTEM_PROMPT;
  sysPrompt += `\n\n## Domain Contract Map\n${contractMap}`;
  sysPrompt += `\n\n## Domain Outputs\n${capContext(domainSummaries, 30_000)}`;

  // ── Inject quality issues from previous agents ──
  // If coders left quality gate failures, the integrator needs to know
  // so it can fix cross-domain issues as part of integration.
  const priorQualityErrors = state.artifacts["quality_errors"] ?? state.artifacts["build_errors"] ?? "";
  if (priorQualityErrors) {
    sysPrompt += `\n\n## ⚠️ EXISTING QUALITY ISSUES FROM CODERS\n` +
      `The domain coders left these unresolved quality issues (build/lint/test).\n` +
      `You MUST fix these as part of your integration work:\n\n${capContext(priorQualityErrors, 5_000)}`;
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

  // Stream LLM output to the output channel, NOT the chat panel
  const outputSink = { append: (text: string) => outputMgr.append("integrator", text) };
  const response = await callModel(model, messages, null, token, "integrator", outputSink);

  // ── Apply integration files ──
  let writtenFiles: string[] = [];
  let allOldContents: Map<string, string> = new Map();
  let lastResponse = response;
  try {
    const result = await applyCodeToWorkspace(response, stream);
    writtenFiles = result.written;
    allOldContents = result.oldContents;
    if (writtenFiles.length > 0) {
      await showBatchDiffs(writtenFiles, allOldContents);
      stream.markdown(`> ✅ **${writtenFiles.length} integration file(s)** written — diffs shown in editor\n`);
      logger.info(
        "integrator",
        `Wrote ${writtenFiles.length} integration file(s): ${writtenFiles.join(", ")}`
      );
    }
  } catch (err: any) {
    logger.error("integrator", `File write failed: ${err?.message}`);
    stream.markdown(`\n> ⚠️ Integration file write error: ${err?.message}\n`);
  }

  // ── Full CI Pipeline (Staff Engineer Quality Gate) ──
  // The integrator runs the FULL CI pipeline — build, lint, ALL tests.
  // This is the last line of defense before code goes to the reviewer.
  // Like a Staff Engineer running the complete test suite after merging.
  const MAX_INTEGRATOR_FIX_RETRIES = 2;
  let qaReport: QualityGateResult | null = null;
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

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
          `\n> ⚠️ **CI pipeline still failing** after ${MAX_INTEGRATOR_FIX_RETRIES} fix attempt(s). ` +
          `${qaReport.summary}\n`
        );
        break;
      }

      const qualityReport = formatQualityReportForLLM(qaReport);
      stream.markdown(
        `\n> 🔧 **CI pipeline failed** (${qaReport.summary}) — ` +
        `Staff Engineer fixing (attempt ${attempt + 1}/${MAX_INTEGRATOR_FIX_RETRIES})…\n`
      );

      const fixMessages = buildMessages({
        systemPrompt: SYSTEM_PROMPT +
          `\n\n## ❌ CI PIPELINE FAILED — FIX ALL ISSUES\n` +
          `The full CI pipeline (build + lint + tests) found issues after integration.\n` +
          `These may be cross-domain import issues, missing types, lint violations,\n` +
          `or test regressions. You must fix them ALL.\n` +
          `Rewrite ONLY the files that need changes.\n\n${qualityReport}`,
        workspaceContext: state.workspaceContext,
        chatHistory: "",
        userQuestion: `Fix ALL CI pipeline failures. Output corrected files using ### \`path\` format.`,
        maxSystemChars: 20_000,
        maxWorkspaceChars: 6_000,
      });

      outputMgr.append("integrator", `\n--- CI fix attempt ${attempt + 1} ---\n`);
      const fixResponse = await callModel(model, fixMessages, null, token, `integrator-fix-${attempt + 1}`, outputSink);
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

  // ── Run any integration commands ──
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

  // ── End the output channel run ──
  outputMgr.endRun("integrator", Date.now(), writtenFiles.length > 0);

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
    },
    terminalResults,
  };
}
