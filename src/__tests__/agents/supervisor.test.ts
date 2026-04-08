/**
 * Tests for supervisor node behavior — routing decisions and context handling.
 *
 * These tests verify that the supervisor agent:
 *   - Correctly routes based on plan state
 *   - Passes workspace context and chatHistory to buildMessages
 *   - Formats the question correctly with plan step info
 *   - Handles plan exhaustion correctly
 */

import * as vscode from "vscode";
import { createInitialState, type AgentState } from "../../graph/state.js";

const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock message"),
]);
const mockCallModel = jest.fn().mockResolvedValue("coder");

jest.mock("../../agents/base.js", () => {
  const actual = jest.requireActual("../../agents/base.js");
  return {
    ...actual,
    buildMessages: mockBuildMessages,
    callModel: mockCallModel,
  };
});

import { supervisorNode } from "../../agents/supervisor.js";

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

function mockToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(),
  } as any;
}

describe("supervisorNode routing decisions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("routes to 'finish' when LLM says FINISH", async () => {
    mockCallModel.mockResolvedValue("FINISH");
    const state = createInitialState("test");
    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(result.nextAgent).toBe("finish");
    expect(result.status).toBe("completed");
  });

  it("routes to a valid single agent", async () => {
    mockCallModel.mockResolvedValue("coder");
    const state = createInitialState("test");
    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(result.nextAgent).toBe("coder");
  });

  it("routes to comma-separated agents for parallel dispatch", async () => {
    mockCallModel.mockResolvedValue("coder,test_gen");
    const state = createInitialState("test");
    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(result.nextAgent).toBe("coder,test_gen");
    expect(result.pendingAgents).toEqual(["coder", "test_gen"]);
  });

  it("filters out planner when plan already exists", async () => {
    mockCallModel.mockResolvedValue("planner");
    const state = createInitialState("test");
    state.plan = ["1. (coder) Write code"];

    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    // Planner is filtered out when plan exists → defaults to coder
    expect(result.nextAgent).not.toBe("planner");
  });

  it("includes current plan step in the question", async () => {
    mockCallModel.mockResolvedValue("coder");
    const state = createInitialState("Build an API");
    state.plan = [
      "1. (coder) Implement",
      "2. (test_gen) Write tests",
    ];
    state.planStep = 1;

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion).toContain("Plan exists: yes");
    expect(callArgs.userQuestion).toContain("2/2");
    expect(callArgs.userQuestion).toContain("(test_gen) Write tests");
  });

  it("indicates all plan steps addressed when plan is exhausted", async () => {
    mockCallModel.mockResolvedValue("finish");
    const state = createInitialState("test");
    state.plan = ["1. (coder) Write code"];
    state.planStep = 1; // past the last step

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion).toContain("All 1 plan steps addressed");
  });

  it("handles unrecognized LLM response by defaulting to finish", async () => {
    mockCallModel.mockResolvedValue("I think we should use the quantum_agent");
    const state = createInitialState("test");
    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(result.nextAgent).toBe("finish");
  });

  it("includes completed agents in the question", async () => {
    mockCallModel.mockResolvedValue("reviewer");
    const state = createInitialState("test");
    state.messages.push(
      { role: "assistant", name: "planner", content: "plan" },
      { role: "assistant", name: "coder", content: "code" },
      { role: "assistant", name: "test_gen", content: "tests" },
    );

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion).toContain("planner");
    expect(callArgs.userQuestion).toContain("coder");
    expect(callArgs.userQuestion).toContain("coder");
  });

  it("includes quality gate state in question when artifacts present", async () => {
    mockCallModel.mockResolvedValue("coder");
    const state = createInitialState("test");
    state.artifacts["quality_summary"] = "3 errors, 1 warning";

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion).toContain("Quality gate:");
    expect(callArgs.userQuestion).toContain("3 errors");
  });

  it("warns about build errors in question", async () => {
    mockCallModel.mockResolvedValue("coder");
    const state = createInitialState("test");
    state.artifacts["build_errors"] = "true";

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion).toContain("BUILD HAS ERRORS");
  });

  it("caps long questions to prevent context bloat", async () => {
    mockCallModel.mockResolvedValue("finish");
    const state = createInitialState("test");
    // Inflate the plan so the question exceeds the cap
    state.plan = Array.from({ length: 50 }, (_, i) =>
      `${i + 1}. (coder) ${"A really long plan step description ".repeat(10)}`
    );
    state.planStep = 0;

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.userQuestion.length).toBeLessThanOrEqual(4200);
  });

  it("filters failed agents from routing decisions", async () => {
    mockCallModel.mockResolvedValue("coder");
    const state = createInitialState("test");
    state.messages.push({
      role: "system",
      name: "graph-router",
      content: "Previously failed agents: [coder]",
    });

    const result = await supervisorNode(state, mockModel, mockStream(), mockToken());

    // coder was the LLM choice but it's in the failed list → should finish
    expect(result.nextAgent).toBe("finish");
  });
});
