/**
 * Graph builder — assembles the agent graph and provides an executor.
 *
 * This is a lightweight state-machine executor (no LangGraph dependency).
 * Nodes are async functions; edges are determined by router functions.
 */

import * as vscode from "vscode";
import { AgentState, mergeState } from "./state";
import { routeSupervisor, routeReviewer } from "./router";
import { logger } from "../utils/logger";

/** An agent node: receives state + VS Code LM + chat stream, returns a partial state update. */
export type AgentNode = (
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) => Promise<Partial<AgentState>>;

interface GraphConfig {
  nodes: Record<string, AgentNode>;
  entryPoint: string;
  /** Max total node invocations to prevent infinite loops. */
  maxSteps: number;
}

/** Metadata about a single agent invocation. */
export interface AgentRun {
  name: string;
  durationMs: number;
}

/** Full result returned after the graph completes. */
export interface GraphResult {
  state: AgentState;
  agentRuns: AgentRun[];
  totalDurationMs: number;
  totalSteps: number;
}

/** Agent display config: icon + label. */
export const AGENT_DISPLAY: Record<string, { icon: string; label: string }> = {
  supervisor:  { icon: "🧠", label: "Supervisor" },
  planner:     { icon: "📋", label: "Planner" },
  coder:       { icon: "💻", label: "Coder" },
  researcher:  { icon: "🔍", label: "Researcher" },
  reviewer:    { icon: "✅", label: "Reviewer" },
  ui_designer: { icon: "🎨", label: "UI Designer" },
  test_gen:    { icon: "🧪", label: "Test Generator" },
};

/**
 * Build and return a compiled graph executor.
 */
export function buildGraph(config: GraphConfig) {
  const { nodes, entryPoint, maxSteps } = config;

  /**
   * Execute the graph to completion, streaming intermediate output
   * back to the Copilot chat panel with rich UI feedback.
   */
  async function run(
    initialState: AgentState,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<GraphResult> {
    let state = { ...initialState };
    let currentNode = entryPoint;
    let steps = 0;
    const agentRuns: AgentRun[] = [];
    const graphStart = Date.now();

    // Track consecutive failures to prevent supervisor→agent→fail loops
    const failedAgents = new Set<string>();

    while (currentNode !== "__end__" && steps < maxSteps) {
      if (token.isCancellationRequested) {
        state.status = "error";
        break;
      }

      const nodeFn = nodes[currentNode];
      if (!nodeFn) {
        stream.markdown(`\n\n> ⚠️ Unknown agent node: \`${currentNode}\`\n`);
        break;
      }

      const display = AGENT_DISPLAY[currentNode] ?? { icon: "⚙️", label: currentNode };

      // Show progress indicator at top of chat
      stream.progress(`${display.icon} Running ${display.label}…`);

      // Run the node with timing and error handling
      const nodeStart = Date.now();
      logger.agentStart(currentNode);
      let update: Partial<AgentState>;
      try {
        update = await nodeFn(state, model, stream, token);
        // Success — clear this agent from the failed set
        failedAgents.delete(currentNode);
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        logger.error(currentNode, `Agent failed: ${errMsg}`);
        stream.markdown(`\n\n> ⚠️ **${display.label}** encountered an error: ${errMsg}\n`);
        state.errors = [...(state.errors ?? []), `${currentNode}: ${errMsg}`];

        // Mark this agent as failed
        failedAgents.add(currentNode);

        // If 2+ agents have failed, or same agent failed, just finish
        if (failedAgents.size >= 2) {
          logger.warn("graph", `Multiple agents failed (${[...failedAgents].join(", ")}). Finishing.`);
          stream.markdown(`\n\n> ⚠️ Multiple agents failed. Finishing with available results.\n`);
          state.status = "completed";
          currentNode = "__end__";
          steps++;
          continue;
        }

        // Skip to supervisor to re-route, but tell it which agent failed
        state.nextAgent = "supervisor";
        state.errors = [...(state.errors ?? []), `DO_NOT_ROUTE:${currentNode}`];
        currentNode = "supervisor";
        steps++;
        continue;
      }
      const durationMs = Date.now() - nodeStart;
      logger.agentEnd(currentNode, durationMs);

      agentRuns.push({ name: currentNode, durationMs });
      state = mergeState(state, update);
      steps++;

      // Route to next node
      if (currentNode === "supervisor") {
        const nextNode = routeSupervisor(state);
        // If supervisor wants to route to a failed agent, force finish instead
        if (failedAgents.has(nextNode)) {
          logger.warn("graph", `Supervisor tried to route to failed agent "${nextNode}". Finishing.`);
          stream.markdown(`\n\n> ⚠️ Skipping **${nextNode}** (previously failed). Finishing with available results.\n`);
          currentNode = "__end__";
          state.status = "completed";
        } else {
          currentNode = nextNode;
        }
      } else if (currentNode === "reviewer") {
        currentNode = routeReviewer(state);
      } else {
        // All other agents route back to supervisor
        currentNode = "supervisor";
      }
    }

    if (steps >= maxSteps) {
      stream.markdown(
        `\n\n> ⚠️ Reached maximum step limit (${maxSteps}). Stopping.\n`
      );
      state.status = "completed";
    }

    return {
      state,
      agentRuns,
      totalDurationMs: Date.now() - graphStart,
      totalSteps: steps,
    };
  }

  return { run };
}
