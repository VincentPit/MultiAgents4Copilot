/**
 * Supervisor agent - decides which specialist agent should act next.
 */

import * as vscode from "vscode";
import { AgentState } from "../graph/state";
import { callModel, buildMessages } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are the Supervisor of a multi-agent coding team.

Your team:
  planner - breaks tasks into step-by-step plans
  coder - writes and edits code
  researcher - explains concepts, searches docs
  reviewer - reviews code quality
  ui_designer - designs UI components
  test_gen - generates tests

Rules:
- New complex tasks: start with "planner".
- After plan exists: route to "coder" or "researcher". NEVER "planner" again.
- After code is written: route to "reviewer".
- If reviewer approved: respond "FINISH".
- Simple questions: use "researcher".

Reply with ONLY one word: planner | coder | researcher | reviewer | ui_designer | test_gen | FINISH`;

export async function supervisorNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const completedAgents = state.messages
    .filter(m => m.name)
    .map(m => m.name!)
    .filter((v, i, a) => a.indexOf(v) === i);

  const hasPlan = state.plan.length > 0;
  const lastMsg = state.messages[state.messages.length - 1];
  const lastSnippet = lastMsg
    ? `[${lastMsg.name ?? lastMsg.role}]: ${lastMsg.content.slice(0, 150)}`
    : "none";

  const question =
    `Task: ${state.messages.find(m => m.role === "user")?.content ?? "unknown"}\n` +
    `Agents completed: ${completedAgents.join(", ") || "none"}\n` +
    `Plan exists: ${hasPlan ? "yes" : "no"}\n` +
    `Last output: ${lastSnippet}\n` +
    `Which agent next? One word only.`;

  const messages = buildMessages({
    systemPrompt: SYSTEM_PROMPT,
    userQuestion: question,
    maxSystemChars: 600,
    maxWorkspaceChars: 0,
  });

  const response = await callModel(model, messages, null, token, "supervisor");
  const decision = response.trim().toLowerCase().replace(/[^a-z_]/g, "");

  const valid = new Set(["planner", "coder", "researcher", "reviewer", "ui_designer", "test_gen", "finish"]);
  let nextAgent = valid.has(decision) ? decision : "finish";

  if (nextAgent === "planner" && hasPlan) {
    logger.warn("supervisor", "Plan already exists, routing to coder instead");
    nextAgent = "coder";
  }

  logger.route("supervisor", nextAgent);

  if (nextAgent === "finish") {
    return { nextAgent: "finish", status: "completed" };
  }

  const icons: Record<string, string> = {
    planner: "\u{1F4CB}", coder: "\u{1F4BB}", researcher: "\u{1F50D}", reviewer: "\u2705",
    ui_designer: "\u{1F3A8}", test_gen: "\u{1F9EA}",
  };
  const icon = icons[nextAgent] ?? "\u2699\uFE0F";
  stream.markdown(
    `\n> \u{1F9E0} **Supervisor** decided: route to ${icon} **${nextAgent.charAt(0).toUpperCase() + nextAgent.slice(1)}**\n\n`
  );

  return { nextAgent };
}
