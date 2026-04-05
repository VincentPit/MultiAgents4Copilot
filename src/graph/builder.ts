/**
 * Graph builder — assembles the agent graph and provides an executor.
 *
 * This is a DAG executor supporting:
 *   • Sequential execution — one agent at a time
 *   • Parallel fan-out    — multiple agents run concurrently (Promise.allSettled)
 *   • Plan-driven routing — planner output drives which agents execute
 *   • Conditional edges   — reviewer verdict determines next step
 *
 * No LangGraph dependency — lightweight state-machine with parallel support.
 */

import * as vscode from "vscode";
import { AgentState, mergeState, frozenSnapshot } from "./state";
import { routeSupervisor, routeReviewer, routeFromPlan, type RouteResult } from "./router";
import { logger } from "../utils/logger";
import { getSecurityConfig } from "../security/securityConfig";

/** Per-agent execution timeout (ms). If an agent takes longer, it's aborted. */
const AGENT_TIMEOUT_MS = 120_000; // 2 minutes

/** Wall-clock timeout for the entire graph run (ms). */
const GRAPH_WALL_CLOCK_MS = 600_000; // 10 minutes

/** Maximum accumulated errors before force-finishing. */
const MAX_ERROR_COUNT = 10;

/** Maximum state size in characters (rough JSON.stringify length). */
const MAX_STATE_SIZE_CHARS = 2_000_000; // ~2 MB

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
  /** Whether this agent ran in parallel with others. */
  parallel?: boolean;
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
  coder_pool:  { icon: "🏢", label: "Engineering Team" },
  researcher:  { icon: "🔍", label: "Researcher" },
  reviewer:    { icon: "✅", label: "Reviewer" },
  integrator:  { icon: "🔗", label: "Integration Engineer" },
  ui_designer: { icon: "🎨", label: "UI Designer" },
  test_gen:    { icon: "🧪", label: "Test Generator" },
};

/**
 * Build and return a compiled graph executor.
 */
