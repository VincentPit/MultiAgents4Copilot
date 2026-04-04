/**
 * Coder agent — writes, edits, and generates code.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are the Coder agent - an expert software engineer.

Write or update code to satisfy the request.

Rules:
1. Produce clean, idiomatic, well-commented code.
2. If a plan exists, follow it step by step.
3. Wrap code in fenced code blocks with the correct language tag.
4. State file paths clearly.
5. Explain key design decisions briefly.`;

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
    sysPrompt += `\n\n## Plan\n${capContext(state.plan.join("\n"), 600)}`;
  }
  if (state.artifacts["review_feedback"]) {
    sysPrompt += `\n\n## Reviewer Feedback\n${capContext(state.artifacts["review_feedback"], 400)}`;
  }

  const incomingMsgs = getMessagesFor(state, "coder").slice(-2);
  if (incomingMsgs.length > 0) {
    const comms = incomingMsgs.map(m => `[${m.from}]: ${m.content.slice(0, 200)}`).join("\n");
    sysPrompt += `\n\n## Agent Messages\n${comms}`;
  }

  const lastUserContent = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  // Single consolidated User message - no consecutive same-role messages
  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    userQuestion: lastUserContent,
    maxSystemChars: 2000,
    maxWorkspaceChars: 1000,
  });

  const response = await callModel(model, messages, stream, token, "coder");

  postAgentMessage(state, "coder", "*", "info", response);
  logger.agentMessage("coder", "*", "Code posted to message bus");

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "coder",
    content: response.length > 1500 ? response.slice(0, 1500) + "\n[... code truncated in state]" : response,
  };

  return {
    messages: [newMessage],
    artifacts: { last_code: response },
  };
}
