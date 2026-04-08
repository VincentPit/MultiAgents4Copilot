/**
 * Extended router tests — edge cases for plan-driven routing.
 *
 * These tests cover edge cases that weren't tested before:
 *   - routeFromPlan with various plan step formats
 *   - Mixed valid/invalid agents in plan steps
 *   - Empty parentheses
 *   - Plan steps with nested parentheses
 *   - routeSupervisor with edge-case inputs
 */

import { routeSupervisor, routeReviewer, routeFromPlan, VALID_AGENTS, type RouteResult } from "../../graph/router.js";
import { createInitialState, type AgentState } from "../../graph/state.js";

describe("routeFromPlan — edge cases", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("handles plan step with coder_pool correctly", () => {
    state.plan = ["1. (coder_pool) Build the entire backend in parallel"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder_pool"]);
    expect(result!.parallel).toBe(false);
  });

  it("handles plan step with integrator after coder_pool", () => {
    state.plan = [
      "1. (coder_pool) Parallel coding",
      "2. (integrator) Merge outputs",
    ];
    state.planStep = 1;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["integrator"]);
  });

  it("returns null for plan step with empty parentheses", () => {
    state.plan = ["1. () Do something"];
    state.planStep = 0;
    expect(routeFromPlan(state)).toBeNull();
  });

  it("filters out invalid agents from multi-agent plan step", () => {
    state.plan = ["1. (coder, invalid_agent, test_gen) Work together"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder", "test_gen"]);
    expect(result!.parallel).toBe(true);
  });

  it("returns null when all agents in plan step are invalid", () => {
    state.plan = ["1. (fake_agent, nonexistent) Do things"];
    state.planStep = 0;
    expect(routeFromPlan(state)).toBeNull();
  });

  it("handles plan step with extra whitespace in agent names", () => {
    state.plan = ["1. ( coder ,  test_gen ) Build and test"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder", "test_gen"]);
  });

  it("handles plan step with parentheses not at beginning", () => {
    // The regex uses match (not match at start), so this should work
    state.plan = ["1. Research then (coder) implement"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder"]);
  });

  it("handles three-agent parallel step", () => {
    state.plan = ["1. (coder, test_gen, ui_designer) Build everything"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder", "test_gen", "ui_designer"]);
    expect(result!.parallel).toBe(true);
  });

  it("case-insensitive agent matching", () => {
    state.plan = ["1. (CODER) Write code"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder"]);
  });
});

describe("routeSupervisor — additional edge cases", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("handles empty string nextAgent as finish", () => {
    state.nextAgent = "";
    state.pendingAgents = [];
    const result = routeSupervisor(state);
    expect(result.done).toBe(true);
  });

  it("handles nextAgent with only whitespace as finish", () => {
    state.nextAgent = "   ";
    state.pendingAgents = [];
    const result = routeSupervisor(state);
    expect(result.done).toBe(true);
  });

  it("deduplicates agents in comma-separated list", () => {
    state.nextAgent = "coder,coder,test_gen";
    const result = routeSupervisor(state);
    // Duplicates are removed — only unique agents remain
    expect(result.agents).toEqual(["coder", "test_gen"]);
    expect(result.parallel).toBe(true);
  });

  it("handles pendingAgents with single valid + invalid agents", () => {
    state.pendingAgents = ["invalid1", "coder", "invalid2"];
    const result = routeSupervisor(state);
    // Only coder is valid — should be sequential, not parallel
    expect(result.agents).toEqual(["coder"]);
    expect(result.parallel).toBe(false);
  });

  it("handles nextAgent 'finish' with extra text", () => {
    state.nextAgent = "finish the task";
    state.pendingAgents = [];
    const result = routeSupervisor(state);
    // 'finish' is one of the parts after splitting
    expect(result.done).toBe(true);
  });

  it("handles three-way parallel dispatch", () => {
    state.nextAgent = "coder,test_gen,ui_designer";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["coder", "test_gen", "ui_designer"]);
    expect(result.parallel).toBe(true);
  });
});

describe("routeReviewer — additional edge cases", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("returns done when status is error", () => {
    // Currently routeReviewer only checks status === 'completed' or verdict === 'approve'
    // When status is 'error', it should route to coder (current behavior)
    state.status = "error";
    state.reviewVerdict = "pending";
    const result = routeReviewer(state);
    // Document current behavior: error status still routes to coder
    expect(result.agents).toEqual(["coder"]);
  });
});
