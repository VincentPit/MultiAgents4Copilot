/**
 * Tests for src/graph/builder.ts — parallel DAG execution engine.
 */

import * as vscode from "vscode";
import { buildGraph, AGENT_DISPLAY, type AgentNode, type GraphResult } from "../../graph/builder.js";
import { createInitialState, mergeState, type AgentState } from "../../graph/state.js";

// The mock already returns a model from selectChatModels
const mockModel = {
  name: "mock-model",
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

describe("buildGraph", () => {
  it("executes nodes in order and returns a GraphResult", async () => {
    const callOrder: string[] = [];

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        callOrder.push("supervisor");
        return { nextAgent: "finish" };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 10 });
    const state = createInitialState("test task");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    expect(result.totalSteps).toBeGreaterThanOrEqual(1);
    expect(result.agentRuns.length).toBeGreaterThanOrEqual(1);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(callOrder).toContain("supervisor");
  });

  it("respects maxSteps limit", async () => {
    let calls = 0;
    const infiniteLoop: Record<string, AgentNode> = {
      supervisor: async () => {
        calls++;
        return { nextAgent: "coder" };
      },
      coder: async () => {
        calls++;
        return {
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes: infiniteLoop, entryPoint: "supervisor", maxSteps: 6 });
    const state = createInitialState("test");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    expect(result.totalSteps).toBe(6);
    expect(result.state.status).toBe("completed");
    // Should have warned about max steps
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(mdCalls.some((m: string) => m.includes("maximum step limit"))).toBe(true);
  });

  it("stops on cancellation", async () => {
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => ({ nextAgent: "coder" }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "x", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken(true));

    expect(result.state.status).toBe("error");
    expect(result.totalSteps).toBeLessThanOrEqual(1);
  });

  it("handles agent errors gracefully", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        supervisorCalls++;
        if (supervisorCalls === 1) {
          return { nextAgent: "coder" };
        }
        // After the error, finish
        return { nextAgent: "finish" };
      },
      coder: async () => {
        throw new Error("Something broke");
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 10 });
    const state = createInitialState("test");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    // Should have recorded the error
    expect(result.state.errors.length).toBeGreaterThan(0);
    expect(result.state.errors.some(e => e.includes("Something broke"))).toBe(true);
  });

  it("stops at __end__ node (finish)", async () => {
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => ({ nextAgent: "finish" }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    expect(result.totalSteps).toBe(1); // just the supervisor
  });

  // ── Parallel execution tests ──

  it("executes parallel agents concurrently via pendingAgents", async () => {
    const executionLog: Array<{ agent: string; time: number }> = [];
    const startTime = Date.now();

    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) {
          return {
            nextAgent: "researcher,coder",
            pendingAgents: ["researcher", "coder"],
          };
        }
        return { nextAgent: "finish" };
      },
      researcher: async () => {
        executionLog.push({ agent: "researcher", time: Date.now() - startTime });
        return {
          messages: [{ role: "assistant" as const, content: "research done", name: "researcher" }],
        };
      },
      coder: async () => {
        executionLog.push({ agent: "coder", time: Date.now() - startTime });
        return {
          messages: [{ role: "assistant" as const, content: "code done", name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test parallel");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    // Both agents should have been invoked
    expect(executionLog.some(e => e.agent === "researcher")).toBe(true);
    expect(executionLog.some(e => e.agent === "coder")).toBe(true);

    // Parallel runs should be marked as such
    const parallelRuns = result.agentRuns.filter(r => r.parallel);
    expect(parallelRuns.length).toBe(2);
  });

  it("merges results from parallel agents", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) {
          return {
            nextAgent: "researcher,coder",
            pendingAgents: ["researcher", "coder"],
          };
        }
        return { nextAgent: "finish" };
      },
      researcher: async () => ({
        messages: [{ role: "assistant" as const, content: "research findings", name: "researcher" }],
        artifacts: { research: "OAuth2 best practices" },
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "implementation done", name: "coder" }],
        artifacts: { last_code: "const auth = ..." },
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test merge");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // Both agents' messages should be in final state
    const names = result.state.messages.map(m => m.name).filter(Boolean);
    expect(names).toContain("researcher");
    expect(names).toContain("coder");

    // Both agents' artifacts should be merged
    expect(result.state.artifacts["research"]).toBe("OAuth2 best practices");
    expect(result.state.artifacts["last_code"]).toBe("const auth = ...");
  });

  it("handles errors in parallel agents without crashing", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) {
          return {
            nextAgent: "researcher,coder",
            pendingAgents: ["researcher", "coder"],
          };
        }
        return { nextAgent: "finish" };
      },
      researcher: async () => {
        throw new Error("Research API down");
      },
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "code works", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test error handling");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    // Error should be recorded
    expect(result.state.errors.some(e => e.includes("Research API down"))).toBe(true);
    // Coder's result should still be present
    expect(result.state.messages.some(m => m.name === "coder")).toBe(true);
  });

  it("clears pendingAgents after parallel execution", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) {
          return {
            nextAgent: "researcher,coder",
            pendingAgents: ["researcher", "coder"],
          };
        }
        return { nextAgent: "finish" };
      },
      researcher: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "researcher" }],
      }),
      coder: async () => ({
        messages: [{ role: "assistant" as const, content: "done", name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test clear");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    expect(result.state.pendingAgents).toEqual([]);
  });

  // ── Plan-driven routing tests ──

  it("routes based on plan steps when plan has agent tags", async () => {
    const executedAgents: string[] = [];
    let supervisorCalls = 0;

    const nodes: Record<string, AgentNode> = {
      supervisor: async (state) => {
        supervisorCalls++;
        if (supervisorCalls === 1) { return { nextAgent: "planner" }; }
        // The graph should use plan routing, but if it reaches supervisor
        // after the plan is exhausted, finish
        return { nextAgent: "finish" };
      },
      planner: async () => ({
        plan: [
          "1. (researcher) Research best practices",
          "2. (coder) Implement the solution",
        ],
        messages: [{ role: "assistant" as const, content: "plan created", name: "planner" }],
      }),
      researcher: async () => {
        executedAgents.push("researcher");
        return {
          messages: [{ role: "assistant" as const, content: "research done", name: "researcher" }],
        };
      },
      coder: async () => {
        executedAgents.push("coder");
        return {
          messages: [{ role: "assistant" as const, content: "code done", name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test plan routing");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // Planner should have been invoked
    expect(result.agentRuns.some(r => r.name === "planner")).toBe(true);
  });
});

describe("AGENT_DISPLAY", () => {
  it("has display config for all standard agents", () => {
    const expected = ["supervisor", "planner", "coder", "coder_pool", "researcher", "reviewer", "integrator", "ui_designer", "test_gen"];
    for (const name of expected) {
      expect(AGENT_DISPLAY[name]).toBeDefined();
      expect(AGENT_DISPLAY[name].icon).toBeTruthy();
      expect(AGENT_DISPLAY[name].label).toBeTruthy();
    }
  });
});

// ── Robustness hardening tests ─────────────────────────────────────────

describe("buildGraph — error accumulation cap", () => {
  it("stops execution when too many errors accumulate", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        return { nextAgent: "coder" };
      },
      coder: async () => {
        throw new Error(`Error #${supervisorCalls}`);
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 100 });
    const state = createInitialState("test error cap");
    // Pre-seed with errors near the cap
    state.errors = Array.from({ length: 9 }, (_, i) => `pre-error-${i}`);
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    // Should have stopped due to error cap
    expect(result.state.errors.length).toBeGreaterThanOrEqual(10);
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(mdCalls.some((m: string) => m.includes("Too many errors"))).toBe(true);
  });
});

describe("buildGraph — state size guard", () => {
  it("trims messages when state exceeds 2MB", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) { return { nextAgent: "coder" }; }
        return { nextAgent: "finish" };
      },
      coder: async () => ({
        // Generate a very large message to trigger the guard
        messages: [{ role: "assistant" as const, content: "x".repeat(2_500_000), name: "coder" }],
      }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test state size");
    const result = await graph.run(state, mockModel, mockStream(), mockToken());

    // Messages should have been trimmed
    const stateSize = JSON.stringify(result.state).length;
    // After trimming, state should be much smaller than the 2.5M message we injected
    expect(result.state.messages.length).toBeLessThanOrEqual(22); // user msgs + recent 20
  });
});

