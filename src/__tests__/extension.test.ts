/**
 * Tests for src/extension.ts — activation, participant registration, commands.
 */

import * as vscode from "vscode";
import { activate, deactivate } from "../extension.js";

const mockCreateChatParticipant = vscode.chat.createChatParticipant as jest.Mock;
const mockSelectChatModels = vscode.lm.selectChatModels as jest.Mock;

function mockExtensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: "/mock/extension",
    extensionUri: vscode.Uri.file("/mock/extension"),
    globalState: { get: jest.fn(), update: jest.fn(), keys: jest.fn(() => []), setKeysForSync: jest.fn() },
    workspaceState: { get: jest.fn(), update: jest.fn(), keys: jest.fn(() => []) },
    secrets: { get: jest.fn(), store: jest.fn(), delete: jest.fn(), onDidChange: jest.fn() },
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file("/mock/global"),
    logUri: vscode.Uri.file("/mock/log"),
    extensionMode: 3,
    environmentVariableCollection: {} as any,
    asAbsolutePath: jest.fn((p: string) => `/mock/extension/${p}`),
    storagePath: undefined,
    globalStoragePath: "/mock/global",
    logPath: "/mock/log",
    extension: {} as any,
    languageModelAccessInformation: {} as any,
  } as any;
}

describe("activate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers a chat participant with the correct ID", () => {
    const ctx = mockExtensionContext();
    activate(ctx);

    expect(mockCreateChatParticipant).toHaveBeenCalledWith(
      "multi-agent-copilot.team",
      expect.any(Function)
    );
  });

  it("adds the participant to context.subscriptions", () => {
    const ctx = mockExtensionContext();
    activate(ctx);
    expect(ctx.subscriptions.length).toBe(1);
  });

  it("sets an icon on the participant", () => {
    const ctx = mockExtensionContext();
    activate(ctx);

    const participant = mockCreateChatParticipant.mock.results[0].value;
    expect(participant.iconPath).toBeDefined();
  });

  it("sets a followupProvider on the participant", () => {
    const ctx = mockExtensionContext();
    activate(ctx);

    const participant = mockCreateChatParticipant.mock.results[0].value;
    expect(participant.followupProvider).toBeDefined();
  });
});

describe("deactivate", () => {
  it("should not throw", () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe("chat handler", () => {
  let handler: Function;
  let stream: any;
  let token: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const ctx = mockExtensionContext();
    activate(ctx);
    handler = mockCreateChatParticipant.mock.calls[0][1];
    stream = {
      markdown: jest.fn(),
      progress: jest.fn(),
      reference: jest.fn(),
      button: jest.fn(),
      anchor: jest.fn(),
    };
    token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(),
    };
  });

  it("shows error when no model is available", async () => {
    mockSelectChatModels.mockResolvedValueOnce([]);

    const request = { prompt: "hello", command: undefined, references: [] };
    await handler(request, { history: [] }, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("No Copilot model available")
    );
  });

  it("handles slash commands by routing to single agent", async () => {
    const mockModel = {
      name: "mock",
      maxInputTokens: 200_000,
      countTokens: jest.fn().mockResolvedValue(10),
      sendRequest: jest.fn().mockResolvedValue({
        text: (async function* () { yield "planned result"; })(),
      }),
    };
    mockSelectChatModels.mockResolvedValueOnce([mockModel]);

    const request = { command: "plan", prompt: "build a todo app", references: [] };
    await handler(request, { history: [] }, stream, token);

    // Should show direct mode header
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const allMd = mdCalls.join("");
    expect(allMd).toContain("Direct Mode");
  });

  it("runs full graph for prompts without a command", async () => {
    const mockModel = {
      name: "mock",
      maxInputTokens: 200_000,
      countTokens: jest.fn().mockResolvedValue(10),
      sendRequest: jest.fn().mockResolvedValue({
        text: (async function* () { yield "supervisor says finish"; })(),
      }),
    };
    mockSelectChatModels.mockResolvedValueOnce([mockModel]);

    const request = { prompt: "build a REST API", command: undefined, references: [] };
    await handler(request, { history: [] }, stream, token);

    // Should show the opening banner
    const mdCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const allMd = mdCalls.join("");
    expect(allMd).toContain("Multi-Agent Team");
  });

  it("uses request.model when available instead of selectChatModels", async () => {
    const requestModel = {
      name: "user-selected-model",
      maxInputTokens: 200_000,
      countTokens: jest.fn().mockResolvedValue(10),
      sendRequest: jest.fn().mockResolvedValue({
        text: (async function* () { yield "planned"; })(),
      }),
    };

    const request = {
      command: "plan",
      prompt: "hello",
      model: requestModel,
      references: [],
    };
    await handler(request, { history: [] }, stream, token);

    // Should NOT have called selectChatModels since request.model was present
    expect(mockSelectChatModels).not.toHaveBeenCalled();
    // Should have used the request model for the LLM call
    expect(requestModel.sendRequest).toHaveBeenCalled();
  });
});
