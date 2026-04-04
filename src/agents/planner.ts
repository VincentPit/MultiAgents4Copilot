/**
 * Planner agent — decomposes complex tasks into actionable steps.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget, capContext } from "./base";

const SYSTEM_PROMPT = `You are the Planner agent on a multi-agent coding team.

Your job is to take a user's request and break it into a clear, numbered
step-by-step plan that the other agents (coder, researcher, reviewer) can follow.

Rules:
1. Each step should be concrete and actionable.
2. Identify which agent should own each step (coder / researcher / reviewer).
3. Keep the plan concise — no more than 8 steps.
4. Format as a numbered markdown list.`;

export async function plannerNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  stream.markdown(
    `---\n\n` +
    `#### 📋 Planner — Breaking down your task\n\n`
  );

  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(SYSTEM_PROMPT)];

  if (state.workspaceContext) {
    messages.push(userMsg(`[WORKSPACE CONTEXT]\n${capContext(state.workspaceContext, 2000)}`));
  }

  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  const response = await callModel(model, truncateMessages(messages, safeBudget(model)), stream, token, "planner");

  // Parse numbered lines
  const lines = response
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[\.\)]/.test(l));

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "planner",
    content: response,
  };

  return {
    messages: [newMessage],
    plan: lines.length > 0 ? lines : [response],
  };
}
