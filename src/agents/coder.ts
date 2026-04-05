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

Commands will be executed in the workspace root after the user approves them.`;

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

  // Single consolidated User message - no consecutive same-role messages
  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    userQuestion: lastUserContent,
    maxSystemChars: 12_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(model, messages, stream, token, "coder");

  postAgentMessage(state, "coder", "*", "info", response);
  logger.agentMessage("coder", "*", "Code posted to message bus");

  // ── Apply code blocks to the workspace ──────────────────────────────
  // Parse fenced code blocks from the LLM response, extract file paths,
  // and write them to disk. This is the key difference from a chat-only agent.
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
  // ── Run terminal commands from the LLM response ──────────────────────
  // Parse fenced bash/shell blocks and execute them with user consent.
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
  const newMessage: AgentMessage = {
    role: "assistant",
    name: "coder",
    content: response.length > 6000 ? response.slice(0, 6000) + "\n[... code truncated in state]" : response,
  };

  return {
    messages: [newMessage],
    artifacts: {
      last_code: response,
      ...(writtenFiles.length > 0 ? { written_files: writtenFiles.join(", ") } : {}),
      ...(terminalResults.length > 0 ? { terminal_output: terminalResults.map(r => `$ ${r.command} → ${r.success ? "OK" : "FAIL"}`).join("\n") } : {}),
    },
    terminalResults,
  };
}
