/**
 * End-to-end project build simulation tests.
 *
 * These tests mimic the FULL lifecycle of building a project through the
 * multi-agent graph: supervisor → planner → coder_pool → integrator → reviewer.
 *
 * All LLM calls are mocked — these validate that the orchestration pipeline
 * correctly chains agents, handles errors, recovers from timeouts, and
 * produces a coherent final state with files, tests, and review verdicts.
 */

import * as vscode from "vscode";
import { buildGraph, type AgentNode, type GraphResult } from "../../graph/builder.js";
import { createInitialState, mergeState, type AgentState, type DomainAssignment, type BranchResult } from "../../graph/state.js";

// ── Test helpers ─────────────────────────────────────────────────────

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

// ── Simulated agent behaviors ────────────────────────────────────────

/** Supervisor that follows the standard routing protocol. */
function createSupervisor(): { node: AgentNode; calls: string[] } {
  const calls: string[] = [];
  let callCount = 0;

  const node: AgentNode = async (state) => {
    callCount++;
    calls.push(`call-${callCount}`);

    // No plan yet → route to planner
    if (state.plan.length === 0) {
      return { nextAgent: "planner" };
    }

    // Coder pool just ran → route to integrator
    const hasCoderPoolOutput = state.messages.some(m => m.name === "coder_pool");
    const hasIntegratorOutput = state.messages.some(m => m.name === "integrator");

    if (hasCoderPoolOutput && !hasIntegratorOutput) {
      return { nextAgent: "integrator" };
    }

    // Integrator done → route to reviewer
    if (hasIntegratorOutput && state.reviewVerdict === "pending") {
      return { nextAgent: "reviewer" };
    }

    // Reviewer said revise → route back to coder
    if (state.reviewVerdict === "revise" && state.reviewCount < 2) {
      return { nextAgent: "coder" };
    }

    // Done
    return { nextAgent: "finish", status: "completed" as const };
  };

  return { node, calls };
}

/** Planner that decomposes a project into phases. */
function createPlanner(): AgentNode {
  return async (state) => ({
    plan: [
      "1. (coder_pool) Build all project domains in parallel",
      "2. (integrator) Merge domain outputs and write glue code",
      "3. (reviewer) Review the integrated codebase",
    ],
    messages: [{
      role: "assistant" as const,
      content: "## Project Plan\n\n1. Parallel domain coding\n2. Integration\n3. Review",
      name: "planner",
    }],
  });
}

/** Coder pool that simulates parallel domain decomposition and coding. */
function createCoderPool(opts?: { shouldFail?: boolean; fileCount?: number }): { node: AgentNode; filesWritten: string[] } {
  const filesWritten: string[] = [];
  const fileCount = opts?.fileCount ?? 8;

  const node: AgentNode = async (state) => {
    if (opts?.shouldFail) {
      throw new Error("LLM rate limit exceeded");
    }

    // Simulate domain decomposition
    const domains: DomainAssignment[] = [
      {
        id: "backend-api",
        domain: "Backend API",
        description: "REST API with Express, routes, middleware, auth",
        filePatterns: ["src/api/**", "src/routes/**"],
        provides: "GET /api/items, POST /api/items, AuthMiddleware",
        consumes: "ItemService from data-layer",
      },
      {
        id: "data-layer",
        domain: "Data Layer",
        description: "Database models, repositories, services",
        filePatterns: ["src/models/**", "src/services/**"],
        provides: "ItemService, DatabaseClient",
        consumes: "Item type from shared-types",
      },
      {
        id: "frontend",
        domain: "Frontend UI",
        description: "React components, pages, hooks",
        filePatterns: ["src/components/**", "src/pages/**"],
        provides: "App component, ItemList page",
        consumes: "API routes from backend-api",
      },
    ];

    // Simulate files each domain coder would write
    const domainFiles: Record<string, string[]> = {
      "backend-api": ["src/routes/items.ts", "src/middleware/auth.ts", "src/api/server.ts"],
      "data-layer": ["src/models/item.ts", "src/services/itemService.ts"],
      "frontend": ["src/components/ItemList.tsx", "src/pages/Home.tsx", "src/App.tsx"],
    };

    const branchResults: BranchResult[] = domains.map(d => {
      const files = domainFiles[d.id] || [];
      filesWritten.push(...files);
      return {
        domainId: d.id,
        domain: d.domain,
        filesWritten: files,
        testsPassed: true,
        testOutput: `✓ ${d.domain}: all ${files.length} unit tests pass`,
        errors: [],
        fixAttempts: 0,
        code: files.map(f => `### \`${f}\`\n\`\`\`typescript\n// ${d.domain} — ${f}\nexport {};\n\`\`\``).join("\n\n"),
        durationMs: 15_000 + Math.random() * 10_000,
      };
    });

    const allFiles = branchResults.flatMap(b => b.filesWritten);

    return {
      messages: [{
        role: "assistant" as const,
        content: `## Engineering Team Complete\n\n${domains.length} domains, ${allFiles.length} files written.\n\n${branchResults.map(b => `- **${b.domain}**: ${b.filesWritten.length} files, tests ${b.testsPassed ? "✅" : "❌"}`).join("\n")}`,
        name: "coder_pool",
      }],
      domainAssignments: domains,
      branchResults,
      artifacts: {
        files_written: allFiles.join(", "),
        domain_count: String(domains.length),
      },
    };
  };

  return { node, filesWritten };
}

