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

  // Post to message bus
  const cappedResponse =
    response.length > 6_000
      ? response.slice(0, 6_000) + "\n[… truncated in state]"
      : response;

  // ── Apply integration files ──
  let writtenFiles: string[] = [];
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

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "integrator",
    content: cappedResponse,
  };

  return {
    messages: [newMessage],
    artifacts: {
      integration_report: cappedResponse,
      ...(writtenFiles.length > 0
        ? { integration_files: writtenFiles.join(", ") }
        : {}),
    },
    terminalResults,
  };
}
