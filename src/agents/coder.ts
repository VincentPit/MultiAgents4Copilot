/**
 * Coder agent — writes, edits, and generates code.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are the Coder agent — an expert software engineer.

Given the conversation, plan, and any prior feedback from the reviewer,
write or update code to satisfy the request.

Rules:
1. Produce clean, idiomatic, well-commented code.
2. If a plan exists, follow it step by step.
3. Wrap code in fenced code blocks with the correct language tag.
4. If you create/edit files, state the file path clearly.
5. Explain key design decisions briefly.`;

export async function coderNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const isRevision = !!state.artifacts["review_feedback"];
  const header = isRevision
    ? `---\n\n#### 💻 Coder — Revision #${state.reviewCount + 1} (addressing feedback)\n\n`
    : `---\n\n#### 💻 Coder — Writing code\n\n`;
  stream.markdown(header);

  let systemPrompt = SYSTEM_PROMPT;

  // Inject workspace context so coder can see the actual files
  if (state.workspaceContext) {
    systemPrompt += `\n\n${state.workspaceContext}`;
  }

  if (state.plan.length > 0) {
    systemPrompt += `\n\n## Current Plan\n${state.plan.join("\n")}`;
  }
  if (state.artifacts["review_feedback"]) {
    systemPrompt += `\n\n## Reviewer Feedback (address this)\n${state.artifacts["review_feedback"]}`;
  }

  // Check for inter-agent messages addressed to coder
  const incomingMsgs = getMessagesFor(state, "coder");
  if (incomingMsgs.length > 0) {
    const commsContext = incomingMsgs.map(m => `[From ${m.from}]: ${m.content}`).join("\n");
    systemPrompt += `\n\n## Messages from other agents\n${commsContext}`;
  }

  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(systemPrompt)];
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  const response = await callModel(model, truncateMessages(messages, safeBudget(model)), stream, token, "coder");

  // Post code to the message bus so other agents can read it
  postAgentMessage(state, "coder", "*", "info", response);
  logger.agentMessage("coder", "*", "Code posted to message bus");

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "coder",
    content: response,
  };

  return {
    messages: [newMessage],
    artifacts: { last_code: response },
  };
}