/** Integrator that merges domain outputs. */
function createIntegrator(): AgentNode {
  return async (state) => {
    const domainCount = state.domainAssignments.length;
    const branchCount = state.branchResults.length;

    return {
      messages: [{
        role: "assistant" as const,
        content: `## Integration Report\n\n` +
          `- ✅ ${domainCount} domain contracts validated\n` +
          `- 🔗 Created shared types, barrel exports, entry point\n` +
          `- 🧪 3 integration tests written\n` +
          `- ⚠️ No issues found\n\n` +
          `### \`src/types/shared.ts\`\n\`\`\`typescript\nexport interface Item { id: string; name: string; }\n\`\`\`\n\n` +
          `### \`src/index.ts\`\n\`\`\`typescript\nimport { createServer } from './api/server';\ncreateServer();\n\`\`\``,
        name: "integrator",
      }],
      artifacts: {
        integration_report: `${domainCount} domains integrated, ${branchCount} branches merged`,
        quality_summary: "Build: ✅ | Lint: ✅ | Tests: 12/12 pass",
      },
    };
  };
}

/** Reviewer that inspects the final output. */
function createReviewer(verdict: "approve" | "revise" = "approve"): AgentNode {
  return async (state) => ({
    messages: [{
      role: "assistant" as const,
      content: verdict === "approve"
        ? "## Code Review: ✅ Approved\n\nAll domains are well-structured. Integration tests pass."
        : "## Code Review: 🔄 Revisions Needed\n\nMissing error handling in API routes.",
      name: "reviewer",
    }],
    reviewVerdict: verdict,
    reviewCount: state.reviewCount + 1,
    status: verdict === "approve" ? "completed" as const : "in_progress" as const,
  });
}

/** Single coder for fallback or revision scenarios. */
function createCoder(): AgentNode {
  return async (state) => ({
    messages: [{
      role: "assistant" as const,
      content: "### `src/routes/items.ts`\n```typescript\n// Added error handling\nexport {};\n```",
      name: "coder",
    }],
  });
}

// ── Test suites ──────────────────────────────────────────────────────

