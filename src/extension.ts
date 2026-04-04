/**
 * Extension entry point — registers the `@team` chat participant
 * and wires up the multi-agent graph.
 *
 * Usage in the Copilot panel:
 *   @team build a REST API for a todo app
 *   @team /plan migrate our auth to OAuth2
 *   @team /code fibonacci function in Rust
 *   @team /research how does React Server Components work
 *   @team /review <paste code>
 */

import * as vscode from "vscode";
import { buildGraph, AgentNode, GraphResult, AGENT_DISPLAY } from "./graph/builder";
import { createInitialState } from "./graph/state";
import { supervisorNode } from "./agents/supervisor";
import { plannerNode } from "./agents/planner";
import { coderNode } from "./agents/coder";
import { researcherNode } from "./agents/researcher";
import { reviewerNode } from "./agents/reviewer";
import { uiDesigner } from "./agents/ui_designer";
import { testGen } from "./agents/tester";
import { logger } from "./utils/logger";

const PARTICIPANT_ID = "multi-agent-copilot.team";

export function activate(context: vscode.ExtensionContext) {
  const agent = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  agent.iconPath = new vscode.ThemeIcon("hubot");
  context.subscriptions.push(agent);
  logger.info("extension", "Multi-Agent Copilot activated");
}

// ── Agent node map ────────────────────────────────────────────────────

const AGENT_NODES: Record<string, AgentNode> = {
  supervisor: supervisorNode,
  planner: plannerNode,
  coder: coderNode,
  researcher: researcherNode,
  reviewer: reviewerNode,
  ui_designer: uiDesigner,
  test_gen: testGen,
};

// ── Chat handler ──────────────────────────────────────────────────────

const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> => {
  // 1. Select Claude Opus 4.6 via Copilot
  const [model] = await vscode.lm.selectChatModels({
    vendor: "copilot",
    family: "claude-opus-4.6",
  });

  if (!model) {
    stream.markdown(
      "⚠️ **No Copilot model available.** Make sure GitHub Copilot Chat is installed and you're signed in."
    );
    return;
  }

  // 2. Slash command → direct single-agent mode
  if (request.command) {
    await handleDirectCommand(request, model, stream, token);
    return;
  }

  // 3. Full graph execution
  await runGraph(request.prompt, model, stream, token);
};

// ── Direct command handler ────────────────────────────────────────────

async function handleDirectCommand(
  request: vscode.ChatRequest,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const state = createInitialState(request.prompt);
  const command = request.command!;

  const commandToAgent: Record<string, string> = {
    plan: "planner",
    code: "coder",
    research: "researcher",
    review: "reviewer",
    design: "ui_designer",
    test: "test_gen",
  };

  const agentName = commandToAgent[command];
  const agentFn = agentName ? AGENT_NODES[agentName] : undefined;

  if (!agentFn || !agentName) {
    stream.markdown(`> ⚠️ Unknown command: \`/${command}\``);
    return;
  }

  const display = AGENT_DISPLAY[agentName] ?? { icon: "⚙️", label: agentName };

  // ── Header ──
  stream.markdown(
    `## ${display.icon} Direct Mode — ${display.label}\n\n` +
    `> Running \`/${command}\` without supervisor routing\n\n` +
    `---\n\n`
  );

  const start = Date.now();
  await agentFn(state, model, stream, token);
  const ms = Date.now() - start;

  // ── Footer ──
  stream.markdown(
    `\n\n---\n` +
    `> ${display.icon} **${display.label}** completed in **${formatDuration(ms)}**\n`
  );
}

// ── Full graph execution with rich UI ────────────────────────────────

async function runGraph(
  prompt: string,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const state = createInitialState(prompt);

  const graph = buildGraph({
    nodes: AGENT_NODES,
    entryPoint: "supervisor",
    maxSteps: 15,
  });

  // ── Opening banner ──
  stream.markdown(
    `## 🤖 Multi-Agent Team\n\n` +
    `| Agent | Role |\n` +
    `|-------|------|\n` +
    `| 🧠 Supervisor | Routes your request to the right specialist |\n` +
    `| 📋 Planner | Breaks complex tasks into steps |\n` +
    `| 💻 Coder | Writes & edits code |\n` +
    `| 🔍 Researcher | Explains concepts & finds information |\n` +
    `| 🎨 UI Designer | Designs interfaces & components (Gemini 3 Pro) |\n` +
    `| 🧪 Test Generator | Creates comprehensive test suites |\n` +
    `| ✅ Reviewer | Reviews code for quality & correctness |\n\n` +
    `---\n\n` +
    `### 🔄 Execution\n\n`
  );

  // ── Run the graph ──
  const result: GraphResult = await graph.run(state, model, stream, token);

  // ── Summary panel ──
  renderSummary(stream, result);
}

// ── Summary renderer ─────────────────────────────────────────────────

function renderSummary(stream: vscode.ChatResponseStream, result: GraphResult): void {
  const { agentRuns, totalDurationMs, totalSteps } = result;

  // Build the agent flow pipeline (skip supervisor from the visual flow)
  const workerRuns = agentRuns.filter((r) => r.name !== "supervisor");
  const flowLine = workerRuns
    .map((r) => {
      const d = AGENT_DISPLAY[r.name] ?? { icon: "⚙️", label: r.name };
      return `${d.icon} ${d.label}`;
    })
    .join("  →  ");

  // Build timing breakdown
  const timingRows = workerRuns.map((r) => {
    const d = AGENT_DISPLAY[r.name] ?? { icon: "⚙️", label: r.name };
    return `| ${d.icon} ${d.label} | ${formatDuration(r.durationMs)} |`;
  });

  const statusEmoji = result.state.status === "completed" ? "✅" : "⚠️";
  const statusLabel = result.state.status === "completed" ? "Completed" : "Stopped";

  stream.markdown(
    `\n\n---\n\n` +
    `### 📊 Summary\n\n` +
    `**Status:** ${statusEmoji} ${statusLabel}\n\n` +
    `**Agent flow:**\n> ${flowLine || "_(no worker agents ran)_"}\n\n` +
    `**Performance:**\n\n` +
    `| Agent | Time |\n` +
    `|-------|------|\n` +
    timingRows.join("\n") + "\n" +
    `| **Total** | **${formatDuration(totalDurationMs)}** |\n\n` +
    `> 🔢 ${totalSteps} graph steps · ` +
    `${workerRuns.length} agent invocations · ` +
    `${result.state.reviewCount} review cycles\n`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function deactivate() {
  logger.dispose();
}

