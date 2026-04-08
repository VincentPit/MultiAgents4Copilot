/**
 * Tests for the reviewer agent node — verdict parsing, CI context, review cycles.
 */

import * as vscode from "vscode";
import { createInitialState } from "../../graph/state.js";

const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock message"),
]);
const mockCallModel = jest.fn().mockResolvedValue("");
const mockCapContext = jest.fn((s: string, n?: number) => s.slice(0, n ?? 20_000));

jest.mock("../../agents/base.js", () => {
  const actual = jest.requireActual("../../agents/base.js");
  return {
    ...actual,
    buildMessages: mockBuildMessages,
    callModel: mockCallModel,
    capContext: mockCapContext,
  };
});

import { reviewerNode, MAX_REVIEWS, MAX_REVIEW_CHARS } from "../../agents/reviewer.js";

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

describe("reviewer constants", () => {
  it("exports MAX_REVIEWS = 3", () => {
    expect(MAX_REVIEWS).toBe(3);
  });

  it("exports MAX_REVIEW_CHARS = 6000", () => {
    expect(MAX_REVIEW_CHARS).toBe(6_000);
  });
});

describe("reviewerNode — verdict parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("approves when response contains VERDICT: APPROVE", async () => {
    mockCallModel.mockResolvedValue(
      "Code looks good.\n\nVERDICT: APPROVE"
    );
    const state = createInitialState("Review my code");
    state.artifacts["last_code"] = "console.log('hello');";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewVerdict).toBe("approve");
    expect(result.status).toBe("completed");
    expect(result.reviewCount).toBe(1);
  });

  it("approves case-insensitively", async () => {
    mockCallModel.mockResolvedValue("Verdict: approve");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewVerdict).toBe("approve");
  });

  it("revises when response contains VERDICT: REVISE", async () => {
    mockCallModel.mockResolvedValue(
      "Some issues found.\n\nVERDICT: REVISE\nFix the error handling."
    );
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewVerdict).toBe("revise");
    expect(result.nextAgent).toBe("coder");
    expect(result.status).toBeUndefined();
  });

  it("treats ambiguous response (no verdict) as revise", async () => {
    mockCallModel.mockResolvedValue("I have some concerns about the code.");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewVerdict).toBe("revise");
  });

  it("does not match VERDICT: APPROVE mid-word", async () => {
    // "APPROVED" without the VERDICT: prefix on its own line should not match
    mockCallModel.mockResolvedValue("The code is APPROVED by me. Good job.\nNo VERDICT line here.");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewVerdict).toBe("revise");
  });
});

describe("reviewerNode — review cycles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("increments reviewCount on each call", async () => {
    mockCallModel.mockResolvedValue("VERDICT: REVISE\nFix things.");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    state.reviewCount = 1;
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.reviewCount).toBe(2);
  });

  it("auto-approves at MAX_REVIEWS even without APPROVE verdict", async () => {
    mockCallModel.mockResolvedValue("Still has issues.\nVERDICT: REVISE");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    state.reviewCount = MAX_REVIEWS - 1; // next call will be the max

    const stream = mockStream();
    const result = await reviewerNode(state, mockModel, stream, mockToken());

    expect(result.reviewVerdict).toBe("approve");
    expect(result.status).toBe("completed");
    // Should show the auto-approve message in stream
    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(markdownCalls.some((s: string) => s.includes("auto-approving"))).toBe(true);
  });
});

describe("reviewerNode — CI context injection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("includes quality_summary in system prompt when available", async () => {
    mockCallModel.mockResolvedValue("VERDICT: APPROVE");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    state.artifacts["quality_summary"] = "All checks passed";

    await reviewerNode(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("CI Pipeline Status");
    expect(opts.systemPrompt).toContain("All checks passed");
  });

  it("includes build_status and test_results", async () => {
    mockCallModel.mockResolvedValue("VERDICT: APPROVE");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    state.artifacts["build_status"] = "SUCCESS";
    state.artifacts["test_results"] = "42 passed, 0 failed";

    await reviewerNode(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("Build: SUCCESS");
    expect(opts.systemPrompt).toContain("Tests: 42 passed");
  });

  it("omits CI section when no artifacts are present", async () => {
    mockCallModel.mockResolvedValue("VERDICT: APPROVE");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";

    await reviewerNode(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).not.toContain("CI Pipeline Status");
  });
});

describe("reviewerNode — message capping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("caps long review responses in stored message", async () => {
    const longReview = "x".repeat(MAX_REVIEW_CHARS + 2000) + "\nVERDICT: APPROVE";
    mockCallModel.mockResolvedValue(longReview);
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    const msgContent = result.messages![0].content;
    expect(msgContent.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS + 100);
    expect(msgContent).toContain("[... review truncated in state]");
  });

  it("does not truncate short reviews", async () => {
    mockCallModel.mockResolvedValue("Looks great!\nVERDICT: APPROVE");
    const state = createInitialState("Review");
    state.artifacts["last_code"] = "code";
    const result = await reviewerNode(state, mockModel, mockStream(), mockToken());

    expect(result.messages![0].content).not.toContain("truncated");
  });
});
