/**
 * Coder agent — writes, edits, and generates code.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget, capContext } from "./base";
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

  // Inject workspace context — small cap since code prompts are large
  if (state.workspaceContext) {
    systemPrompt += `\n\n${capContext(state.workspaceContext, 1200)}`;
  }

  // Inject plan — cap to 800 chars
  if (state.plan.length > 0) {
    const planText = state.plan.join("\n");
    systemPrompt += `\n\n## Current Plan\n${capContext(planText, 800)}`;
  }

  // Inject reviewer feedback — cap to 500 chars
  if (state.artifacts["review_feedback"]) {
    systemPrompt += `\n\n## Reviewer Feedback\n${capContext(state.artifacts["review_feedback"], 500)}`;
  }

  // Inter-agent messages — only last 2, capped
  const incomingMsgs = getMessagesFor(state, "coder").slice(-2);
  if (incomingMsgs.length > 0) {
    const commsContext = incomingMsgs.map(m => `[${m.from}]: ${capContext(m.content, 300)}`).join("\n");
    systemPrompt += `\n\n## Agent Messages\n${commsContext}`;
  }

  // Hard-cap the entire system prompt to ~1500 tokens
  if (systemPrompt.length > 6000) {
    systemPrompt = systemPrompt.slice(0, 6000) + "\n[… prompt truncated]";
  }

  // Build messages: system + ONLY the last user message (not full history)
  const lastUserContent = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";
  const messages: vscode.LanguageModelChatMessage[] = [
    sysMsg(systemPrompt),
    userMsg(lastUserContent),
  ];

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
