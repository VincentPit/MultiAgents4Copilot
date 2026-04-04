/**
 * Planner agent — decomposes complex tasks into actionable steps.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage } from "../graph/state";
import { callModel, buildMessages } from "./base";

const SYSTEM_PROMPT = `You are the Planner agent on a multi-agent coding team.

Break the user's request into a clear, numbered step-by-step plan.

Rules:
1. Each step should be concrete and actionable.
2. Identify which agent owns each step (coder / researcher / reviewer).
3. Keep the plan concise - no more than 8 steps.
4. Format as a numbered markdown list.`;

export async function plannerNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  stream.markdown(
    `---\n\n` +
    `#### \u{1F4CB} Planner \u2014 Breaking down your task\n\n`
  );

  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: SYSTEM_PROMPT,
    workspaceContext: state.workspaceContext,
    userQuestion: lastUserMsg,
    maxSystemChars: 600,
    maxWorkspaceChars: 1200,
  });

  const response = await callModel(model, messages, stream, token, "planner");

  // Parse numbered lines
  const lines = response
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[\.\)]/.test(l));

  // Cap what we store in state.messages to avoid bloating context for downstream agents
  const cappedResponse = response.length > 1500
    ? response.slice(0, 1500) + "\n[… plan truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "planner",
    content: cappedResponse,
  };

  return {
    messages: [newMessage],
    plan: lines.length > 0 ? lines : [cappedResponse],
  };
}
