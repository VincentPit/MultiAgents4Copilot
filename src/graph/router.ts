/**
 * Router — decides which node(s) to execute next based on the state.
 *
 * Supports three routing modes:
 *   1. Single dispatch   — supervisor says "coder" → one agent runs
 *   2. Parallel fan-out  — supervisor says "coder,test_gen" → both run concurrently
 *   3. Plan-driven       — planner's steps drive which agents run and in what order
 */

import { AgentState } from "./state";
import { logger } from "../utils/logger";

/** Routing result — one or more agents to execute (parallel when > 1). */
export interface RouteResult {
  agents: string[];      // agent names to run
  parallel: boolean;     // true = run concurrently, false = run first one
  done: boolean;         // true = graph should finish
}

export const VALID_AGENTS: ReadonlySet<string> = new Set([
  "planner", "coder", "coder_pool", "reviewer",
  "ui_designer", "test_gen", "integrator",
]);

/**
 * Route after the supervisor node.
 *
 * The supervisor's `nextAgent` field can be:
 *   - A single agent name: "coder"
 *   - Comma-separated for parallel: "coder,test_gen"
 *   - "finish" to end the graph
 *
 * Also checks `pendingAgents` for queued parallel work.
 */
export function routeSupervisor(state: AgentState): RouteResult {
  // Check for explicit parallel dispatch via pendingAgents
  if (state.pendingAgents.length > 0) {
    const valid = [...new Set(state.pendingAgents)].filter(a => VALID_AGENTS.has(a));
    if (valid.length > 1) {
      logger.route("supervisor", `parallel: [${valid.join(", ")}]`);
      return { agents: valid, parallel: true, done: false };
    }
    if (valid.length === 1) {
      logger.route("supervisor", valid[0]);
      return { agents: valid, parallel: false, done: false };
    }
  }

  // Parse the nextAgent field — may be comma-separated
  const raw = state.nextAgent.toLowerCase().trim();
  const parts = raw.split(/[,\s+]+/).map(s => s.trim()).filter(Boolean);

  // Check for finish
  if (parts.includes("finish") || parts.length === 0) {
    logger.route("supervisor", "__end__");
    return { agents: [], parallel: false, done: true };
  }

  // Validate and collect agents (deduplicate)
  const agents = [...new Set(parts.filter(a => VALID_AGENTS.has(a)))];

  if (agents.length === 0) {
    logger.route("supervisor", "__end__ (no valid agents)");
    return { agents: [], parallel: false, done: true };
  }

  if (agents.length > 1) {
    logger.route("supervisor", `parallel: [${agents.join(", ")}]`);
    return { agents, parallel: true, done: false };
  }

  logger.route("supervisor", agents[0]);
  return { agents, parallel: false, done: false };
}

/** After the reviewer: approve → end, revise → back to coder. */
export function routeReviewer(state: AgentState): RouteResult {
  if (state.status === "completed" || state.reviewVerdict === "approve") {
    return { agents: [], parallel: false, done: true };
  }
  return { agents: ["coder"], parallel: false, done: false };
}

/**
 * Plan-driven routing — parse the planner's steps to extract agent assignments.
 *
 * Looks for patterns like:
 *   "1. (coder) Write the API routes"
 *   "2. (test_gen) Write comprehensive tests"
 *   "3. (coder, test_gen) Implement and test the auth module"
 *
 * Returns the agents assigned to the current plan step.
 */
export function routeFromPlan(state: AgentState): RouteResult | null {
  if (state.plan.length === 0 || state.planStep >= state.plan.length) {
    return null; // no plan or plan exhausted
  }

  const step = state.plan[state.planStep];
  // Match (agent) or (agent1, agent2) at beginning of step
  const match = step.match(/\(([a-z_,\s]+)\)/i);
  if (!match) { return null; }

  const agents = match[1]
    .split(",")
    .map(a => a.trim().toLowerCase())
    .filter(a => VALID_AGENTS.has(a));

  if (agents.length === 0) { return null; }

  logger.route("plan-step-" + state.planStep, agents.length > 1
    ? `parallel: [${agents.join(", ")}]`
    : agents[0]);

  return {
    agents,
    parallel: agents.length > 1,
    done: false,
  };
}
