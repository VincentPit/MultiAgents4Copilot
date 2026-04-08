/**
 * Planner agent — decomposes complex tasks into actionable steps.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage } from "../graph/state";
import { callModel, buildMessages } from "./base";

/** Maximum characters stored for a plan response in state. */
export const MAX_PLAN_CHARS = 6_000;

/** Maximum numbered steps we'll keep from the planner output. */
export const MAX_PLAN_STEPS = 12;

const SYSTEM_PROMPT = `You are the Planner agent on a multi-agent coding team.

Break the user's request into a clear, numbered step-by-step plan.

Available agents:
  coder       - writes/edits code for single-domain changes
  coder_pool  - spawns parallel domain coders for multi-file projects
  reviewer    - reviews code quality
  integrator  - merges parallel coder outputs into cohesive codebase
  ui_designer - designs UI components
  test_gen    - generates and runs tests

Rules:
1. Each step should be concrete and actionable.
2. Tag each step with the agent(s) who should execute it, in parentheses at the start.
3. When multiple agents can work INDEPENDENTLY on a step, list them together: (coder, test_gen).
4. Keep the plan concise — no more than 8 steps.
5. Format as a numbered markdown list.

Examples:
  1. (coder_pool) Build the auth module, API routes, and data layer in parallel
  2. (integrator) Merge domain outputs and write shared types
  3. (reviewer) Review the implementation for security issues`;

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
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: lastUserMsg,
    maxSystemChars: 4_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(model, messages, stream, token, "planner");

  // Parse numbered lines and enforce step cap
  const lines = response
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[\.\)]/.test(l))
    .slice(0, MAX_PLAN_STEPS);

  // Cap what we store in state.messages to avoid bloating context for downstream agents
  const cappedResponse = response.length > MAX_PLAN_CHARS
    ? response.slice(0, MAX_PLAN_CHARS) + "\n[… plan truncated in state]"
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
