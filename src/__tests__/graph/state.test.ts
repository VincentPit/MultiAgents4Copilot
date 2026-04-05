/**
 * Tests for src/graph/state.ts — state management functions.
 */

import {
  createInitialState,
  mergeState,
  postAgentMessage,
  getMessagesFor,
  frozenSnapshot,
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

// ── Size cap tests ────────────────────────────────────────────────────

describe("mergeState — size caps", () => {
  let base: AgentState;

  beforeEach(() => {
    base = createInitialState("test");
  });

  it("evicts oldest messages when exceeding 500, keeping first user message", () => {
    // Seed with 499 messages (1 user already in base)
    for (let i = 0; i < 498; i++) {
      base.messages.push({ role: "assistant", name: "coder", content: `msg-${i}` });
    }
    expect(base.messages).toHaveLength(499);

    // Add 10 more in the update — total would be 509, should be capped at 500
    const update = {
      messages: Array.from({ length: 10 }, (_, i) => ({
        role: "assistant" as const,
        name: "coder",
        content: `new-${i}`,
      })),
    };

    const merged = mergeState(base, update);
    expect(merged.messages.length).toBeLessThanOrEqual(500);
    // First message is still the original user message
    expect(merged.messages[0].role).toBe("user");
    expect(merged.messages[0].content).toBe("test");
    // Last messages are the newest ones
    expect(merged.messages[merged.messages.length - 1].content).toBe("new-9");
  });

  it("evicts oldest agentComms when exceeding 200", () => {
    base.agentComms = Array.from({ length: 199 }, (_, i) => ({
      from: "a",
      to: "b",
      type: "info" as const,
      content: `comm-${i}`,
      timestamp: i,
    }));

    const update = {
      agentComms: Array.from({ length: 10 }, (_, i) => ({
        from: "c",
        to: "d",
        type: "info" as const,
        content: `new-comm-${i}`,
        timestamp: 1000 + i,
      })),
    };

    const merged = mergeState(base, update);
    expect(merged.agentComms.length).toBeLessThanOrEqual(200);
    // Should keep the newest ones
    expect(merged.agentComms[merged.agentComms.length - 1].content).toBe("new-comm-9");
  });

  it("evicts oldest errors when exceeding 100", () => {
    base.errors = Array.from({ length: 99 }, (_, i) => `error-${i}`);

    const update = { errors: Array.from({ length: 10 }, (_, i) => `new-error-${i}`) };
    const merged = mergeState(base, update);
    expect(merged.errors.length).toBeLessThanOrEqual(100);
    expect(merged.errors[merged.errors.length - 1]).toBe("new-error-9");
  });

  it("evicts oldest terminalResults when exceeding 50", () => {
    base.terminalResults = Array.from({ length: 49 }, (_, i) => ({
      command: `cmd-${i}`,
      success: true,
      stdout: "",
      stderr: "",
      agent: "coder",
    }));

    const update = {
      terminalResults: Array.from({ length: 10 }, (_, i) => ({
        command: `new-cmd-${i}`,
        success: true,
        stdout: "",
        stderr: "",
        agent: "test_gen",
      })),
    };

    const merged = mergeState(base, update);
    expect(merged.terminalResults.length).toBeLessThanOrEqual(50);
    expect(merged.terminalResults[merged.terminalResults.length - 1].command).toBe("new-cmd-9");
  });

  it("clamps overly long finalAnswer", () => {
    const update = { finalAnswer: "x".repeat(200_000) };
    const merged = mergeState(base, update);
    expect(merged.finalAnswer.length).toBeLessThanOrEqual(100_100); // 100K + truncation notice
    expect(merged.finalAnswer).toContain("[... truncated]");
  });

  it("clamps overly long workspaceContext", () => {
    const update = { workspaceContext: "y".repeat(200_000) };
    const merged = mergeState(base, update);
    expect(merged.workspaceContext.length).toBeLessThanOrEqual(100_000);
  });

  it("does not modify state that's within limits", () => {
    const update = {
      messages: [{ role: "assistant" as const, content: "ok", name: "coder" }],
      finalAnswer: "short answer",
    };
    const merged = mergeState(base, update);
    expect(merged.messages).toHaveLength(2);
    expect(merged.finalAnswer).toBe("short answer");
  });
});

// ── Frozen snapshot tests ────────────────────────────────────────────

describe("frozenSnapshot", () => {
  it("returns an object frozen with Object.freeze", () => {
    const state = createInitialState("test");
    const snap = frozenSnapshot(state);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("produces a deep copy — mutations to original don't affect snapshot", () => {
    const state = createInitialState("test");
    const snap = frozenSnapshot(state);

    // Mutate original
    state.messages.push({ role: "assistant", content: "added", name: "x" });
    state.errors.push("new error");
    state.artifacts["key"] = "value";

    // Snapshot should be unchanged
    expect(snap.messages).toHaveLength(1);
    expect(snap.errors).toHaveLength(0);
    expect(snap.artifacts).toEqual({});
  });

  it("produces a deep copy — mutations to snapshot throw in strict mode", () => {
    const state = createInitialState("test");
    const snap = frozenSnapshot(state);

    // Attempting to mutate frozen object should throw
    expect(() => {
      (snap as any).nextAgent = "coder";
    }).toThrow();
  });

  it("preserves all fields from the original state", () => {
    const state = createInitialState("hello", "workspace info");
    state.nextAgent = "planner";
    state.planStep = 3;
    state.plan = ["step1", "step2", "step3", "step4"];
    state.reviewCount = 2;
    state.finalAnswer = "done";
    state.status = "completed";
    state.reviewVerdict = "approve";

    const snap = frozenSnapshot(state);

    expect(snap.messages[0].content).toBe("hello");
    expect(snap.workspaceContext).toBe("workspace info");
    expect(snap.nextAgent).toBe("planner");
    expect(snap.planStep).toBe(3);
    expect(snap.plan).toEqual(["step1", "step2", "step3", "step4"]);
    expect(snap.reviewCount).toBe(2);
    expect(snap.finalAnswer).toBe("done");
    expect(snap.status).toBe("completed");
    expect(snap.reviewVerdict).toBe("approve");
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