export function buildGraph(config: GraphConfig) {
  const { nodes, entryPoint, maxSteps } = config;

  /**
   * Run a single agent node with timing and error handling.
   */
  async function runNode(
    name: string,
    state: AgentState,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<{ update: Partial<AgentState>; durationMs: number; error?: string }> {
    const nodeFn = nodes[name];
    if (!nodeFn) {
      return { update: {}, durationMs: 0, error: `Unknown agent node: ${name}` };
    }

    const start = Date.now();
    logger.agentStart(name);
    try {
      // Race agent execution against a timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Agent "${name}" timed out after ${AGENT_TIMEOUT_MS}ms`)), AGENT_TIMEOUT_MS);
      });

      const update = await Promise.race([
        nodeFn(state, model, stream, token),
        timeoutPromise,
      ]);

      const durationMs = Date.now() - start;
      logger.agentEnd(name, durationMs);
      return { update, durationMs };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errMsg = err?.message ?? String(err);
      logger.error(name, `Agent failed: ${errMsg}`);
      return { update: {}, durationMs, error: errMsg };
    }
  }

  /**
   * Execute multiple agents in parallel using Promise.allSettled.
   * Each agent gets a snapshot of the current state (no cross-contamination).
   * Results are merged sequentially after all complete.
   */
  async function runParallel(
    agentNames: string[],
    state: AgentState,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<{ mergedUpdate: Partial<AgentState>; runs: AgentRun[]; errors: string[] }> {
    const labels = agentNames.map(n => {
      const d = AGENT_DISPLAY[n] ?? { icon: "⚙️", label: n };
      return `${d.icon} ${d.label}`;
    });

    stream.markdown(
      `\n> 🔀 **Parallel execution:** ${labels.join(" + ")}\n\n`
    );

    // Launch all agents concurrently with an immutable state snapshot
    const stateSnapshot = frozenSnapshot(state);
    const promises = agentNames.map(name =>
      runNode(name, stateSnapshot, model, stream, token)
    );

    const results = await Promise.allSettled(promises);

    // Collect results and merge
    const runs: AgentRun[] = [];
    const errors: string[] = [];
    let merged: Partial<AgentState> = {};

    for (let i = 0; i < results.length; i++) {
      const name = agentNames[i];
      const result = results[i];

      if (result.status === "fulfilled") {
        const { update, durationMs, error } = result.value;
        runs.push({ name, durationMs, parallel: true });

        if (error) {
          const display = AGENT_DISPLAY[name] ?? { icon: "⚙️", label: name };
          stream.markdown(`\n> ⚠️ **${display.label}** encountered an error: ${error}\n`);
          errors.push(`${name}: ${error}`);
        } else {
          // Merge this agent's update into the accumulated partial
          merged = mergePartials(merged, update);
        }
      } else {
        // Promise rejected (shouldn't happen since runNode catches, but just in case)
        const errMsg = result.reason?.message ?? String(result.reason);
        errors.push(`${name}: ${errMsg}`);
        runs.push({ name, durationMs: 0, parallel: true });
      }
    }

    stream.markdown(
      `\n> ✅ **Parallel batch complete:** ${runs.filter(r => !errors.some(e => e.startsWith(r.name))).map(r => {
        const d = AGENT_DISPLAY[r.name] ?? { icon: "⚙️", label: r.name };
        return d.icon;
      }).join(" ")} finished\n\n`
    );

    return { mergedUpdate: merged, runs, errors };
  }

  /**
   * Execute the graph to completion, supporting both sequential
   * and parallel agent execution.
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

    // Track consecutive failures to prevent loops
    const failedAgents = new Set<string>();
    // Track consecutive same-agent runs to detect loops
    let lastAgent = "";
    let consecutiveCount = 0;
    const MAX_CONSECUTIVE = 3; // same non-supervisor agent 3× in a row = stuck

    while (currentNode !== "__end__" && steps < maxSteps) {
      // ── Wall-clock timeout ──
      if (Date.now() - graphStart > GRAPH_WALL_CLOCK_MS) {
        logger.warn("graph", `Wall-clock timeout reached (${GRAPH_WALL_CLOCK_MS}ms)`);
        stream.markdown(`\n\n> ⚠️ Reached wall-clock time limit. Stopping.\n`);
        state.status = "completed";
        break;
      }

      // ── Error accumulation cap ──
      if ((state.errors?.length ?? 0) >= MAX_ERROR_COUNT) {
        logger.warn("graph", `Error accumulation cap reached (${state.errors.length} errors)`);
        stream.markdown(`\n\n> ⚠️ Too many errors accumulated (${state.errors.length}). Stopping.\n`);
        state.status = "error";
        break;
      }

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
      stream.progress(`${display.icon} Running ${display.label}…`);

      // ── Run the current node ──
      const { update, durationMs, error } = await runNode(currentNode, state, model, stream, token);

      if (error) {
        stream.markdown(`\n\n> ⚠️ **${display.label}** encountered an error: ${error}\n`);
        state.errors = [...(state.errors ?? []), `${currentNode}: ${error}`];
        failedAgents.add(currentNode);

        if (failedAgents.size >= 2) {
          stream.markdown(`\n\n> ⚠️ Multiple agents failed. Finishing with available results.\n`);
          state.status = "completed";
          currentNode = "__end__";
          steps++;
          continue;
        }

        // Re-route through supervisor
        state.nextAgent = "supervisor";
        state.errors = [...(state.errors ?? []), `DO_NOT_ROUTE:${currentNode}`];
        currentNode = "supervisor";
        steps++;
        continue;
      }

      failedAgents.delete(currentNode);
      agentRuns.push({ name: currentNode, durationMs });
      state = mergeState(state, update);
      steps++;

      // ── State size guard ──
      try {
        const stateSize = JSON.stringify(state).length;
        if (stateSize > MAX_STATE_SIZE_CHARS) {
          logger.warn("graph", `State size ${stateSize} exceeds limit ${MAX_STATE_SIZE_CHARS} — trimming messages`);
          // Trim oldest non-user messages to bring size down
          const userMsgs = state.messages.filter((m: { role: string }) => m.role === "user");
          const recentMsgs = state.messages.slice(-20);
          state.messages = [...userMsgs.slice(0, 1), ...recentMsgs];
        }
      } catch {
        logger.warn("graph", "State is not JSON-serializable — possible corruption");
      }

      // ── Same-agent loop detection ──
      if (currentNode !== "supervisor" && currentNode === lastAgent) {
        consecutiveCount++;
        if (consecutiveCount >= MAX_CONSECUTIVE) {
          logger.warn("loop-detect", `${currentNode} ran ${consecutiveCount}× in a row — breaking loop`);
          stream.markdown(`\n> ⚠️ Detected loop: **${currentNode}** ran ${consecutiveCount} times consecutively. Advancing.\n`);
          // Force advance past this stuck point
          if (state.plan.length > 0 && state.planStep < state.plan.length) {
            state.planStep++;
          }
          consecutiveCount = 0;
          currentNode = "supervisor";
          continue;
        }
      } else {
        consecutiveCount = currentNode === "supervisor" ? consecutiveCount : 1;
      }
      lastAgent = currentNode;

      // ── Route to next node(s) ──
      const route = determineRoute(currentNode, state, failedAgents);

      if (route.done) {
        currentNode = "__end__";
        if (state.status !== "completed") { state.status = "completed"; }
        continue;
      }

      if (route.parallel && route.agents.length > 1) {
        // ── Parallel fan-out ──
        const validAgents = route.agents.filter(a => {
          if (failedAgents.has(a)) {
            stream.markdown(`\n> ⚠️ Skipping **${a}** (previously failed)\n`);
            return false;
          }
          return nodes[a] != null;
        });

        if (validAgents.length === 0) {
          currentNode = "supervisor";
          continue;
        }

        if (validAgents.length === 1) {
          // Degenerate: only one agent left, run sequentially
          currentNode = validAgents[0];
          continue;
        }

        const { mergedUpdate, runs, errors } = await runParallel(
          validAgents, state, model, stream, token
        );

        agentRuns.push(...runs);
        steps += validAgents.length;

        if (errors.length > 0) {
          state.errors = [...(state.errors ?? []), ...errors];
          for (const e of errors) {
            const name = e.split(":")[0];
            failedAgents.add(name);
          }
        }

        state = mergeState(state, mergedUpdate);
        // Clear pending agents after execution
        state.pendingAgents = [];

        // After parallel batch, advance plan step if plan-driven
        if (state.plan.length > 0 && state.planStep < state.plan.length) {
          state.planStep++;
        }

        // Route back to supervisor after parallel batch
        currentNode = "supervisor";
      } else {
        // ── Sequential: single next agent ──
        currentNode = route.agents[0] ?? "supervisor";

        // If supervisor tried to route to a failed agent, finish
        if (failedAgents.has(currentNode)) {
          stream.markdown(`\n> ⚠️ Skipping **${currentNode}** (previously failed). Finishing.\n`);
          currentNode = "__end__";
          state.status = "completed";
        }
      }
    }

    if (steps >= maxSteps) {
      stream.markdown(`\n\n> ⚠️ Reached maximum step limit (${maxSteps}). Stopping.\n`);
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

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Determine the next route based on which node just executed.
 *
 * Key design: when a plan exists, agents chain directly from one plan step
 * to the next WITHOUT bouncing through the supervisor for each step.
 * The supervisor only re-engages when the plan is exhausted or a step
 * has no agent tags.
 */
function determineRoute(
  currentNode: string,
  state: AgentState,
  _failedAgents: Set<string>
): RouteResult {
  if (currentNode === "supervisor") {
    // Supervisor just ran — check if there's a plan-driven route
    const planRoute = routeFromPlan(state);
    if (planRoute) {
      return planRoute;
    }
    return routeSupervisor(state);
  }

  if (currentNode === "reviewer") {
    return routeReviewer(state);
  }

  // After planner creates a plan: start executing step 0 directly
  if (currentNode === "planner" && state.plan.length > 0) {
    const planRoute = routeFromPlan(state);
    if (planRoute) {
      return planRoute;
    }
  }

  // ── After any other agent: advance the plan and chain to next step ──
  // This is the critical fix: instead of bouncing back to supervisor
  // (which wastes an LLM call and then re-routes to the same plan step
  // because planStep never advanced), we advance planStep here and go
  // directly to the next plan step's agent.
  if (state.plan.length > 0 && state.planStep < state.plan.length) {
    state.planStep++;
    logger.info("route", `Plan step advanced to ${state.planStep}/${state.plan.length}`);

    if (state.planStep < state.plan.length) {
      const nextPlanRoute = routeFromPlan(state);
      if (nextPlanRoute) {
        return nextPlanRoute;
      }
    }
    // Plan exhausted or step has no agent tags — supervisor decides wrap-up
  }

  // Default: go back to supervisor
  return { agents: ["supervisor"], parallel: false, done: false };
}

/**
 * Merge two partial state updates together.
 * Handles the append-semantics for messages, artifacts, errors, etc.
 */
function mergePartials(
  a: Partial<AgentState>,
  b: Partial<AgentState>
): Partial<AgentState> {
  const merged = { ...a, ...b };

  // Messages: concat both
  if (a.messages || b.messages) {
    merged.messages = [...(a.messages ?? []), ...(b.messages ?? [])];
  }

  // Artifacts: merge objects
  if (a.artifacts || b.artifacts) {
    merged.artifacts = { ...(a.artifacts ?? {}), ...(b.artifacts ?? {}) };
  }

  // Errors: concat
  if (a.errors || b.errors) {
    merged.errors = [...(a.errors ?? []), ...(b.errors ?? [])];
  }

  // Agent comms: concat
  if (a.agentComms || b.agentComms) {
    merged.agentComms = [...(a.agentComms ?? []), ...(b.agentComms ?? [])];
  }

  // Terminal results: concat
  if (a.terminalResults || b.terminalResults) {
    merged.terminalResults = [...(a.terminalResults ?? []), ...(b.terminalResults ?? [])];
  }

  return merged;
}
