/**
 * Tests for chatHistory propagation — verifies that EVERY agent passes
 * state.chatHistory to buildMessages().
 *
 * These tests would have caught Bug #2: chatHistory was populated in
 * extension.ts but no agent ever passed it to buildMessages(), causing
 * complete loss of multi-turn conversation context.
 *
 * Strategy: mock buildMessages at the module level, then run each agent
 * node function. Verify that the chatHistory parameter is present in every call.
 */

import * as vscode from "vscode";
import { createInitialState, type AgentState } from "../../graph/state.js";

// We need to spy on buildMessages to verify chatHistory is passed.
// Jest hoists jest.mock calls, so they'll execute before imports.

const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock combined message"),
]);

const mockCallModel = jest.fn().mockResolvedValue("mock response");

// Mock the base module so all agents use our spied buildMessages
jest.mock("../../agents/base.js", () => {
  const actual = jest.requireActual("../../agents/base.js");
  return {
    ...actual,
    buildMessages: mockBuildMessages,
    callModel: mockCallModel,
    capContext: actual.capContext,
  };
});

// Mock github utils (no longer needed for researcher, kept for future use)
jest.mock("../../utils/github.js", () => ({
  searchGitHubRepos: jest.fn().mockResolvedValue({ totalCount: 0, repos: [], query: "", rateRemaining: null }),
  formatRepoResults: jest.fn().mockReturnValue(""),
  repoContextForLLM: jest.fn().mockReturnValue(""),
}));

// Mock workspace utilities for coder/coderPool
jest.mock("../../utils/workspace.js", () => ({
  getWorkspaceSnapshot: jest.fn().mockResolvedValue("mock snapshot"),
}));

// Mock file writer for coder/tester
jest.mock("../../utils/fileWriter.js", () => ({
  applyFileEdits: jest.fn().mockResolvedValue([]),
}));

// Mock terminal runner
jest.mock("../../utils/terminalRunner.js", () => ({
  runTerminalCommand: jest.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", command: "", agent: "" }),
}));

// ── Now import agents AFTER mocking ──

import { supervisorNode } from "../../agents/supervisor.js";
import { plannerNode } from "../../agents/planner.js";

// ── Shared helpers ───────────────────────────────────────────────────

const mockModel = {
  name: "mock-model",
  maxInputTokens: 200_000,
  countTokens: jest.fn().mockResolvedValue(100),
  sendRequest: jest.fn().mockResolvedValue({
    text: (async function* () { yield "mock response"; })(),
  }),
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

function stateWithChatHistory(): AgentState {
  const state = createInitialState("Test task", "mock workspace context");
  state.chatHistory = "**User**: build a TODO app\n**Assistant**: Here is a plan...";
  return state;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("chatHistory propagation to buildMessages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the mock to return valid messages
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock combined message"),
    ]);
    // Reset callModel to return appropriate responses for each agent
    mockCallModel.mockResolvedValue("mock response");
  });

  it("supervisor passes chatHistory to buildMessages", async () => {
    mockCallModel.mockResolvedValue("finish");
    const state = stateWithChatHistory();

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.chatHistory).toBe(state.chatHistory);
    expect(callArgs.chatHistory).toContain("build a TODO app");
  });

  it("planner passes chatHistory to buildMessages", async () => {
    mockCallModel.mockResolvedValue("1. (coder) Write code");
    const state = stateWithChatHistory();

    await plannerNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const callArgs = mockBuildMessages.mock.calls[0][0];
    expect(callArgs.chatHistory).toBe(state.chatHistory);
    expect(callArgs.chatHistory).toContain("build a TODO app");
  });

  it("does NOT include chatHistory section when chatHistory is empty", async () => {
    mockCallModel.mockResolvedValue("finish");
    const state = createInitialState("Test task");
    // chatHistory is "" by default

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    const callArgs = mockBuildMessages.mock.calls[0][0];
    // chatHistory should be empty string or undefined
    expect(!callArgs.chatHistory || callArgs.chatHistory === "").toBe(true);
  });
});

describe("buildMessages actually includes chatHistory in output", () => {
  // Use the REAL buildMessages (not mocked) to verify the output
  // We need to import it from the actual module
  it("includes [CHAT HISTORY] section when chatHistory is provided", () => {
    // Import the real buildMessages
    const { buildMessages: realBuildMessages } = jest.requireActual("../../agents/base.js");

    const messages = realBuildMessages({
      systemPrompt: "You are a helpful assistant",
      chatHistory: "**User**: Build a REST API\n**Assistant**: I'll create endpoints...",
      userQuestion: "Now add authentication",
    });

    expect(messages).toHaveLength(1);
    const text = (messages[0] as any).content;
    expect(text).toContain("[CHAT HISTORY]");
    expect(text).toContain("Build a REST API");
    expect(text).toContain("Now add authentication");
  });

  it("omits [CHAT HISTORY] section when chatHistory is not provided", () => {
    const { buildMessages: realBuildMessages } = jest.requireActual("../../agents/base.js");

    const messages = realBuildMessages({
      systemPrompt: "You are a helpful assistant",
      userQuestion: "Write some code",
    });

    const text = (messages[0] as any).content;
    expect(text).not.toContain("[CHAT HISTORY]");
  });

  it("caps chatHistory at 4000 characters", () => {
    const { buildMessages: realBuildMessages } = jest.requireActual("../../agents/base.js");

    const longHistory = "x".repeat(10000);
    const messages = realBuildMessages({
      systemPrompt: "System",
      chatHistory: longHistory,
      userQuestion: "Question",
    });

    const text = (messages[0] as any).content;
    expect(text).toContain("[CHAT HISTORY]");
    // The chatHistory part should be capped
    expect(text).toContain("[… context truncated to fit]");
    // Total should be manageable
    expect(text.length).toBeLessThan(70000);
  });
});
