/**
 * Tests for src/graph/state.ts — state management functions.
 */

import {
  createInitialState,
  mergeState,
  postAgentMessage,
  getMessagesFor,
  type AgentState,
} from "../../graph/state";

describe("createInitialState", () => {
  it("creates state with user message", () => {
    const state = createInitialState("Build a REST API");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toBe("Build a REST API");
  });

  it("initialises all fields to defaults", () => {
    const state = createInitialState("test");
    expect(state.nextAgent).toBe("");
    expect(state.plan).toEqual([]);
    expect(state.pendingAgents).toEqual([]);
    expect(state.planStep).toBe(0);
    expect(state.domainAssignments).toEqual([]);
    expect(state.artifacts).toEqual({});
    expect(state.reviewCount).toBe(0);
    expect(state.finalAnswer).toBe("");
    expect(state.status).toBe("in_progress");
    expect(state.reviewVerdict).toBe("pending");
    expect(state.agentComms).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.terminalResults).toEqual([]);
  });

  it("stores workspace context when provided", () => {
    const state = createInitialState("test", "## Workspace\npackage.json");
    expect(state.workspaceContext).toBe("## Workspace\npackage.json");
  });
});

describe("mergeState", () => {
  let base: AgentState;

  beforeEach(() => {
    base = createInitialState("test");
  });

  it("appends messages instead of replacing", () => {
    const update = {
      messages: [{ role: "assistant" as const, name: "planner", content: "Step 1…" }],
    };
    const merged = mergeState(base, update);
    expect(merged.messages).toHaveLength(2); // user + planner
    expect(merged.messages[0].role).toBe("user");
    expect(merged.messages[1].name).toBe("planner");
  });

  it("merges artifacts instead of replacing", () => {
    base.artifacts = { plan: "original plan" };
    const update = { artifacts: { last_code: "console.log('hi')" } };
    const merged = mergeState(base, update);
    expect(merged.artifacts["plan"]).toBe("original plan");
    expect(merged.artifacts["last_code"]).toBe("console.log('hi')");
  });

  it("appends errors instead of replacing", () => {
    base.errors = ["coder: timeout"];
    const update = { errors: ["reviewer: model error"] };
    const merged = mergeState(base, update);
    expect(merged.errors).toHaveLength(2);
    expect(merged.errors).toContain("coder: timeout");
    expect(merged.errors).toContain("reviewer: model error");
  });

  it("appends terminalResults instead of replacing", () => {
    base.terminalResults = [
      { command: "npm install", success: true, stdout: "", stderr: "", agent: "coder" },
    ];
    const update = {
      terminalResults: [
        { command: "npm test", success: false, stdout: "", stderr: "FAIL", agent: "test_gen" },
      ],
    };
    const merged = mergeState(base, update);
    expect(merged.terminalResults).toHaveLength(2);
    expect(merged.terminalResults[0].command).toBe("npm install");
    expect(merged.terminalResults[1].command).toBe("npm test");
  });

  it("overwrites scalar fields", () => {
    const update = { nextAgent: "coder", status: "completed" as const };
    const merged = mergeState(base, update);
    expect(merged.nextAgent).toBe("coder");
    expect(merged.status).toBe("completed");
  });

  it("appends agentComms instead of replacing", () => {
    base.agentComms = [
      { from: "a", to: "b", type: "info", content: "hi", timestamp: 1 },
    ];
    const update = {
      agentComms: [
        { from: "c", to: "d", type: "request" as const, content: "yo", timestamp: 2 },
      ],
    };
    const merged = mergeState(base, update);
    expect(merged.agentComms).toHaveLength(2);
  });

  it("overwrites pendingAgents (not append)", () => {
    base.pendingAgents = ["researcher"];
    const update = { pendingAgents: ["coder", "test_gen"] };
    const merged = mergeState(base, update);
    // pendingAgents is a scalar-like field: overwrite, not append
    expect(merged.pendingAgents).toEqual(["coder", "test_gen"]);
  });

  it("preserves planStep as a scalar overwrite", () => {
    base.planStep = 0;
    const update = { planStep: 2 };
    const merged = mergeState(base, update);
    expect(merged.planStep).toBe(2);
  });
});

describe("postAgentMessage / getMessagesFor", () => {
  it("posts and retrieves a direct message", () => {
    const state = createInitialState("test");
    postAgentMessage(state, "reviewer", "coder", "request", "Fix the bug");

    const msgs = getMessagesFor(state, "coder");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("reviewer");
    expect(msgs[0].to).toBe("coder");
    expect(msgs[0].content).toBe("Fix the bug");
  });

  it("retrieves broadcast messages", () => {
    const state = createInitialState("test");
    postAgentMessage(state, "researcher", "*", "info", "Found relevant docs");

    const coderMsgs = getMessagesFor(state, "coder");
    const reviewerMsgs = getMessagesFor(state, "reviewer");
    expect(coderMsgs).toHaveLength(1);
    expect(reviewerMsgs).toHaveLength(1);
  });

  it("does not return messages for other agents", () => {
    const state = createInitialState("test");
    postAgentMessage(state, "reviewer", "coder", "request", "Fix the bug");

    const msgs = getMessagesFor(state, "planner");
    expect(msgs).toHaveLength(0);
  });

  it("includes a timestamp", () => {
    const state = createInitialState("test");
    const before = Date.now();
    const msg = postAgentMessage(state, "a", "b", "info", "test");
    const after = Date.now();

    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});
