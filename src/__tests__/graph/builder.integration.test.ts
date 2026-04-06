/**
 * Integration tests for the graph builder — full execution flow tests.
 *
 * These tests simulate REAL multi-step graph execution with plan-driven routing.
 * They would have caught Bug #1: planStep never advancing after sequential agents,
 * causing the graph to loop on the same agent forever.
 *
 * Each test assembles a full graph with stub agents and verifies:
 *   - The exact execution ORDER of agents
 *   - Plan step advancement between sequential steps
 *   - Consecutive same-agent loop detection
 *   - Parallel fan-out with plan step advancement
 *   - Plan exhaustion → supervisor → finish
 */

import * as vscode from "vscode";
import { buildGraph, type AgentNode, type GraphResult } from "../../graph/builder.js";
import { createInitialState, type AgentState } from "../../graph/state.js";

// ── Shared helpers ───────────────────────────────────────────────────

const mockModel = {
  name: "mock-model",
  maxInputTokens: 200_000,
  sendRequest: jest.fn(),
} as any;

function mockStream() {
  return {
    markdown: jest.fn(),
    progress: jest.fn(),
    reference: jest.fn(),
    button: jest.fn(),
    anchor: jest.fn(),
  } as unknown as vscode.ChatResponseStream;
}

function mockToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  } as any;
}

// ── Full plan-driven execution tests ─────────────────────────────────

describe("Plan-driven sequential execution", () => {
  it("executes plan steps in exact order: coder → test_gen → reviewer", async () => {
    const executionOrder: string[] = [];

    // This test reproduces the EXACT scenario that caused Bug #1.
    // Pre-fix: planner → coder → supervisor → coder → supervisor → ...
    // Post-fix: planner → coder → test_gen → reviewer → done
    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        executionOrder.push("supervisor");
        // First call: route to planner
        if (state.plan.length === 0) {
          return { nextAgent: "planner" };
        }
        // After plan is exhausted: finish
        return { nextAgent: "finish", status: "completed" as const };
      },
      planner: async () => {
        executionOrder.push("planner");
        return {
          plan: [
            "1. (coder) Implement the solution",
            "2. (test_gen) Generate tests",
            "3. (reviewer) Review the code",
          ],
          messages: [{ role: "assistant" as const, content: "plan created", name: "planner" }],
        };
      },
      coder: async () => {
        executionOrder.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "code written", name: "coder" }],
        };
      },
      test_gen: async () => {
        executionOrder.push("test_gen");
        return {
          messages: [{ role: "assistant" as const, content: "tests generated", name: "test_gen" }],
        };
      },
      reviewer: async () => {
        executionOrder.push("reviewer");
        return {
          messages: [{ role: "assistant" as const, content: "looks good", name: "reviewer" }],
          reviewVerdict: "approve" as const,
          status: "completed" as const,
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("Build a REST API");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // The EXACT execution order — this is what Bug #1 would have failed
    expect(executionOrder).toEqual([
      "supervisor",   // Initial: routes to planner
      "planner",      // Creates 3-step plan
      "coder",        // Plan step 0: (coder)
      "test_gen",     // Plan step 1: (test_gen) — directly chained, NOT via supervisor
      "reviewer",     // Plan step 2: (reviewer) — directly chained
      // reviewer returns approve → done via routeReviewer
    ]);

    // Verify plan step advancement
    expect(result.state.plan).toHaveLength(3);
    expect(result.state.status).toBe("completed");
  });

  it("advances planStep after each sequential agent completes", async () => {
    const planStepLog: number[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) {
          return { nextAgent: "planner" };
        }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (coder) Code",
          "2. (test_gen) Test",
          "3. (ui_designer) Design",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async (state) => {
        planStepLog.push(state.planStep);
        return {
          messages: [{ role: "assistant" as const, content: "done", name: "coder" }],
        };
      },
      test_gen: async (state) => {
        planStepLog.push(state.planStep);
        return {
          messages: [{ role: "assistant" as const, content: "done", name: "test_gen" }],
        };
      },
      ui_designer: async (state) => {
        planStepLog.push(state.planStep);
        return {
          messages: [{ role: "assistant" as const, content: "done", name: "ui_designer" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    await graph.run(state, mockModel, mockStream(), mockToken());

    // Each agent should see an incremented planStep
    // coder sees step 0, test_gen sees step 1, ui_designer sees step 2
    expect(planStepLog).toEqual([0, 1, 2]);
  });

  it("does NOT bounce through supervisor between plan steps (no wasted LLM calls)", async () => {
    let supervisorCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        supervisorCalls++;
        if (state.plan.length === 0) {
          return { nextAgent: "planner" };
        }
        // Should only reach here after plan is exhausted
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (coder) Research OAuth2",
          "2. (test_gen) Test auth module",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "coder" }],
      }),
      test_gen: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "test_gen" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    await graph.run(state, mockModel, mockStream(), mockToken());

    // Supervisor should only be called TWICE:
    //   1. Initial call → routes to planner
    //   2. After plan exhausted → finishes
    // Pre-fix it was called between EVERY plan step (wasting LLM calls)
    expect(supervisorCalls).toBe(2);
  });

  it("test_gen does NOT loop when it is a plan step (Bug #1 regression)", async () => {
    // This is the EXACT reproduction of the original bug:
    // Plan has test_gen as step 0. Pre-fix, test_gen would
    // bounce back to supervisor, supervisor would call routeFromPlan
    // which returns step 0 again (because planStep was never advanced).
    let testGenCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) {
          return { nextAgent: "planner" };
        }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (test_gen) Generate test cases",
          "2. (coder) Implement solution",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      test_gen: async () => {
        testGenCalls++;
        return {
          messages: [{ role: "assistant" as const, content: "tests generated", name: "test_gen" }],
        };
      },
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "code done", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("Make the app safer");
    await graph.run(state, mockModel, mockStream(), mockToken());

    // test_gen should be called EXACTLY ONCE — not 7 times like the original bug
    expect(testGenCalls).toBe(1);
  });
});

