/**
 * Tests for src/graph/router.ts — graph routing decisions.
 *
 * The router now returns RouteResult objects instead of plain strings,
 * supporting parallel fan-out and plan-driven routing.
 */

import { routeSupervisor, routeReviewer, routeFromPlan, type RouteResult } from "../../graph/router";
import { createInitialState, type AgentState } from "../../graph/state";

describe("routeSupervisor", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("routes to a single agent when nextAgent is a valid name", () => {
    state.nextAgent = "planner";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["planner"]);
    expect(result.parallel).toBe(false);
    expect(result.done).toBe(false);
  });

  it.each(["coder", "researcher", "reviewer", "ui_designer", "test_gen"])(
    "routes to %s when nextAgent is set",
    (agent) => {
      state.nextAgent = agent;
      const result = routeSupervisor(state);
      expect(result.agents).toEqual([agent]);
      expect(result.done).toBe(false);
    }
  );

  it("returns done when nextAgent is 'finish'", () => {
    state.nextAgent = "finish";
    const result = routeSupervisor(state);
    expect(result.done).toBe(true);
  });

  it("returns done for unrecognised agent name", () => {
    state.nextAgent = "unknown_agent";
    const result = routeSupervisor(state);
    expect(result.done).toBe(true);
  });

  it("handles uppercase / mixed case gracefully", () => {
    state.nextAgent = "CODER";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["coder"]);
  });

  it("handles whitespace around the agent name", () => {
    state.nextAgent = "  planner  ";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["planner"]);
  });

  it("routes to coder_pool for multi-domain coding", () => {
    state.nextAgent = "coder_pool";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["coder_pool"]);
    expect(result.done).toBe(false);
  });

  it("routes to integrator after parallel coding", () => {
    state.nextAgent = "integrator";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["integrator"]);
    expect(result.done).toBe(false);
  });

  // ── Multi-agent / parallel dispatch ──

  it("parses comma-separated agents for parallel fan-out", () => {
    state.nextAgent = "researcher,coder";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["researcher", "coder"]);
    expect(result.parallel).toBe(true);
    expect(result.done).toBe(false);
  });

  it("parses comma-separated agents with spaces", () => {
    state.nextAgent = "coder, test_gen";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["coder", "test_gen"]);
    expect(result.parallel).toBe(true);
  });

  it("filters out invalid agents from comma-separated list", () => {
    state.nextAgent = "coder,invalid,researcher";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["coder", "researcher"]);
    expect(result.parallel).toBe(true);
  });

  it("falls back to done if all comma-separated agents are invalid", () => {
    state.nextAgent = "invalid1,invalid2";
    const result = routeSupervisor(state);
    expect(result.done).toBe(true);
  });

  it("uses pendingAgents for fan-out when present", () => {
    state.pendingAgents = ["researcher", "coder"];
    state.nextAgent = "";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["researcher", "coder"]);
    expect(result.parallel).toBe(true);
  });

  it("prefers pendingAgents over nextAgent when both are set", () => {
    state.pendingAgents = ["researcher", "ui_designer"];
    state.nextAgent = "coder";
    const result = routeSupervisor(state);
    expect(result.agents).toEqual(["researcher", "ui_designer"]);
    expect(result.parallel).toBe(true);
  });
});

describe("routeReviewer", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("returns done when status is completed", () => {
    state.status = "completed";
    state.reviewVerdict = "revise"; // even if verdict says revise
    const result = routeReviewer(state);
    expect(result.done).toBe(true);
  });

  it("returns done when verdict is approve", () => {
    state.status = "in_progress";
    state.reviewVerdict = "approve";
    const result = routeReviewer(state);
    expect(result.done).toBe(true);
  });

  it("routes to coder when verdict is revise and not completed", () => {
    state.status = "in_progress";
    state.reviewVerdict = "revise";
    const result = routeReviewer(state);
    expect(result.agents).toEqual(["coder"]);
    expect(result.done).toBe(false);
  });

  it("routes to coder when verdict is pending", () => {
    state.status = "in_progress";
    state.reviewVerdict = "pending";
    const result = routeReviewer(state);
    expect(result.agents).toEqual(["coder"]);
    expect(result.done).toBe(false);
  });
});

describe("routeFromPlan", () => {
  let state: AgentState;

  beforeEach(() => {
    state = createInitialState("test");
  });

  it("returns null when there is no plan", () => {
    state.plan = [];
    expect(routeFromPlan(state)).toBeNull();
  });

  it("returns null when planStep exceeds plan length", () => {
    state.plan = ["1. (coder) Write code"];
    state.planStep = 1;
    expect(routeFromPlan(state)).toBeNull();
  });

  it("parses a single agent from a plan step", () => {
    state.plan = ["1. (researcher) Research best practices"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["researcher"]);
    expect(result!.parallel).toBe(false);
  });

  it("parses multiple agents for parallel execution", () => {
    state.plan = ["1. (coder, test_gen) Write code and tests in parallel"];
    state.planStep = 0;
    const result = routeFromPlan(state);
    expect(result).not.toBeNull();
    expect(result!.agents).toEqual(["coder", "test_gen"]);
    expect(result!.parallel).toBe(true);
  });

  it("returns null for plan steps without agent tags", () => {
    state.plan = ["1. Do something generic"];
    state.planStep = 0;
    expect(routeFromPlan(state)).toBeNull();
  });

  it("advances through plan steps correctly", () => {
    state.plan = [
      "1. (researcher) Research",
      "2. (coder) Implement",
      "3. (reviewer) Review",
    ];

    state.planStep = 0;
    expect(routeFromPlan(state)!.agents).toEqual(["researcher"]);

    state.planStep = 1;
    expect(routeFromPlan(state)!.agents).toEqual(["coder"]);

    state.planStep = 2;
    expect(routeFromPlan(state)!.agents).toEqual(["reviewer"]);

    state.planStep = 3;
    expect(routeFromPlan(state)).toBeNull();
  });
});
