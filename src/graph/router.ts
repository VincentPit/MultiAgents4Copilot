/**
 * Router — decides which node to execute next based on the state.
 */

import { AgentState } from "./state";
import { logger } from "../utils/logger";

/** Map the supervisor's decision to a graph node name. */
export function routeSupervisor(state: AgentState): string {
  const decision = state.nextAgent.toLowerCase().trim();

  const valid: Record<string, string> = {
    planner: "planner",
    coder: "coder",
    researcher: "researcher",
    reviewer: "reviewer",
    ui_designer: "ui_designer",
    test_gen: "test_gen",
    finish: "__end__",
  };

  const next = valid[decision] ?? "__end__";
  logger.route("supervisor", next);
  return next;
}

/** After the reviewer: approve → end, revise → back to coder. */
export function routeReviewer(state: AgentState): string {
  if (state.status === "completed" || state.reviewVerdict === "approve") {
    return "__end__";
  }
  return "coder";
}