// ── Loop detection tests ─────────────────────────────────────────────

describe("Consecutive same-agent loop detection", () => {
  it("emits loop warnings and force-advances planStep when same agent runs 3× consecutively", async () => {
    // Loop detection triggers when the SAME non-supervisor agent is chained
    // directly multiple times via plan-driven routing.
    let coderCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        // Pathological plan: same agent 6 times in a row
        plan: [
          "1. (coder) Fix file one",
          "2. (coder) Fix file two",
          "3. (coder) Fix file three",
          "4. (coder) Fix file four",
          "5. (coder) Fix file five",
          "6. (coder) Fix file six",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async () => {
        coderCalls++;
        return {
          messages: [{ role: "assistant" as const, content: `fix ${coderCalls}`, name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 30 });
    const state = createInitialState("test loop");
    const stream = mockStream();
    await graph.run(state, mockModel, stream, mockToken());

    // The loop detection WARNS when the same agent runs 3× consecutively.
    // It then force-advances planStep and routes to supervisor.
    // With 6 coder steps, detection fires at least once after 3 consecutive runs.
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const loopWarnings = mdCalls.filter((m: string) =>
      m.includes("loop") || m.includes("consecutively") || m.includes("times")
    );
    expect(loopWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT trigger loop detection for different agents", async () => {
    const executionOrder: string[] = [];
    let supervisorCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        supervisorCalls++;
        if (supervisorCalls === 1) { return { nextAgent: "planner" }; }
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => {
        executionOrder.push("planner");
        return {
          plan: [
            "1. (test_gen) Test",
            "2. (coder) Code",
            "3. (test_gen) Verify",
          ],
          messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
        };
      },
      test_gen: async () => {
        executionOrder.push("test_gen");
        return {
          messages: [{ role: "assistant" as const, content: "done", name: "test_gen" }],
        };
      },
      coder: async () => {
        executionOrder.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "done", name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const stream = mockStream();
    await graph.run(state, mockModel, stream, mockToken());

    // No loop detection warning should appear — agents alternate properly
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasLoopWarning = mdCalls.some((m: string) =>
      m.includes("loop") && m.includes("consecutively")
    );
    expect(hasLoopWarning).toBe(false);
  });

  it("resets consecutive count when a different agent runs", async () => {
    // Supervisor routes to coder twice, then test_gen, then coder twice
    // The coder count should reset when test_gen runs in between
    let callIndex = 0;
    let coderCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        callIndex++;
        if (callIndex <= 2) { return { nextAgent: "coder" }; }
        if (callIndex === 3) { return { nextAgent: "test_gen" }; }
        if (callIndex <= 5) { return { nextAgent: "coder" }; }
        return { nextAgent: "finish" };
      },
      coder: async () => {
        coderCalls++;
        return {
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        };
      },
      test_gen: async () => ({
        messages: [{ role: "assistant" as const, content: "analysis", name: "test_gen" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 30 });
    const state = createInitialState("test");
    const stream = mockStream();
    await graph.run(state, mockModel, stream, mockToken());

    // Should NOT trigger loop detection because test_gen breaks the coder streak
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasLoopWarning = mdCalls.some((m: string) =>
      m.includes("loop") && m.includes("consecutively")
    );
    expect(hasLoopWarning).toBe(false);
    // Coder should have been called 4 times (2 before test_gen, 2 after)
    expect(coderCalls).toBe(4);
  });
});

// ── Plan with parallel steps ─────────────────────────────────────────

describe("Plan-driven parallel steps", () => {
  it("executes parallel agents when plan step has multiple agent tags", async () => {
    const executionOrder: string[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (coder, test_gen) Implement and test in parallel",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async () => {
        executionOrder.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        };
      },
      test_gen: async () => {
        executionOrder.push("test_gen");
        return {
          messages: [{ role: "assistant" as const, content: "tests", name: "test_gen" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test parallel plan");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // Both agents should have run
    expect(executionOrder).toContain("coder");
    expect(executionOrder).toContain("test_gen");

    // Both should be marked as parallel runs
    const parallelRuns = result.agentRuns.filter(r => r.parallel);
    expect(parallelRuns.length).toBe(2);
  });

  it("advances planStep after parallel step completes", async () => {
    const executionOrder: string[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (coder, test_gen) Build and test in parallel",
          "2. (reviewer) Review everything",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async () => {
        executionOrder.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        };
      },
      test_gen: async () => {
        executionOrder.push("test_gen");
        return {
          messages: [{ role: "assistant" as const, content: "tests", name: "test_gen" }],
        };
      },
      reviewer: async () => {
        executionOrder.push("reviewer");
        return {
          messages: [{ role: "assistant" as const, content: "approved", name: "reviewer" }],
          reviewVerdict: "approve" as const,
          status: "completed" as const,
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // After parallel step → supervisor → then plan step 1 (reviewer) should run
    // The reviewer should have been reached
    expect(executionOrder).toContain("reviewer");
    expect(result.state.status).toBe("completed");
  });

  it("handles mixed sequential and parallel plan steps", async () => {
    const executionOrder: string[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (test_gen) Analyze the requirements",
          "2. (coder, ui_designer) Build backend and frontend in parallel",
          "3. (reviewer) Final review",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      test_gen: async () => {
        executionOrder.push("test_gen");
        return {
          messages: [{ role: "assistant" as const, content: "analysis", name: "test_gen" }],
        };
      },
      coder: async () => {
        executionOrder.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "backend", name: "coder" }],
        };
      },
      ui_designer: async () => {
        executionOrder.push("ui_designer");
        return {
          messages: [{ role: "assistant" as const, content: "frontend", name: "ui_designer" }],
        };
      },
      reviewer: async () => {
        executionOrder.push("reviewer");
        return {
          messages: [{ role: "assistant" as const, content: "approved", name: "reviewer" }],
          reviewVerdict: "approve" as const,
          status: "completed" as const,
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 30 });
    const state = createInitialState("Build a web app");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // Step 0: test_gen (sequential)
    expect(executionOrder.indexOf("test_gen")).toBeLessThan(executionOrder.indexOf("reviewer"));
    // Step 1: coder + ui_designer (parallel) — both before reviewer
    expect(executionOrder).toContain("coder");
    expect(executionOrder).toContain("ui_designer");
    // Step 2: reviewer last
    expect(executionOrder).toContain("reviewer");
    expect(result.state.status).toBe("completed");
  });
});

// ── Plan exhaustion tests ────────────────────────────────────────────

describe("Plan exhaustion", () => {
  it("routes back to supervisor when all plan steps are done", async () => {
    let supervisorCallsAfterPlan = 0;
    let planExisted = false;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length > 0) {
          planExisted = true;
          if (state.planStep >= state.plan.length) {
            supervisorCallsAfterPlan++;
          }
        }
        if (!planExisted) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: ["1. (coder) Write code"],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // After the single plan step (coder) completes, plan is exhausted,
    // so supervisor gets called and should finish
    expect(supervisorCallsAfterPlan).toBeGreaterThanOrEqual(1);
    expect(result.state.status).toBe("completed");
  });

  it("handles plans with no agent tags gracefully", async () => {
    const executionOrder: string[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        executionOrder.push("supervisor");
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => {
        executionOrder.push("planner");
        return {
          plan: [
            "1. Do something vague with no agent tag",
            "2. Another step without parenthesized agent",
          ],
          messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 10 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // When plan steps have no agent tags, routeFromPlan returns null,
    // so it should fall back to supervisor which then finishes
    expect(result.state.status).toBe("completed");
  });
});

// ── State accumulation tests ─────────────────────────────────────────

describe("State accumulation during plan execution", () => {
  it("accumulates messages from all plan-step agents", async () => {
    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (test_gen) Generate tests",
          "2. (coder) Implement",
        ],
        messages: [{ role: "assistant" as const, content: "plan made", name: "planner" }],
      }),
      test_gen: async () => ({
        messages: [{ role: "assistant" as const, content: "OAuth2 test plan", name: "test_gen" }],
        artifacts: { test_plan: "OAuth2 test analysis" },
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "auth module written", name: "coder" }],
        artifacts: { last_code: "const auth = ..." },
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("Build auth");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // All agents' messages should be present
    const agentNames = result.state.messages
      .map(m => m.name)
      .filter(Boolean);
    expect(agentNames).toContain("planner");
    expect(agentNames).toContain("test_gen");
    expect(agentNames).toContain("coder");

    // All artifacts should be merged
    expect(result.state.artifacts["test_plan"]).toBe("OAuth2 test analysis");
    expect(result.state.artifacts["last_code"]).toBe("const auth = ...");
  });

  it("preserves plan in final state", async () => {
    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        if (state.plan.length === 0) { return { nextAgent: "planner" }; }
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (test_gen) Step one",
          "2. (coder) Step two",
        ],
        messages: [{ role: "assistant" as const, content: "plan", name: "planner" }],
      }),
      test_gen: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "test_gen" }],
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    expect(result.state.plan).toHaveLength(2);
    expect(result.state.plan[0]).toContain("test_gen");
    expect(result.state.plan[1]).toContain("coder");
  });
});
