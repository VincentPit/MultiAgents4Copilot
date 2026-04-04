/**
 * Reviewer agent — reviews code for correctness, quality, and completeness.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, ReviewVerdict, postAgentMessage } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget } from "./base";
import { logger } from "../utils/logger";

const MAX_REVIEWS = 3;

const SYSTEM_PROMPT = `You are the Reviewer agent — a senior code reviewer.

Examine the latest code produced by the coder and evaluate it on:
1. **Correctness** – Does it solve the stated problem?
2. **Quality** – Is it clean, readable, and idiomatic?
3. **Edge cases** – Are error/edge cases handled?
4. **Security** – Any obvious security issues?

At the END of your review, output exactly one of these verdicts on its own line:
  VERDICT: APPROVE
  VERDICT: REVISE

If REVISE, explain concisely what must change.`;

export async function reviewerNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const cycle = state.reviewCount + 1;
  stream.markdown(
    `---\n\n` +
    `#### ✅ Reviewer — Code review (cycle ${cycle}/${MAX_REVIEWS})\n\n`
  );

  const code = state.artifacts["last_code"] ?? "No code produced yet.";

  const messages: vscode.LanguageModelChatMessage[] = [
    sysMsg(SYSTEM_PROMPT),
  ];

  if (state.workspaceContext) {
    messages.push(userMsg(`[WORKSPACE CONTEXT]\n${state.workspaceContext}`));
  }

  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  messages.push(userMsg(`## Code to Review\n\n${code}`));

  const response = await callModel(model, truncateMessages(messages, safeBudget(model)), stream, token, "reviewer");

  const approved = response.toUpperCase().includes("VERDICT: APPROVE");
  const newCount = state.reviewCount + 1;
  const forceApprove = newCount >= MAX_REVIEWS;

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "reviewer",
    content: response,
  };

  if (approved || forceApprove) {
    if (forceApprove && !approved) {
      stream.markdown(
        `\n\n> ⚡ Max review iterations (${MAX_REVIEWS}) reached — auto-approving.\n`
      );
    } else {
      stream.markdown(`\n\n> \u2705 **APPROVED** \u2014 Code passes review.\n`);
    }
    return {
      messages: [newMessage],
      reviewCount: newCount,
      reviewVerdict: "approve",
      finalAnswer: state.artifacts["last_code"] ?? response,
      status: "completed",
    };
  }

  // Revise \u2014 send feedback back to coder on next loop
  stream.markdown(`\n\n> \ud83d\udd01 **REVISE** \u2014 Sending feedback back to \ud83d\udcbb **Coder** for another pass\u2026\n`);
  postAgentMessage(state, "reviewer", "coder", "request", response);
  logger.agentMessage("reviewer", "coder", "Revision feedback posted");
  return {
    messages: [newMessage],
    reviewCount: newCount,
    reviewVerdict: "revise",
    artifacts: { review_feedback: response },
    nextAgent: "coder",
  };
}
