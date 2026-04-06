/**
 * Coder agent — writes, edits, and generates code.
 *
 * Unlike a chat-only agent, the coder **actually applies changes to the
 * workspace** by parsing fenced code blocks from the LLM response and
 * writing them to disk via `vscode.workspace.fs`.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput, type CommandResult } from "../utils/terminalRunner";
import { runBuildValidation, formatBuildErrorsForLLM, type BuildResult } from "../utils/buildValidator";
import type { TerminalResult } from "../graph/state";

const SYSTEM_PROMPT = `You are the Coder agent — an expert software engineer who writes real files.

CRITICAL FORMAT RULES — follow these exactly so your code is applied to the workspace:

1. For EVERY file you create or modify, put the relative file path on its own line
   as a Markdown heading immediately before the fenced code block:

   ### \`src/utils/helper.ts\`
   \`\`\`typescript
   // full file contents here
   \`\`\`

2. Always use the RELATIVE path from the project root (e.g. \`src/foo.ts\`, not \`/Users/.../src/foo.ts\`).
3. Include the COMPLETE file contents — not just a diff or snippet.
4. Use the correct language tag on the code fence (typescript, python, etc.).
5. You may include brief explanations between file blocks, but every code block
   that should be written MUST be preceded by a heading with the file path.
6. Produce clean, idiomatic, well-commented code.
7. If a plan exists, follow it step by step.

TERMINAL COMMANDS — if your changes require running commands (e.g. installing
dependencies, building, running scripts), include them in a fenced \`\`\`bash block:

   \`\`\`bash
   npm install express
   npm run build
   \`\`\`

Commands will be executed in the workspace root after the user approves them.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself (src/agents/, src/graph/, src/utils/, src/security/,
src/types/, src/extension.ts, package.json, tsconfig.json, jest.config.js,
or any file in the extension's own project). You are that extension —
modifying your own source code causes corruption. If asked to work on "this"
extension, explain that self-modification is blocked for safety.`;

export async function coderNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const isRevision = !!state.artifacts["review_feedback"];
  const header = isRevision
    ? `---\n\n#### \u{1F4BB} Coder \u2014 Revision #${state.reviewCount + 1} (addressing feedback)\n\n`
    : `---\n\n#### \u{1F4BB} Coder \u2014 Writing code\n\n`;
  stream.markdown(header);

  // Build system prompt with capped sections
  let sysPrompt = SYSTEM_PROMPT;

  if (state.plan.length > 0) {
    sysPrompt += `\n\n## Plan\n${capContext(state.plan.join("\n"), 3000)}`;
  }
  if (state.artifacts["review_feedback"]) {
    sysPrompt += `\n\n## Reviewer Feedback\n${capContext(state.artifacts["review_feedback"], 2000)}`;
  }

  const incomingMsgs = getMessagesFor(state, "coder").slice(-2);
  if (incomingMsgs.length > 0) {
    const comms = incomingMsgs.map(m => `[${m.from}]: ${m.content.slice(0, 1500)}`).join("\n");
    sysPrompt += `\n\n## Agent Messages\n${comms}`;
  }

  const lastUserContent = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: lastUserContent,
    maxSystemChars: 12_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(model, messages, stream, token, "coder");

  postAgentMessage(state, "coder", "*", "info", response);
  logger.agentMessage("coder", "*", "Code posted to message bus");

  // ── Apply code blocks to the workspace ──────────────────────────────
  let writtenFiles: string[] = [];
  try {
    const result = await applyCodeToWorkspace(response, stream);
    writtenFiles = result.written;
    if (writtenFiles.length > 0) {
      logger.info("coder", `Applied ${writtenFiles.length} file(s) to workspace: ${writtenFiles.join(", ")}`);
    } else {
      logger.warn("coder", "No file blocks with paths found in LLM response — nothing written to disk");
    }
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    logger.error("coder", `File write failed: ${errMsg}`);
    stream.markdown(`\n> ⚠️ Failed to apply code changes: ${errMsg}\n`);
  }

  // ── Build validation + error-feedback retry loop ────────────────────
  // After writing files, validate the build. If errors are found, feed
  // them back to the LLM so it can self-correct. Max 2 retries.
  const MAX_FIX_RETRIES = 2;
  let buildResult: BuildResult | null = null;
  let lastResponse = response;

  if (writtenFiles.length > 0) {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      for (let attempt = 0; attempt <= MAX_FIX_RETRIES; attempt++) {
        if (token.isCancellationRequested) { break; }

        buildResult = await runBuildValidation(wsRoot);

        if (buildResult.success) {
          stream.markdown(`\n> ✅ **Build validation passed** — no compilation errors.\n`);
          break;
        }

        if (attempt >= MAX_FIX_RETRIES) {
          stream.markdown(
            `\n> ⚠️ **Build still failing** after ${MAX_FIX_RETRIES} fix attempt(s). ` +
            `${buildResult.errorCount} error(s) remain. Proceeding anyway.\n`
          );
          break;
        }

        // ── Feed errors back to the LLM for self-correction ──
        const errorReport = formatBuildErrorsForLLM(buildResult);
        stream.markdown(
          `\n> 🔧 **Build failed** (${buildResult.errorCount} error(s)) — ` +
          `asking coder to fix (attempt ${attempt + 1}/${MAX_FIX_RETRIES})…\n`
        );

        const fixMessages = buildMessages({
          systemPrompt: SYSTEM_PROMPT + `\n\n## BUILD ERRORS — FIX THESE NOW\n` +
            `Your previous code produced the following compilation errors.\n` +
            `Rewrite ONLY the files that have errors. Include the COMPLETE fixed file contents.\n` +
            `Do NOT re-output files that are already correct.\n\n` + errorReport,
          workspaceContext: state.workspaceContext,
          references: state.references,
          chatHistory: "",
          userQuestion: `Fix the ${buildResult.errorCount} build error(s) shown above. ` +
            `Output only the corrected files using ### \`path\` format.`,
          maxSystemChars: 16_000,
          maxWorkspaceChars: 6_000,
          maxReferencesChars: 6_000,
        });

        const fixResponse = await callModel(model, fixMessages, stream, token, `coder-fix-${attempt + 1}`);
        lastResponse = fixResponse;

        try {
          const fixResult = await applyCodeToWorkspace(fixResponse, stream);
          if (fixResult.written.length > 0) {
            writtenFiles.push(...fixResult.written);
            logger.info("coder", `Fix attempt ${attempt + 1}: wrote ${fixResult.written.length} file(s)`);
          }
        } catch (err: any) {
          logger.error("coder", `Fix attempt ${attempt + 1} file write failed: ${err?.message}`);
        }
      }
    }
  }

  // ── Run terminal commands from the LLM response ──────────────────────
  const terminalResults: TerminalResult[] = [];
  try {
    const cmdResult = await runCommandsFromOutput(response, stream);
    for (const executed of cmdResult.executed) {
      terminalResults.push({
        command: executed.command,
        success: executed.success,
        stdout: executed.stdout,
        stderr: executed.stderr,
        agent: "coder",
      });
    }
    if (cmdResult.executed.length > 0) {
      logger.info("coder", `Ran ${cmdResult.executed.length} command(s)`);
    }
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    logger.error("coder", `Terminal command execution failed: ${errMsg}`);
    stream.markdown(`\n> ⚠️ Failed to run terminal commands: ${errMsg}\n`);
  }

  const cappedResponse = lastResponse.length > 6000
    ? lastResponse.slice(0, 6000) + "\n[... code truncated in state]"
    : lastResponse;

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "coder",
    content: cappedResponse,
  };

  return {
    messages: [newMessage],
    artifacts: {
      last_code: lastResponse,
      ...(writtenFiles.length > 0 ? { written_files: writtenFiles.join(", ") } : {}),
      ...(terminalResults.length > 0 ? { terminal_output: terminalResults.map(r => `$ ${r.command} → ${r.success ? "OK" : "FAIL"}`).join("\n") } : {}),
      ...(buildResult ? { build_status: buildResult.success ? "passed" : `failed:${buildResult.errorCount}` } : {}),
      ...(buildResult && !buildResult.success ? { build_errors: formatBuildErrorsForLLM(buildResult) } : {}),
    },
    terminalResults,
  };
}
