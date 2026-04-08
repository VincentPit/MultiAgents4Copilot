/**
 * Tests for the UI designer agent node — model selection, code extraction, message bus.
 */

import * as vscode from "vscode";
import { createInitialState, postAgentMessage } from "../../graph/state.js";

const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock message"),
]);
const mockCallModel = jest.fn().mockResolvedValue("");
const mockSelectModel = jest.fn().mockResolvedValue(null);
const mockCapContext = jest.fn((s: string, n?: number) => s.slice(0, n ?? 20_000));

jest.mock("../../agents/base.js", () => {
  const actual = jest.requireActual("../../agents/base.js");
  return {
    ...actual,
    buildMessages: mockBuildMessages,
    callModel: mockCallModel,
    selectModel: mockSelectModel,
    capContext: mockCapContext,
  };
});

import { uiDesigner, MAX_DESIGN_CHARS } from "../../agents/ui_designer.js";

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

describe("ui_designer constants", () => {
  it("exports MAX_DESIGN_CHARS = 6000", () => {
    expect(MAX_DESIGN_CHARS).toBe(6_000);
  });
});

describe("uiDesigner — model selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("uses Gemini 3 Pro when available", async () => {
    const geminiModel = { name: "gemini-3-pro", sendRequest: jest.fn() };
    mockSelectModel.mockResolvedValue({ model: geminiModel, spec: { label: "Gemini 3 Pro" } });
    mockCallModel.mockResolvedValue("Design output");
    const state = createInitialState("Design a button");

    await uiDesigner(state, mockModel, mockStream(), mockToken());

    // callModel should be called with the gemini model, not the fallback
    expect(mockCallModel.mock.calls[0][0]).toBe(geminiModel);
  });

  it("falls back to provided model when Gemini is unavailable", async () => {
    mockSelectModel.mockResolvedValue(null);
    mockCallModel.mockResolvedValue("Design output");
    const state = createInitialState("Design a button");

    await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(mockCallModel.mock.calls[0][0]).toBe(mockModel);
  });
});

describe("uiDesigner — code block extraction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
    mockSelectModel.mockResolvedValue(null);
  });

  it("extracts code blocks into last_code artifact", async () => {
    mockCallModel.mockResolvedValue(
      "Here is the component:\n\n```tsx\nconst Button = () => <button>Click</button>;\n```\n\nSome prose."
    );
    const state = createInitialState("Design a button");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["last_code"]).toContain("const Button");
  });

  it("extracts multiple code blocks", async () => {
    mockCallModel.mockResolvedValue(
      "```jsx\nconst App = () => <div/>;\n```\n\nAnd styling:\n\n```css\n.app { color: red; }\n```"
    );
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["last_code"]).toContain("const App");
    expect(result.artifacts!["last_code"]).toContain(".app");
  });

  it("handles language tags with special characters (e.g., c++)", async () => {
    mockCallModel.mockResolvedValue(
      "```c++\nint main() { return 0; }\n```"
    );
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["last_code"]).toContain("int main");
  });

  it("does not set last_code when no code blocks found", async () => {
    mockCallModel.mockResolvedValue("Just some design notes without code.");
    const state = createInitialState("Design ideas");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["last_code"]).toBeUndefined();
  });

  it("skips empty code blocks", async () => {
    mockCallModel.mockResolvedValue("```tsx\n\n```\n\n```css\n.valid { }\n```");
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["last_code"]).toContain(".valid");
  });
});

describe("uiDesigner — context building", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
    mockSelectModel.mockResolvedValue(null);
    mockCallModel.mockResolvedValue("Design output");
  });

  it("includes existing code in system prompt", async () => {
    const state = createInitialState("Redesign the page");
    state.artifacts["last_code"] = "const OldComponent = () => null;";

    await uiDesigner(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("Existing code");
    expect(opts.systemPrompt).toContain("OldComponent");
  });

  it("includes plan artifact in system prompt", async () => {
    const state = createInitialState("Design UI");
    state.artifacts["plan"] = "1. Build header\n2. Build footer";

    await uiDesigner(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("Plan");
    expect(opts.systemPrompt).toContain("Build header");
  });

  it("includes inter-agent messages in context", async () => {
    const state = createInitialState("Design");
    postAgentMessage(state, "coder", "ui_designer", "info", "Use a card layout");

    await uiDesigner(state, mockModel, mockStream(), mockToken());

    const opts = mockBuildMessages.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("Context from other agents");
    expect(opts.systemPrompt).toContain("card layout");
  });
});

describe("uiDesigner — output", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
    mockSelectModel.mockResolvedValue(null);
  });

  it("sets message role and name correctly", async () => {
    mockCallModel.mockResolvedValue("Design output");
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.messages![0].role).toBe("assistant");
    expect(result.messages![0].name).toBe("ui_designer");
  });

  it("routes back to supervisor", async () => {
    mockCallModel.mockResolvedValue("Design output");
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.nextAgent).toBe("supervisor");
  });

  it("stores design in ui_design artifact", async () => {
    mockCallModel.mockResolvedValue("Beautiful design spec");
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["ui_design"]).toContain("Beautiful design spec");
  });

  it("caps long design responses", async () => {
    mockCallModel.mockResolvedValue("x".repeat(MAX_DESIGN_CHARS + 2000));
    const state = createInitialState("Design");
    const result = await uiDesigner(state, mockModel, mockStream(), mockToken());

    const content = result.messages![0].content;
    expect(content.length).toBeLessThanOrEqual(MAX_DESIGN_CHARS + 100);
    expect(content).toContain("[... design truncated in state]");
  });

  it("posts to message bus for coder and test_gen", async () => {
    mockCallModel.mockResolvedValue("Design with code");
    const state = createInitialState("Design");
    await uiDesigner(state, mockModel, mockStream(), mockToken());

    // Should have posted to both coder and test_gen
    const coderMsgs = state.agentComms.filter(m => m.from === "ui_designer" && m.to === "coder");
    const testMsgs = state.agentComms.filter(m => m.from === "ui_designer" && m.to === "test_gen");
    expect(coderMsgs.length).toBe(1);
    expect(testMsgs.length).toBe(1);
  });
});
