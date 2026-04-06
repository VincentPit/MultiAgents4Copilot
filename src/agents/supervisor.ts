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
  coder - writes/edits code for SIMPLE single-domain changes
  coder_pool - spawns PARALLEL domain coders for complex multi-file projects
  researcher - explains concepts, searches docs
  reviewer - reviews code quality
  integrator - merges outputs from parallel coders, writes glue code
  ui_designer - designs UI components
  test_gen - generates tests, writes test files, AND runs them

Capabilities:
  - coder, coder_pool, and test_gen can WRITE FILES directly to the workspace.
  - coder, coder_pool, and test_gen can RUN TERMINAL COMMANDS (with user approval).
  - This means the team can make REAL changes to the codebase.

Routing rules:
- New complex tasks: start with "planner".
- After plan exists: follow the plan's steps. Route agents listed in the current step.
- SIMPLE single-file changes: route to "coder".
- COMPLEX multi-file/multi-domain work (e.g. "build a REST API", "create a project",
  "refactor the architecture"): route to "coder_pool" instead of "coder".
- After coder_pool finishes: route to "integrator" to merge domain outputs.
- After integration and code is complete: route to "reviewer".
- If tasks need dependencies installed or builds run: route to "coder".
- If tests need to be written and executed: route to "test_gen".
- If reviewer approved: respond "FINISH".
- Simple questions: use "researcher".

PARALLEL EXECUTION:
  When multiple agents can work INDEPENDENTLY on the current step, list them
  separated by commas. Example: "researcher,coder" runs both at the same time.
  Only combine agents whose work does NOT depend on each other.

Reply with one or more agent names (comma-separated for parallel):
  planner | coder | coder_pool | researcher | reviewer | integrator | ui_designer | test_gen | FINISH
Examples: "planner", "coder_pool", "researcher,coder", "integrator", "FINISH"`;

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

  // Extract failed agent names from graph-router system messages
  const failedAgentNames = state.messages
    .filter(m => m.name === "graph-router")
    .flatMap(m => {
      const match = m.content.match(/Previously failed agents: \[([^\]]*)\]/);
      return match ? match[1].split(",").map(s => s.trim()).filter(Boolean) : [];
    })
    .filter((v, i, a) => a.indexOf(v) === i);

  const question =
    `Task: ${state.messages.find(m => m.role === "user")?.content ?? "unknown"}\n` +
    `Agents completed: ${completedAgents.join(", ") || "none"}\n` +
    `Plan exists: ${hasPlan ? "yes" : "no"}\n` +
    (hasPlan && state.planStep < state.plan.length
      ? `Current plan step (${state.planStep + 1}/${state.plan.length}): ${state.plan[state.planStep]}\n`
      : hasPlan ? `All ${state.plan.length} plan steps addressed.\n` : "") +
    (failedAgentNames.length > 0
      ? `FAILED AGENTS (do NOT route to these): ${failedAgentNames.join(", ")}\n`
      : "") +
    // ── Inject quality gate state so supervisor knows if code is broken ──
    (state.artifacts["quality_summary"]
      ? `Quality gate: ${state.artifacts["quality_summary"]}\n`
      : state.artifacts["build_status"]
      ? `Build status: ${state.artifacts["build_status"]}\n`
      : "") +
    (state.artifacts["quality_errors"]
      ? `⚠️ QUALITY GATE FAILED — code needs fixing before review.\n`
      : state.artifacts["build_errors"]
      ? `⚠️ BUILD HAS ERRORS — code needs fixing before review.\n`
      : "") +
    `Last output: ${lastSnippet}\n` +
    `Which agent(s) next? Use commas for parallel work.`;

  const messages = buildMessages({
    systemPrompt: SYSTEM_PROMPT,
    chatHistory: state.chatHistory,
    userQuestion: question,
    maxSystemChars: 2_000,
    maxWorkspaceChars: 0,
  });

  const response = await callModel(model, messages, null, token, "supervisor");
  const raw = response.trim().toLowerCase();

  const valid = new Set(["planner", "coder", "coder_pool", "researcher", "reviewer", "ui_designer", "test_gen", "integrator", "finish"]);

  // Parse comma-separated or single agent names
  const candidates = raw
    .split(/[,\s]+/)
    .map(s => s.replace(/[^a-z_]/g, ""))
    .filter(s => valid.has(s));

  let agents = candidates.length > 0 ? candidates : ["finish"];

  // Don't re-invoke planner if a plan already exists
  if (hasPlan) {
    agents = agents.filter(a => a !== "planner");
    if (agents.length === 0) { agents = ["coder"]; }
  }

  // Don't route to agents the graph has flagged as failed
  if (failedAgentNames.length > 0) {
    const before = agents.length;
    agents = agents.filter(a => !failedAgentNames.includes(a));
    if (agents.length === 0) {
      // Everything the LLM chose has failed — finish gracefully
      agents = ["finish"];
    } else if (agents.length < before) {
      logger.info("supervisor", `Filtered out failed agents: ${failedAgentNames.join(", ")}`);
    }
  }

  const isFinish = agents.length === 1 && agents[0] === "finish";
  const nextAgent = agents.join(","); // Store comma-separated for router

  logger.route("supervisor", nextAgent);

  if (isFinish) {
    return { nextAgent: "finish", status: "completed" };
  }

  // For multi-dispatch, also set pendingAgents
  const pendingAgents = agents.length > 1 ? agents : [];

  const icons: Record<string, string> = {
    planner: "\u{1F4CB}", coder: "\u{1F4BB}", coder_pool: "\u{1F3E2}", researcher: "\u{1F50D}", reviewer: "\u2705",
    ui_designer: "\u{1F3A8}", test_gen: "\u{1F9EA}", integrator: "\u{1F517}",
  };

  if (agents.length > 1) {
    const labels = agents.map(a => {
      const icon = icons[a] ?? "\u2699\uFE0F";
      return `${icon} **${a.charAt(0).toUpperCase() + a.slice(1)}**`;
    });
    stream.markdown(
      `\n> \u{1F9E0} **Supervisor** decided: parallel dispatch → ${labels.join(" + ")}\n\n`
    );
  } else {
    const icon = icons[agents[0]] ?? "\u2699\uFE0F";
    stream.markdown(
      `\n> \u{1F9E0} **Supervisor** decided: route to ${icon} **${agents[0].charAt(0).toUpperCase() + agents[0].slice(1)}**\n\n`
    );
  }

  return { nextAgent, pendingAgents };
}
