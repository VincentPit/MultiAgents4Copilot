/**
 * Tests for src/agents/integrator.ts — integration engineer agent.
 *
 * The integrator merges parallel domain coder outputs, validates
 * cross-domain contracts, and writes glue code.
 */

import * as vscode from "vscode";
import { integratorNode } from "../../agents/integrator";
import { createInitialState, type AgentState, type DomainAssignment } from "../../graph/state";

const mockModel = {
  name: "mock-model",
  sendRequest: jest.fn(),
  maxInputTokens: 200_000,
  countTokens: jest.fn().mockResolvedValue(100),
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

function createStateWithDomains(): AgentState {
  const state = createInitialState("Build a todo API");

  state.domainAssignments = [
    {
      id: "backend-api",
      domain: "Backend API",
      description: "REST routes",
      filePatterns: ["src/api/**"],
      provides: "GET /todos, POST /todos",
      consumes: "TodoService from data-layer",
    },
    {
      id: "data-layer",
      domain: "Data Layer",
      description: "Database models",
      filePatterns: ["src/models/**"],
      provides: "TodoService, TodoModel",
      consumes: "nothing",
    },
  ];

  state.artifacts = {
    "domain_code:backend-api":
      "### `src/api/todos.ts`\n```typescript\nimport { TodoService } from '../models/todo';\n```",
    "domain_code:data-layer":
      "### `src/models/todo.ts`\n```typescript\nexport class TodoService {}\n```",
  };

  return state;
}

describe("integratorNode", () => {
  beforeEach(() => {
    // Reset mock to return a valid async iterable
    mockModel.sendRequest.mockReset();
    mockModel.sendRequest.mockResolvedValue({
      text: (async function* () {
        yield "## Integration Report\n\n";
        yield "✅ All contracts validated\n";
        yield "🔗 No glue files needed\n";
      })(),
    });
  });

  it("produces an integration report message", async () => {
    const state = createStateWithDomains();
    const stream = mockStream();

    const result = await integratorNode(state, mockModel, stream, mockToken());

    // Should produce a message from the integrator
    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].name).toBe("integrator");
    expect(result.messages![0].role).toBe("assistant");
    expect(result.messages![0].content).toContain("Integration Report");
  });

  it("stores integration_report in artifacts", async () => {
    const state = createStateWithDomains();
    const stream = mockStream();

    const result = await integratorNode(state, mockModel, stream, mockToken());

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!["integration_report"]).toBeDefined();
    expect(result.artifacts!["integration_report"]).toContain("Integration Report");
  });

  it("renders header markdown to stream", async () => {
    const state = createStateWithDomains();
    const stream = mockStream();

    await integratorNode(state, mockModel, stream, mockToken());

    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map(
      (c: any[]) => c[0]
    );
    expect(markdownCalls.some((m: string) => m.includes("Integration Engineer"))).toBe(true);
  });

  it("sends domain summaries to the model", async () => {
    const state = createStateWithDomains();
    const stream = mockStream();

    await integratorNode(state, mockModel, stream, mockToken());

    expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockModel.sendRequest.mock.calls[0];
    const messages = callArgs[0] as vscode.LanguageModelChatMessage[];

    // The message should contain domain information (mock stores content as plain string)
    const content = String((messages[0] as any).content ?? "");
    expect(content).toContain("Backend API");
    expect(content).toContain("Data Layer");
    expect(content).toContain("TodoService");
  });

  it("handles state with no domain assignments gracefully", async () => {
    const state = createInitialState("simple task");
    state.domainAssignments = [];
    const stream = mockStream();

    const result = await integratorNode(state, mockModel, stream, mockToken());

    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].name).toBe("integrator");
  });
});
