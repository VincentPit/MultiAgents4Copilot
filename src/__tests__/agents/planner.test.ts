/**
 * Tests for the planner agent node — plan decomposition and response parsing.
 */

import * as vscode from "vscode";
import { createInitialState } from "../../graph/state.js";

const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock message"),
]);
const mockCallModel = jest.fn().mockResolvedValue("");

jest.mock("../../agents/base.js", () => {
  const actual = jest.requireActual("../../agents/base.js");
  return {
    ...actual,
    buildMessages: mockBuildMessages,
    callModel: mockCallModel,
  };
});

import { plannerNode, MAX_PLAN_CHARS, MAX_PLAN_STEPS } from "../../agents/planner.js";

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

describe("planner constants", () => {
  it("exports MAX_PLAN_CHARS", () => {
    expect(MAX_PLAN_CHARS).toBe(6_000);
  });

  it("exports MAX_PLAN_STEPS", () => {
    expect(MAX_PLAN_STEPS).toBe(12);
  });
});

describe("plannerNode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("parses numbered lines into plan steps", async () => {
    mockCallModel.mockResolvedValue(
      "1. (coder) Write the module\n2. (test_gen) Write tests\n3. (reviewer) Review"
    );
    const state = createInitialState("Build a REST API");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.plan).toHaveLength(3);
    expect(result.plan![0]).toContain("(coder)");
    expect(result.plan![2]).toContain("(reviewer)");
  });

  it("handles numbered lines with ) delimiter", async () => {
    mockCallModel.mockResolvedValue(
      "1) (planner) Decompose\n2) (coder) Implement"
    );
    const state = createInitialState("Do stuff");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.plan).toHaveLength(2);
  });

  it("falls back to full response when no numbered lines found", async () => {
    mockCallModel.mockResolvedValue("Just do everything at once.");
    const state = createInitialState("Quick task");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.plan).toHaveLength(1);
    expect(result.plan![0]).toBe("Just do everything at once.");
  });

  it("caps plan steps at MAX_PLAN_STEPS", async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `${i + 1}. (coder) Step ${i + 1}`
    ).join("\n");
    mockCallModel.mockResolvedValue(lines);
    const state = createInitialState("Huge task");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.plan!.length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
  });

  it("caps response stored in messages at MAX_PLAN_CHARS", async () => {
    const longResponse = "1. (coder) Step\n" + "x".repeat(MAX_PLAN_CHARS + 1000);
    mockCallModel.mockResolvedValue(longResponse);
    const state = createInitialState("Big task");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    const msgContent = result.messages![0].content;
    expect(msgContent.length).toBeLessThanOrEqual(MAX_PLAN_CHARS + 100);
    expect(msgContent).toContain("[… plan truncated in state]");
  });

  it("does not truncate short responses", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Write code");
    const state = createInitialState("Small task");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.messages![0].content).not.toContain("truncated");
  });

  it("sets message role and name correctly", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Do things");
    const state = createInitialState("Task");
    const result = await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(result.messages![0].role).toBe("assistant");
    expect(result.messages![0].name).toBe("planner");
  });

  it("passes workspace context and references to buildMessages", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Go");
    const state = createInitialState("Task");
    state.workspaceContext = "project files here";
    state.references = "ref content";
    state.chatHistory = "prior chat";

    await plannerNode(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.workspaceContext).toBe("project files here");
    expect(opts.references).toBe("ref content");
    expect(opts.chatHistory).toBe("prior chat");
  });

  it("uses the last user message as the question", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Done");
    const state = createInitialState("ignored");
    state.messages.push(
      { role: "assistant", name: "supervisor", content: "routing" },
      { role: "user", content: "Build me a chat app" },
    );

    await plannerNode(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.userQuestion).toBe("Build me a chat app");
  });

  it("renders a markdown header in the stream", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Code");
    const state = createInitialState("Task");
    const stream = mockStream();

    await plannerNode(state, mockModel, stream, mockToken());

    expect((stream.markdown as jest.Mock).mock.calls[0][0]).toContain("Planner");
  });
});