describe("E2E Project Build Simulation", () => {

  describe("Happy path — full project build", () => {
    it("completes: supervisor → planner → coder_pool → integrator → reviewer (approve)", async () => {
      const executionOrder: string[] = [];

      const supervisor = createSupervisor();
      const coderPool = createCoderPool();

      const nodes: Record<string, AgentNode> = {
        supervisor: async (state) => {
          executionOrder.push("supervisor");
          return supervisor.node(state, mockModel, mockStream(), mockToken());
        },
        planner: async (state) => {
          executionOrder.push("planner");
          return createPlanner()(state, mockModel, mockStream(), mockToken());
        },
        coder_pool: async (state) => {
          executionOrder.push("coder_pool");
          return coderPool.node(state, mockModel, mockStream(), mockToken());
        },
        integrator: async (state) => {
          executionOrder.push("integrator");
          return createIntegrator()(state, mockModel, mockStream(), mockToken());
        },
        reviewer: async (state) => {
          executionOrder.push("reviewer");
          return createReviewer("approve")(state, mockModel, mockStream(), mockToken());
        },
        coder: async (state) => {
          executionOrder.push("coder");
          return createCoder()(state, mockModel, mockStream(), mockToken());
        },
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build a full-stack inventory management app with React and Express");
      const stream = mockStream();
      const result = await graph.run(state, mockModel, stream, mockToken());

      // Verify execution order
      expect(executionOrder).toEqual([
        "supervisor",    // routes to planner
        "planner",       // creates 3-step plan
        "coder_pool",    // plan step 0: parallel domain coding
        "integrator",    // plan step 1: merge & glue
        "reviewer",      // plan step 2: review → approve → done
      ]);

      // Verify final state
      expect(result.state.status).toBe("completed");
      expect(result.state.plan).toHaveLength(3);
      expect(result.state.reviewVerdict).toBe("approve");

      // Verify domain work was done
      expect(result.state.domainAssignments).toHaveLength(3);
      expect(result.state.branchResults).toHaveLength(3);
      expect(result.state.branchResults.every(b => b.testsPassed)).toBe(true);

      // Verify artifacts from integration
      expect(result.state.artifacts["integration_report"]).toContain("3 domains integrated");
      expect(result.state.artifacts["quality_summary"]).toContain("Tests: 12/12");

      // Verify messages from each agent exist
      const agentNames = result.state.messages.filter(m => m.name).map(m => m.name!);
      expect(agentNames).toContain("planner");
      expect(agentNames).toContain("coder_pool");
      expect(agentNames).toContain("integrator");
      expect(agentNames).toContain("reviewer");

      // Verify files were tracked
      expect(coderPool.filesWritten.length).toBeGreaterThanOrEqual(8);
    });

    it("produces correct summary with agent timings and step count", async () => {
      const nodes: Record<string, AgentNode> = {
        supervisor: createSupervisor().node,
        planner: createPlanner(),
        coder_pool: createCoderPool().node,
        integrator: createIntegrator(),
        reviewer: createReviewer("approve"),
        coder: createCoder(),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build a TODO app");
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      expect(result.totalSteps).toBeGreaterThanOrEqual(5);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.agentRuns.length).toBeGreaterThanOrEqual(5);

      // Every agent run should have a name and duration
      for (const run of result.agentRuns) {
        expect(run.name).toBeTruthy();
        expect(typeof run.durationMs).toBe("number");
      }
    });
  });

  describe("Coder pool failure → fallback to single coder", () => {
    it("falls back to single coder when coder_pool throws", async () => {
      const executionOrder: string[] = [];

      const nodes: Record<string, AgentNode> = {
        supervisor: async (state) => {
          executionOrder.push("supervisor");

          if (state.plan.length === 0) {
            return { nextAgent: "planner" };
          }

          // After coder/fallback completes → finish
          const hasCoderOutput = state.messages.some(m => m.name === "coder");
          if (hasCoderOutput) {
            return { nextAgent: "finish", status: "completed" as const };
          }

          return { nextAgent: "finish", status: "completed" as const };
        },
        planner: async () => {
          executionOrder.push("planner");
          return createPlanner()(null as any, mockModel, mockStream(), mockToken());
        },
        coder_pool: async () => {
          executionOrder.push("coder_pool");
          throw new Error("Rate limited — too many parallel LLM calls");
        },
        coder: async (state) => {
          executionOrder.push("coder");
          return createCoder()(state, mockModel, mockStream(), mockToken());
        },
        integrator: async (state) => {
          executionOrder.push("integrator");
          return createIntegrator()(state, mockModel, mockStream(), mockToken());
        },
        reviewer: async (state) => {
          executionOrder.push("reviewer");
          return createReviewer("approve")(state, mockModel, mockStream(), mockToken());
        },
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build a REST API");
      const stream = mockStream();
      const result = await graph.run(state, mockModel, stream, mockToken());

      // coder_pool fails → automatic fallback to single coder → supervisor → finish
      expect(executionOrder).toContain("coder_pool");
      expect(executionOrder).toContain("coder"); // fallback

      // Error should be recorded
      expect(result.state.errors.some(e => e.includes("Rate limited"))).toBe(true);

      // Graph should still complete (not hang)
      expect(result.state.status).toBe("completed");

      // Verify the fallback message was shown
      const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(mdCalls.some((m: string) => m.includes("Falling back"))).toBe(true);
    });
  });

  describe("Reviewer revision cycle", () => {
    it("handles revise → coder → reviewer → approve cycle", async () => {
      const executionOrder: string[] = [];
      let reviewCalls = 0;
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async (state) => {
          supervisorCalls++;
          executionOrder.push("supervisor");

          if (state.plan.length === 0) {
            return { nextAgent: "planner" };
          }

          const hasCoderPoolOutput = state.messages.some(m => m.name === "coder_pool");
          const hasIntegratorOutput = state.messages.some(m => m.name === "integrator");

          if (hasCoderPoolOutput && !hasIntegratorOutput) {
            return { nextAgent: "integrator" };
          }
          if (hasIntegratorOutput && state.reviewVerdict === "pending") {
            return { nextAgent: "reviewer" };
          }
          // After revision: coder just ran, send back to reviewer
          if (state.reviewVerdict === "revise" && state.messages.some(m => m.name === "coder")) {
            // Check if coder already did the fix (messages count)
            const coderMsgCount = state.messages.filter(m => m.name === "coder").length;
            if (coderMsgCount >= reviewCalls) {
              return { nextAgent: "reviewer" };
            }
            return { nextAgent: "coder" };
          }
          if (state.reviewVerdict === "revise") {
            return { nextAgent: "coder" };
          }
          if (state.reviewVerdict === "approve") {
            return { nextAgent: "finish", status: "completed" as const };
          }
          return { nextAgent: "finish", status: "completed" as const };
        },
        planner: async () => {
          executionOrder.push("planner");
          return createPlanner()(null as any, mockModel, mockStream(), mockToken());
        },
        coder_pool: async (state) => {
          executionOrder.push("coder_pool");
          return createCoderPool().node(state, mockModel, mockStream(), mockToken());
        },
        integrator: async (state) => {
          executionOrder.push("integrator");
          return createIntegrator()(state, mockModel, mockStream(), mockToken());
        },
        reviewer: async (state) => {
          reviewCalls++;
          executionOrder.push("reviewer");
          // First review: revise; second review: approve
          const verdict = reviewCalls === 1 ? "revise" : "approve";
          return createReviewer(verdict)(state, mockModel, mockStream(), mockToken());
        },
        coder: async (state) => {
          executionOrder.push("coder");
          return createCoder()(state, mockModel, mockStream(), mockToken());
        },
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 25 });
      const state = createInitialState("Build an API with proper error handling");
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      // Should see the revision cycle: reviewer → (routeReviewer → coder) → supervisor → reviewer
      expect(executionOrder).toContain("reviewer");
      expect(executionOrder).toContain("coder"); // revision

      // Final verdict should be approve
      expect(result.state.reviewVerdict).toBe("approve");
      expect(result.state.reviewCount).toBe(2);
      expect(result.state.status).toBe("completed");
    });
  });

  describe("Multiple agent failures → graceful finish", () => {
    it("finishes gracefully when multiple agents fail", async () => {
      // When coder_pool fails, the graph auto-falls-back to single coder.
      // If coder also fails, then on the next supervisor failure attempt
      // the failedAgents set hits the threshold and graph finishes.
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async (state) => {
          supervisorCalls++;
          if (supervisorCalls === 1) { return { nextAgent: "coder_pool" }; }
          // After coder_pool→coder both fail, supervisor routes to test_gen
          if (supervisorCalls === 2) { return { nextAgent: "test_gen" }; }
          if (supervisorCalls === 3) { return { nextAgent: "integrator" }; }
          return { nextAgent: "finish" };
        },
        coder_pool: async () => { throw new Error("coder_pool: API error"); },
        coder: async () => { throw new Error("coder: model not available"); },
        test_gen: async () => { throw new Error("test_gen: context too large"); },
        integrator: async (state) => createIntegrator()(state, mockModel, mockStream(), mockToken()),
        reviewer: async (state) => createReviewer()(state, mockModel, mockStream(), mockToken()),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build something");
      const stream = mockStream();
      const result = await graph.run(state, mockModel, stream, mockToken());

      // Should have recorded failures (coder_pool auto-fallback to coder, both fail)
      expect(result.state.errors.length).toBeGreaterThanOrEqual(2);

      // Should have finished (not hung)
      expect(["completed", "error"]).toContain(result.state.status);

      // Should show either "too many agents failed" or the graph completed with errors
      const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const hasFailMsg = mdCalls.some((m: string) =>
        m.includes("Too many agents failed") || m.includes("encountered an error")
      );
      expect(hasFailMsg).toBe(true);
    });
  });

  describe("Supervisor failure → graceful exit", () => {
    it("finishes when supervisor itself throws (no infinite loop)", async () => {
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async (state) => {
          supervisorCalls++;
          if (supervisorCalls === 1) {
            return { nextAgent: "coder" };
          }
          // Second call: supervisor crashes (e.g. LLM timeout)
          throw new Error("Idle timeout: no tokens received for 60s");
        },
        coder: async () => ({
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        }),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build something");
      const stream = mockStream();
      const result = await graph.run(state, mockModel, stream, mockToken());

      // Should have stopped, not looped
      expect(supervisorCalls).toBe(2);
      expect(result.state.status).toBe("completed");

      // Should show the supervisor failure message
      const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(mdCalls.some((m: string) => m.includes("Supervisor") && m.includes("failed"))).toBe(true);
    });
  });

  describe("Max steps limit respected", () => {
    it("stops at maxSteps even with valid routing", async () => {
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async () => {
          supervisorCalls++;
          return { nextAgent: "coder" };
        },
        coder: async () => ({
          messages: [{ role: "assistant" as const, content: "code", name: "coder" }],
        }),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 8 });
      const state = createInitialState("Infinite refactoring");
      const stream = mockStream();
      const result = await graph.run(state, mockModel, stream, mockToken());

      expect(result.totalSteps).toBe(8);
      expect(result.state.status).toBe("completed");
    });
  });

  describe("Parallel domain coding simulation", () => {
    it("handles supervisor dispatching parallel agents via pendingAgents", async () => {
      const executionOrder: string[] = [];
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async () => {
          supervisorCalls++;
          executionOrder.push("supervisor");
          if (supervisorCalls === 1) {
            // Dispatch coder and test_gen in parallel
            return {
              nextAgent: "coder,test_gen",
              pendingAgents: ["coder", "test_gen"],
            };
          }
          return { nextAgent: "finish" };
        },
        coder: async () => {
          executionOrder.push("coder");
          return {
            messages: [{ role: "assistant" as const, content: "code done", name: "coder" }],
          };
        },
        test_gen: async () => {
          executionOrder.push("test_gen");
          return {
            messages: [{ role: "assistant" as const, content: "tests done", name: "test_gen" }],
          };
        },
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Code and test simultaneously");
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      // Both parallel agents should have run
      expect(executionOrder).toContain("coder");
      expect(executionOrder).toContain("test_gen");

      // After parallel batch, should route back to supervisor → finish
      expect(result.state.status).toBe("completed");
    });
  });

  describe("Large project simulation — multiple domains with branch results", () => {
    it("processes 3 domains, 8+ files, integration, and review in correct order", async () => {
      const nodes: Record<string, AgentNode> = {
        supervisor: createSupervisor().node,
        planner: createPlanner(),
        coder_pool: createCoderPool({ fileCount: 8 }).node,
        integrator: createIntegrator(),
        reviewer: createReviewer("approve"),
        coder: createCoder(),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState(
        "Build a full-stack e-commerce platform with user auth, product catalog, " +
        "shopping cart, checkout flow, order management, and admin dashboard"
      );
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      // Verify the complete pipeline ran
      expect(result.state.status).toBe("completed");
      expect(result.state.plan).toHaveLength(3);
      expect(result.state.domainAssignments).toHaveLength(3);
      expect(result.state.branchResults).toHaveLength(3);

      // Every branch should report success
      for (const branch of result.state.branchResults) {
        expect(branch.testsPassed).toBe(true);
        expect(branch.filesWritten.length).toBeGreaterThan(0);
        expect(branch.errors).toHaveLength(0);
        expect(branch.domainId).toBeTruthy();
        expect(branch.domain).toBeTruthy();
        expect(branch.code).toBeTruthy();
      }

      // Integration artifacts should exist
      expect(result.state.artifacts["integration_report"]).toBeTruthy();
      expect(result.state.artifacts["quality_summary"]).toBeTruthy();

      // Review should be approved
      expect(result.state.reviewVerdict).toBe("approve");
    });
  });

  describe("State integrity throughout pipeline", () => {
    it("preserves all messages from every agent in correct order", async () => {
      const nodes: Record<string, AgentNode> = {
        supervisor: createSupervisor().node,
        planner: createPlanner(),
        coder_pool: createCoderPool().node,
        integrator: createIntegrator(),
        reviewer: createReviewer("approve"),
        coder: createCoder(),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("Build an app");
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      // First message should be the user's
      expect(result.state.messages[0].role).toBe("user");
      expect(result.state.messages[0].content).toBe("Build an app");

      // Should have messages from planner, coder_pool, integrator, reviewer
      const namedMessages = result.state.messages.filter(m => m.name);
      const agentOrder = namedMessages.map(m => m.name!);

      // planner comes before coder_pool
      const plannerIdx = agentOrder.indexOf("planner");
      const cpIdx = agentOrder.indexOf("coder_pool");
      expect(plannerIdx).toBeLessThan(cpIdx);

      // coder_pool comes before integrator
      const intIdx = agentOrder.indexOf("integrator");
      expect(cpIdx).toBeLessThan(intIdx);

      // integrator comes before reviewer
      const revIdx = agentOrder.indexOf("reviewer");
      expect(intIdx).toBeLessThan(revIdx);
    });

    it("errors array accumulates correctly across failed agents", async () => {
      let supervisorCalls = 0;

      const nodes: Record<string, AgentNode> = {
        supervisor: async () => {
          supervisorCalls++;
          if (supervisorCalls === 1) { return { nextAgent: "coder_pool" }; }
          // After fallback coder runs, finish
          return { nextAgent: "finish", status: "completed" as const };
        },
        coder_pool: async () => { throw new Error("pool exploded"); },
        coder: async () => ({
          messages: [{ role: "assistant" as const, content: "saved it", name: "coder" }],
        }),
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("test");
      const result = await graph.run(state, mockModel, mockStream(), mockToken());

      // Should have the coder_pool error
      expect(result.state.errors.some(e => e.includes("pool exploded"))).toBe(true);
      // Coder fallback should have run after coder_pool failure
      expect(result.state.messages.some(m => m.name === "coder")).toBe(true);
    });
  });

  describe("Cancellation mid-pipeline", () => {
    it("stops immediately when cancellation token fires", async () => {
      let agentCallCount = 0;
      const cancelToken = mockToken(false);

      const nodes: Record<string, AgentNode> = {
        supervisor: async () => {
          agentCallCount++;
          // Cancel after first supervisor call
          cancelToken.isCancellationRequested = true;
          return { nextAgent: "planner" };
        },
        planner: async () => {
          agentCallCount++;
          return { plan: ["1. (coder) Code"], messages: [] };
        },
        coder: async () => {
          agentCallCount++;
          return { messages: [] };
        },
      };

      const graph = buildGraph({ nodes, entryPoint: "supervisor", maxSteps: 20 });
      const state = createInitialState("test cancel");
      const result = await graph.run(state, mockModel, mockStream(), cancelToken);

      // Should have stopped after supervisor (cancellation checked at loop top)
      expect(result.state.status).toBe("error");
      expect(result.totalSteps).toBeLessThanOrEqual(2);
    });
  });
});
