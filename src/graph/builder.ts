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
import { AgentOutputManager } from "../utils/agentOutputManager";

/** Default per-agent timeout (ms). */
const DEFAULT_AGENT_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Per-agent timeout overrides (ms).
 * Agents that perform internal fan-out (like coder_pool) need much
 * longer than single-call agents because they run decomposition +
 * N parallel LLM calls + file writes + terminal commands.
 */
const AGENT_TIMEOUT_OVERRIDES: Record<string, number> = {
  coder_pool: 480_000,  // 8 min — runs N domain coders with concurrency limit + file writes + QA
  integrator: 240_000,  // 4 min — cross-domain merge can be slow
  coder:      240_000,  // 4 min — may write many files + run commands
  test_gen:   240_000,  // 4 min — generates tests then runs them
};

/** Resolve the timeout for a given agent. */
function agentTimeout(name: string): number {
  return AGENT_TIMEOUT_OVERRIDES[name] ?? DEFAULT_AGENT_TIMEOUT_MS;
}

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
  reviewer:    { icon: "✅", label: "Reviewer" },
  integrator:  { icon: "🔗", label: "Integration Engineer" },
  ui_designer: { icon: "🎨", label: "UI Designer" },
  test_gen:    { icon: "🧪", label: "Test Generator" },
};

// ── Progress Tracker ──────────────────────────────────────────────────

/** Status for a tracked agent in the progress display. */
type AgentStatus = "pending" | "running" | "done" | "error";

interface TrackedAgent {
  name: string;
  status: AgentStatus;
  startMs: number;
  endMs?: number;
  error?: string;
}

/**
 * Real-time progress tracker that shows a live loading bar + elapsed time
 * for each agent as it runs, using stream.progress() for the spinner line
 * and stream.markdown() for the persistent status board.
 */
export class ProgressTracker {
  private agents: TrackedAgent[] = [];
  private stream: vscode.ChatResponseStream;
  private graphStartMs: number;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  constructor(stream: vscode.ChatResponseStream, graphStartMs: number) {
    this.stream = stream;
    this.graphStartMs = graphStartMs;
  }

  /** Mark an agent as running and start the live progress tick. */
  startAgent(name: string): void {
    // Remove any existing entry for this agent (re-run scenario)
    this.agents = this.agents.filter(a => !(a.name === name && a.status === "pending"));
    this.agents.push({ name, status: "running", startMs: Date.now() });
    this.emitProgressLine();
    this.startTick();
  }

  /** Mark an agent as completed. */
  completeAgent(name: string, durationMs: number): void {
    const agent = this.findRunning(name);
    if (agent) {
      agent.status = "done";
      agent.endMs = agent.startMs + durationMs;
    }
    this.stopTick();
    this.emitProgressLine();
    this.emitAgentCompletionCard(name, durationMs);
  }

  /** Mark an agent as failed. */
  failAgent(name: string, durationMs: number, error: string): void {
    const agent = this.findRunning(name);
    if (agent) {
      agent.status = "error";
      agent.endMs = agent.startMs + durationMs;
      agent.error = error;
    }
    this.stopTick();
    this.emitProgressLine();
  }

  /** Start multiple agents for parallel execution. */
  startParallelAgents(names: string[]): void {
    for (const name of names) {
      this.agents.push({ name, status: "running", startMs: Date.now() });
    }
    this.emitProgressLine();
    this.startTick();
  }

  /** Mark one parallel agent as completed. */
  completeParallelAgent(name: string, durationMs: number): void {
    const agent = this.findRunning(name);
    if (agent) {
      agent.status = "done";
      agent.endMs = agent.startMs + durationMs;
    }
    // Update the progress line but don't stop tick (others may still be running)
    this.emitProgressLine();
  }

  /** Mark one parallel agent as failed. */
  failParallelAgent(name: string, durationMs: number, error: string): void {
    const agent = this.findRunning(name);
    if (agent) {
      agent.status = "error";
      agent.endMs = agent.startMs + durationMs;
      agent.error = error;
    }
    this.emitProgressLine();
  }

