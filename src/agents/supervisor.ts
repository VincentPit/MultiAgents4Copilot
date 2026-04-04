/**
 * Supervisor agent — inspects the conversation and decides which
 * specialist agent should act next.
 */

import * as vscode from "vscode";
import { AgentState } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget, capContext } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are the Supervisor of a multi-agent coding team.

Your team members are:
  \u2022 planner     \u2013 breaks complex tasks into step-by-step plans
  \u2022 coder       \u2013 writes, edits, and generates code
  \u2022 researcher  \u2013 searches documentation or explains concepts
  \u2022 reviewer    \u2013 reviews code for correctness and quality
  \u2022 ui_designer \u2013 designs UI components, layouts, and styling (uses Gemini 3 Pro)
  \u2022 test_gen    \u2013 generates unit tests, integration tests, and test suites

Given the conversation so far, decide which agent should act NEXT.
If the task is fully complete, respond with "FINISH".

Rules:
- For new complex tasks, start with "planner".
- After a plan is made, route to "coder", "ui_designer", or "researcher" as needed.
- If the task involves UI/frontend design or components, use "ui_designer".
- After code is written, route to "test_gen" to generate tests, then "reviewer".
- If the reviewer approved, respond with "FINISH".
- For simple questions or explanations, use "researcher".
- Agents can read messages from each other \u2014 use the right agent for the right job.

Respond with ONLY one word \u2014 the agent name or FINISH:
  planner | coder | researcher | reviewer | ui_designer | test_gen | FINISH`;

export async function supervisorNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  // Build the conversation context for the supervisor
  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(SYSTEM_PROMPT)];

  // Inject workspace context so supervisor knows about the codebase
  if (state.workspaceContext) {
    messages.push(userMsg(`[WORKSPACE CONTEXT]\n${capContext(state.workspaceContext, 1500)}`));
  }

  // Only include the last few messages — supervisor just needs to pick an agent
  const recentMsgs = state.messages.slice(-3);
  for (const msg of recentMsgs) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      const label = msg.name ? `[${msg.name}] ` : "";
      // Cap each assistant message to 300 chars for supervisor routing
      const content = label + (msg.content.length > 300 ? msg.content.slice(0, 300) + "…" : msg.content);
      messages.push(assistantMsg(content));
    }
  }

  messages.push(userMsg("Which agent should act next? Reply with ONE word only."));

  // Don't stream supervisor reasoning to the user (pass null)
  const response = await callModel(model, truncateMessages(messages, safeBudget(model)), null, token, "supervisor");
  const decision = response.trim().toLowerCase().replace(/[^a-z]/g, "");

  const valid = new Set(["planner", "coder", "researcher", "reviewer", "ui_designer", "test_gen", "finish"]);
  const nextAgent = valid.has(decision) ? decision : "finish";

  logger.route("supervisor", nextAgent);

  if (nextAgent === "finish") {
    return { nextAgent: "finish", status: "completed" };
  }

  // Show routing decision as a visual indicator
  const icons: Record<string, string> = {
    planner: "📋", coder: "💻", researcher: "🔍", reviewer: "✅"
  };
  const icon = icons[nextAgent] ?? "⚙️";
  stream.markdown(
    `\n> 🧠 **Supervisor** decided: route to ${icon} **${nextAgent.charAt(0).toUpperCase() + nextAgent.slice(1)}**\n\n`
  );

  return { nextAgent };
}
