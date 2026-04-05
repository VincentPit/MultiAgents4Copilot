/**
 * Reviewer agent — reviews code for correctness, quality, and completeness.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";

const MAX_REVIEWS = 3;

const SYSTEM_PROMPT = `You are the Reviewer agent \u2014 a senior code reviewer.

Examine the code and evaluate on:
1. Correctness \u2014 Does it solve the stated problem?
2. Quality \u2014 Clean, readable, idiomatic?
3. Edge cases \u2014 Error handling?
4. Security \u2014 Any obvious issues?

At the END of your review, output exactly one verdict on its own line:
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
    `#### \u{2705} Reviewer \u{2014} Code review (cycle ${cycle}/${MAX_REVIEWS})\n\n`
  );

  const code = capContext(state.artifacts["last_code"] ?? "No code produced yet.", 12_000);
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  // Build system prompt with code to review embedded
  const sysPrompt = SYSTEM_PROMPT + `\n\n## Code to Review\n\`\`\`\n${code}\n\`\`\``;

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    userQuestion: lastUserMsg || "Review the code above",
    maxSystemChars: 16_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(model, messages, stream, token, "reviewer");

  const approved = response.toUpperCase().includes("VERDICT: APPROVE");
  const newCount = state.reviewCount + 1;
  const forceApprove = newCount >= MAX_REVIEWS;

  const cappedResponse = response.length > 6000
    ? response.slice(0, 6000) + "\n[... review truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "reviewer",
    content: cappedResponse,
  };

  if (approved || forceApprove) {
    if (forceApprove && !approved) {
      stream.markdown(
        `\n\n> \u{26A1} Max review iterations (${MAX_REVIEWS}) reached \u{2014} auto-approving.\n`
      );
    } else {
      stream.markdown(`\n\n> \u{2705} **APPROVED** \u{2014} Code passes review.\n`);
    }
    return {
      messages: [newMessage],
      reviewCount: newCount,
      reviewVerdict: "approve",
      finalAnswer: state.artifacts["last_code"] ?? response,
      status: "completed",
    };
  }

  // Revise
  stream.markdown(`\n\n> \u{1F501} **REVISE** \u{2014} Sending feedback back to \u{1F4BB} **Coder** for another pass\u{2026}\n`);
  postAgentMessage(state, "reviewer", "coder", "request", capContext(response, 4_000));
  logger.agentMessage("reviewer", "coder", "Revision feedback posted");
  return {
    messages: [newMessage],
    reviewCount: newCount,
    reviewVerdict: "revise",
    artifacts: { review_feedback: capContext(response, 4_000) },
    nextAgent: "coder",
  };
}