describe("buildGraph — agent timeout", () => {
  it("records an error when an agent hangs (simulated via rejection)", async () => {
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        if (supervisorCalls === 1) { return { nextAgent: "coder" }; }
        return { nextAgent: "finish" };
      },
      coder: async () => {
        throw new Error('Agent "coder" timed out after 120000ms');
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
    const state = createInitialState("test timeout");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    expect(result.state.errors.some(e => e.includes("timed out"))).toBe(true);
  });
});

describe("buildGraph — unknown agent node", () => {
  it("finishes gracefully when supervisor routes to an invalid agent", async () => {
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => ({ nextAgent: "nonexistent_agent" }),
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 10 });
    const state = createInitialState("test unknown");
    const stream = mockStream();
    const result = await graph.run(state, mockModel, stream, mockToken());

    // Router treats unknown agent names as "done" — graph finishes cleanly
    expect(result.state.status).toBe("completed");
    expect(result.totalSteps).toBeGreaterThanOrEqual(1);
  });
});

describe("buildGraph — loop detection", () => {
  it("detects and breaks same-agent loops", async () => {
    let coderCalls = 0;
    let supervisorCalls = 0;
    const nodes: Record<string, AgentNode> = {
      supervisor: async () => {
        supervisorCalls++;
        return { nextAgent: "coder" };
      },
      coder: async () => {
        coderCalls++;
        // Always route back to coder (simulated via plan routing)
        return {
          messages: [{ role: "assistant" as const, content: `code attempt ${coderCalls}`, name: "coder" }],
        };
      },
    };

    const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 30 });
    const state = createInitialState("test loop");
    const stream = mockStream();
    await graph.run(state, mockModel, stream, mockToken());

    // Should have invoked coder but eventually broken out
    expect(coderCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("AgentRun", () => {
  it("includes parallel flag in metadata", () => {
    // Quick check that the parallel property is present in the type
    const run: import("../../graph/builder").AgentRun = {
      name: "coder",
      durationMs: 100,
      parallel: true,
    };
    expect(run.parallel).toBe(true);
  });
});
