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
import { runBuildValidation, formatBuildErrorsForLLM, type BuildResult } from "../utils/buildValidator";
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

  // ── Inject build errors from previous agents ──
  // If coders left build errors, the integrator needs to know about them
  // so it can fix cross-domain issues as part of integration.
  const priorBuildErrors = state.artifacts["build_errors"] ?? "";
  if (priorBuildErrors) {
    sysPrompt += `\n\n## ⚠️ EXISTING BUILD ERRORS FROM CODERS\n` +
      `The domain coders left these unresolved compilation errors.\n` +
      `You MUST fix these as part of your integration work:\n\n${capContext(priorBuildErrors, 5_000)}`;
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

  const response = await callModel(model, messages, stream, token, "integrator");

  // ── Apply integration files ──
  let writtenFiles: string[] = [];
  let lastResponse = response;
  try {
    const result = await applyCodeToWorkspace(response, stream);
    writtenFiles = result.written;
    if (writtenFiles.length > 0) {
      logger.info(
        "integrator",
        `Wrote ${writtenFiles.length} integration file(s): ${writtenFiles.join(", ")}`
      );
    }
  } catch (err: any) {
    logger.error("integrator", `File write failed: ${err?.message}`);
    stream.markdown(`\n> ⚠️ Integration file write error: ${err?.message}\n`);
  }

  // ── Build validation + fix loop ──
  // The integrator is the LAST LINE OF DEFENSE before code goes to the
  // reviewer. If the build fails here, the integrator must fix it.
  const MAX_INTEGRATOR_FIX_RETRIES = 2;
  let buildResult: BuildResult | null = null;
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (wsRoot) {
    for (let attempt = 0; attempt <= MAX_INTEGRATOR_FIX_RETRIES; attempt++) {
      if (token.isCancellationRequested) { break; }

      buildResult = await runBuildValidation(wsRoot);

      if (buildResult.success) {
        stream.markdown(`\n> ✅ **Integration build passed** — codebase compiles cleanly.\n`);
        break;
      }

      if (attempt >= MAX_INTEGRATOR_FIX_RETRIES) {
        stream.markdown(
          `\n> ⚠️ **Build still failing** after ${MAX_INTEGRATOR_FIX_RETRIES} integration fix attempt(s). ` +
          `${buildResult.errorCount} error(s) remain.\n`
        );
        break;
      }

      const errorReport = formatBuildErrorsForLLM(buildResult);
      stream.markdown(
        `\n> 🔧 **Integration build failed** (${buildResult.errorCount} error(s)) — ` +
        `fixing (attempt ${attempt + 1}/${MAX_INTEGRATOR_FIX_RETRIES})…\n`
      );

      const fixMessages = buildMessages({
        systemPrompt: SYSTEM_PROMPT +
          `\n\n## ❌ BUILD ERRORS — FIX THESE NOW\n` +
          `The codebase has the following compilation errors after integration.\n` +
          `These may be cross-domain import issues, missing type definitions,\n` +
          `or interface contract mismatches. Fix them all.\n` +
          `Rewrite ONLY the files that need changes.\n\n${errorReport}`,
        workspaceContext: state.workspaceContext,
        chatHistory: "",
        userQuestion: `Fix the ${buildResult.errorCount} build error(s). Output corrected files using ### \`path\` format.`,
        maxSystemChars: 20_000,
        maxWorkspaceChars: 6_000,
      });

      const fixResponse = await callModel(model, fixMessages, stream, token, `integrator-fix-${attempt + 1}`);
      lastResponse = fixResponse;

      try {
        const fixResult = await applyCodeToWorkspace(fixResponse, stream);
        if (fixResult.written.length > 0) {
          writtenFiles.push(...fixResult.written);
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
      ...(buildResult ? { build_status: buildResult.success ? "passed" : `failed:${buildResult.errorCount}` } : {}),
      ...(buildResult && !buildResult.success ? { build_errors: formatBuildErrorsForLLM(buildResult) } : {}),
    },
    terminalResults,
  };
}