  /** Stop the parallel tick (call after all parallel agents are done). */
  endParallelBatch(): void {
    this.stopTick();
  }

  /** Clean up any running timers. */
  dispose(): void {
    this.stopTick();
  }

  // ── Private helpers ──

  private findRunning(name: string): TrackedAgent | undefined {
    return this.agents.find(a => a.name === name && a.status === "running");
  }

  /** Emit a stream.progress() line showing all currently running agents with elapsed times. */
  private emitProgressLine(): void {
    const now = Date.now();
    const running = this.agents.filter(a => a.status === "running");
    if (running.length === 0) {
      // Show total elapsed
      const elapsed = formatDurationShort(now - this.graphStartMs);
      this.stream.progress(`✨ Processing complete — ${elapsed} total`);
      return;
    }

    if (running.length === 1) {
      const a = running[0];
      const display = AGENT_DISPLAY[a.name] ?? { icon: "⚙️", label: a.name };
      const elapsed = formatDurationShort(now - a.startMs);
      const bar = renderMiniBar(now - a.startMs, agentTimeout(a.name));
      this.stream.progress(`${display.icon} ${display.label}  ${bar}  ${elapsed}`);
    } else {
      // Multiple agents running in parallel
      const parts = running.map(a => {
        const display = AGENT_DISPLAY[a.name] ?? { icon: "⚙️", label: a.name };
        const elapsed = formatDurationShort(now - a.startMs);
        return `${display.icon} ${elapsed}`;
      });
      this.stream.progress(`⚡ Parallel: ${parts.join("  ·  ")}`);
    }
  }

  /** Show a small completion card in markdown after a sequential agent finishes. */
  private emitAgentCompletionCard(name: string, durationMs: number): void {
    const display = AGENT_DISPLAY[name] ?? { icon: "⚙️", label: name };
    const bar = renderProgressBar(durationMs, agentTimeout(name), 20);
    const elapsed = formatDurationShort(durationMs);

    // Don't show cards for supervisor (too noisy — it runs many times)
    if (name === "supervisor") { return; }

    this.stream.markdown(
      `> ${display.icon} **${display.label}**  ·  \`${bar}\`  **${elapsed}**\n\n`
    );
  }

  /** Start a periodic tick that updates the progress spinner with elapsed time. */
  private startTick(): void {
    if (this.tickTimer) { return; } // Already running
    this.tickTimer = setInterval(() => {
      this.emitProgressLine();
    }, 1_000); // Update every second
  }

  /** Stop the periodic tick. */
  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }
}

/** Render a progress bar using Unicode blocks: ▓▓▓▓▓░░░░░ */
function renderProgressBar(elapsedMs: number, timeoutMs: number, width: number = 20): string {
  const fraction = Math.min(elapsedMs / timeoutMs, 1);
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

/** Render a compact mini-bar for the progress spinner line. */
function renderMiniBar(elapsedMs: number, timeoutMs: number): string {
  return `[${renderProgressBar(elapsedMs, timeoutMs, 15)}]`;
}

/** Format duration as compact string (e.g., "3.2s", "1m 23s"). */
function formatDurationShort(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Build and return a compiled graph executor.
 */
export function buildGraph(config: GraphConfig) {
  const { nodes, entryPoint, maxSteps } = config;

  /**
   * Run a single agent node with timing and error handling.
   * Optionally accepts a ProgressTracker for live progress updates.
   */
  async function runNode(
    name: string,
    state: AgentState,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    tracker?: ProgressTracker
  ): Promise<{ update: Partial<AgentState>; durationMs: number; error?: string }> {
    const nodeFn = nodes[name];
    if (!nodeFn) {
      return { update: {}, durationMs: 0, error: `Unknown agent node: ${name}` };
    }

    const start = Date.now();
    logger.agentStart(name);
    try {
      // Race agent execution against a per-agent timeout
      const timeoutMs = agentTimeout(name);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Agent "${name}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });

      const update = await Promise.race([
        nodeFn(state, model, stream, token),
        timeoutPromise,
      ]).finally(() => { if (timer) clearTimeout(timer); });

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
    token: vscode.CancellationToken,
    tracker?: ProgressTracker
  ): Promise<{ mergedUpdate: Partial<AgentState>; runs: AgentRun[]; errors: string[] }> {
    const labels = agentNames.map(n => {
      const d = AGENT_DISPLAY[n] ?? { icon: "⚙️", label: n };
      return `${d.icon} ${d.label}`;
    });

    stream.markdown(
      `\n> ⚡ **Parallel execution:** ${labels.join(" + ")}\n\n`
    );

    // Reveal output channels for parallel agents
    const outputMgr = AgentOutputManager.getInstance();
    outputMgr.revealParallel(agentNames);

    // Start tracking all parallel agents
    if (tracker) {
      tracker.startParallelAgents(agentNames);
    }

    // Launch all agents concurrently with an immutable state snapshot
    const stateSnapshot = frozenSnapshot(state);
    const promises = agentNames.map(name =>
      runNode(name, stateSnapshot, model, stream, token).then(result => {
        // Update tracker as each agent finishes
        if (tracker) {
          if (result.error) {
            tracker.failParallelAgent(name, result.durationMs, result.error);
          } else {
            tracker.completeParallelAgent(name, result.durationMs);
          }
        }
        return result;
      })
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
        return `${d.icon} ${formatDurationShort(r.durationMs)}`;
      }).join("  ·  ")} \n\n`
    );

    if (tracker) {
      tracker.endParallelBatch();
    }

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

    // ── Live progress tracker ──
    const tracker = new ProgressTracker(stream, graphStart);

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
      tracker.startAgent(currentNode);

      // ── Run the current node ──
      const { update, durationMs, error } = await runNode(currentNode, state, model, stream, token, tracker);

      if (error) {
        tracker.failAgent(currentNode, durationMs, error);
        stream.markdown(`\n\n> ⚠️ **${display.label}** encountered an error: ${error}\n`);
        state.errors = [...(state.errors ?? []), `${currentNode}: ${error}`];
        failedAgents.add(currentNode);

        // ── Automatic fallback: coder_pool → single coder ──
        if (currentNode === "coder_pool" && !failedAgents.has("coder") && nodes["coder"]) {
          stream.markdown(`\n> 🔄 **Falling back** from Engineering Team to single Coder…\n`);
          currentNode = "coder";
          steps++;
          continue;
        }

        if (failedAgents.size >= 3) {
          stream.markdown(`\n\n> ⚠️ Too many agents failed (${failedAgents.size}). Finishing with available results.\n`);
          state.status = "completed";
          currentNode = "__end__";
          steps++;
          continue;
        }

        // Re-route through supervisor with failure context
        // Inject failure info so the supervisor LLM knows which agents to avoid
        const failedList = [...failedAgents].join(", ");
        state.nextAgent = "supervisor";
        state.messages = [
          ...state.messages,
          {
            role: "system" as const,
            name: "graph-router",
            content: `Agent "${currentNode}" failed: ${error}. Previously failed agents: [${failedList}]. Do NOT route to any of these agents. Choose a different agent or FINISH.`,
          },
        ];
        currentNode = "supervisor";
        steps++;
        continue;
      }

      failedAgents.delete(currentNode);
      tracker.completeAgent(currentNode, durationMs);
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
          validAgents, state, model, stream, token, tracker
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

    // Clean up the progress tracker
    tracker.dispose();

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
  // Advance planStep here so subsequent routeFromPlan() picks up the
  // correct next step. We never mutate planStep elsewhere (the main
  // loop only advances after parallel batches to mirror this logic).
  if (state.plan.length > 0 && state.planStep < state.plan.length) {
    const advancedStep = state.planStep + 1;
    state.planStep = advancedStep;
    logger.info("route", `Plan step advanced to ${advancedStep}/${state.plan.length}`);

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
