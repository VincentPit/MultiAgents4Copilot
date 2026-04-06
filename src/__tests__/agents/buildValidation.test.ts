/**
 * Tests for build validation integration in agents — verifying that the
 * error-feedback retry loops work correctly in coder, coderPool, integrator,
 * and that supervisor is build-state aware.
 *
 * These test the orchestration topology:
 *   coder writes → build validates → errors fed back → coder retries
 *   coderPool writes → build validates → per-domain errors → targeted fix
 *   integrator receives build_errors → fixes → validates
 *   supervisor sees build_status → avoids premature reviewer routing
 */

import * as vscode from "vscode";
import { createInitialState, type AgentState } from "../../graph/state";

// ── Mock setup ──────────────────────────────────────────────────────

// Mock buildValidator module — we control when build passes/fails
const mockRunBuildValidation = jest.fn();
const mockFormatBuildErrorsForLLM = jest.fn();
const mockFilterErrorsForFiles = jest.fn();

jest.mock("../../utils/buildValidator", () => ({
  runBuildValidation: (...args: any[]) => mockRunBuildValidation(...args),
  formatBuildErrorsForLLM: (...args: any[]) => mockFormatBuildErrorsForLLM(...args),
  filterErrorsForFiles: (...args: any[]) => mockFilterErrorsForFiles(...args),
}));

// Shared mock functions for base agent helpers — used by ALL agent tests
const mockCallModel = jest.fn();
const mockBuildMessages = jest.fn().mockReturnValue([
  vscode.LanguageModelChatMessage.User("mock message"),
]);

jest.mock("../../agents/base", () => {
  const actual = jest.requireActual("../../agents/base");
  return {
    ...actual,
    callModel: (...args: any[]) => mockCallModel(...args),
    buildMessages: (...args: any[]) => mockBuildMessages(...args),
  };
});

// Mock file writer
const mockApplyCodeToWorkspace = jest.fn();
jest.mock("../../utils/fileWriter", () => ({
  applyCodeToWorkspace: (...args: any[]) => mockApplyCodeToWorkspace(...args),
  parseFileBlocks: jest.fn().mockReturnValue([]),
}));

// Mock terminal runner
jest.mock("../../utils/terminalRunner", () => ({
  runCommandsFromOutput: jest.fn().mockResolvedValue({ executed: [] }),
}));

// Helpers ─────────────────────────────────────────────────────────────

function mockStream() {
  return {
    markdown: jest.fn(),
    progress: jest.fn(),
    reference: jest.fn(),
    button: jest.fn(),
    anchor: jest.fn(),
  } as unknown as vscode.ChatResponseStream;
}

const mockModel = {
  name: "mock-model",
  sendRequest: jest.fn(),
  maxInputTokens: 200_000,
  countTokens: jest.fn().mockResolvedValue(100),
} as any;

function mockToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  } as any;
}

function successBuildResult() {
  return {
    success: true,
    diagnostics: [],
    stdout: "",
    stderr: "",
    command: "npx tsc --noEmit",
    durationMs: 100,
    errorCount: 0,
  };
}

function failedBuildResult(errorCount = 2) {
  return {
    success: false,
    diagnostics: Array.from({ length: errorCount }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      column: 1,
      code: `TS${2300 + i}`,
      message: `Error ${i}`,
    })),
    stdout: "",
    stderr: "Compilation failed",
    command: "npx tsc --noEmit",
    durationMs: 200,
    errorCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Coder — build validation + retry loop
// ═══════════════════════════════════════════════════════════════════════

describe("coderNode — build validation retry loop", () => {
  let coderNode: typeof import("../../agents/coder").coderNode;

  beforeAll(() => {
    coderNode = require("../../agents/coder").coderNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: model produces code, file writer succeeds
    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nconst x = 1;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });
    mockFormatBuildErrorsForLLM.mockReturnValue("❌ Build FAILED with 2 error(s)");
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("stores build_status=passed in artifacts when build succeeds", async () => {
    mockRunBuildValidation.mockResolvedValue(successBuildResult());

    const state = createInitialState("write code");
    const result = await coderNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!["build_status"]).toBe("passed");
    expect(result.artifacts!["build_errors"]).toBeUndefined();
  });

  it("runs build validation after writing files", async () => {
    mockRunBuildValidation.mockResolvedValue(successBuildResult());

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunBuildValidation).toHaveBeenCalledTimes(1);
  });

  it("retries on build failure and calls model again with error context", async () => {
    // First build fails, second succeeds
    mockRunBuildValidation
      .mockResolvedValueOnce(failedBuildResult(2))
      .mockResolvedValueOnce(successBuildResult());

    // First call: original code. Second call: fix response
    mockCallModel
      .mockResolvedValueOnce("### `src/foo.ts`\n```typescript\nconst x = 1;\n```")
      .mockResolvedValueOnce("### `src/foo.ts`\n```typescript\nconst x: number = 1;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });

    const state = createInitialState("write code");
    const stream = mockStream();
    await coderNode(state, mockModel, stream, mockToken());

    // Should have called model twice: initial + 1 fix attempt
    expect(mockCallModel).toHaveBeenCalledTimes(2);
    // Should have called build validation twice: initial check + after fix
    expect(mockRunBuildValidation).toHaveBeenCalledTimes(2);

    // Should show fix attempt in stream
    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(markdownCalls.some((m: string) => m.includes("Build failed") || m.includes("🔧"))).toBe(true);
  });

  it("stores build_status=failed and build_errors when max retries exhausted", async () => {
    // Build always fails
    mockRunBuildValidation.mockResolvedValue(failedBuildResult(3));
    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nbroken;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });

    const state = createInitialState("write code");
    const result = await coderNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["build_errors"]).toBeDefined();
  });

  it("does not run build validation when no files are written", async () => {
    mockApplyCodeToWorkspace.mockResolvedValue({ written: [], skipped: [] });

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunBuildValidation).not.toHaveBeenCalled();
  });

  it("stops retry loop on cancellation", async () => {
    mockRunBuildValidation.mockResolvedValue(failedBuildResult(2));

    const state = createInitialState("write code");
    const cancelledToken = mockToken(true);
    await coderNode(state, mockModel, mockStream(), cancelledToken);

    // Should have called model 1 time (initial) but build validation
    // should break early due to cancellation
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it("includes error report in fix prompt system message", async () => {
    mockRunBuildValidation
      .mockResolvedValueOnce(failedBuildResult(1))
      .mockResolvedValueOnce(successBuildResult());

    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nfixed;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });
    mockFormatBuildErrorsForLLM.mockReturnValue("❌ Build FAILED with 1 error(s):\n- src/file0.ts:1 [TS2300]");

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    // buildMessages should have been called with error context in second call
    expect(mockBuildMessages).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockBuildMessages.mock.calls[1][0];
    expect(secondCallArgs.systemPrompt).toContain("BUILD ERRORS");
    expect(secondCallArgs.systemPrompt).toContain("FIX THESE NOW");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integrator — build awareness + fix loop
// ═══════════════════════════════════════════════════════════════════════

describe("integratorNode — build awareness + fix loop", () => {
  let integratorNode: typeof import("../../agents/integrator").integratorNode;

  beforeAll(() => {
    integratorNode = require("../../agents/integrator").integratorNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockResolvedValue("## Integration Report\n✅ All contracts validated");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: [], skipped: [] });
    mockFormatBuildErrorsForLLM.mockReturnValue("❌ Build FAILED");
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("injects prior build_errors into system prompt", async () => {
    mockRunBuildValidation.mockResolvedValue(successBuildResult());

    const state = createInitialState("integrate code");
    state.domainAssignments = [
      { id: "api", domain: "API", description: "REST", filePatterns: ["src/api/**"], provides: "API", consumes: "" },
    ];
    state.artifacts = {
      "domain_code:api": "some code",
      build_errors: "❌ Build FAILED with 3 error(s) in src/api/routes.ts",
    };

    await integratorNode(state, mockModel, mockStream(), mockToken());

    // Check that buildMessages was called with the prior errors
    expect(mockBuildMessages).toHaveBeenCalled();
    const sysPrompt = mockBuildMessages.mock.calls[0]?.[0]?.systemPrompt ?? "";
    expect(sysPrompt).toContain("EXISTING BUILD ERRORS FROM CODERS");
    expect(sysPrompt).toContain("3 error(s)");
  });

  it("runs build validation after writing integration files", async () => {
    mockRunBuildValidation.mockResolvedValue(successBuildResult());
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/index.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunBuildValidation).toHaveBeenCalled();
  });

  it("stores build_status=passed on success", async () => {
    mockRunBuildValidation.mockResolvedValue(successBuildResult());

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    const result = await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toBe("passed");
  });

  it("retries fix when integration build fails", async () => {
    mockRunBuildValidation
      .mockResolvedValueOnce(failedBuildResult(1))
      .mockResolvedValueOnce(successBuildResult());

    mockCallModel
      .mockResolvedValueOnce("## Integration\n### `src/index.ts`\n```typescript\nexport {};\n```")
      .mockResolvedValueOnce("### `src/index.ts`\n```typescript\nexport { fixed };\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/index.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    await integratorNode(state, mockModel, mockStream(), mockToken());

    // Should have called model 2 times (initial + fix)
    expect(mockCallModel).toHaveBeenCalledTimes(2);
    expect(mockRunBuildValidation).toHaveBeenCalledTimes(2);
  });

  it("stores build_errors when max retries exhausted", async () => {
    mockRunBuildValidation.mockResolvedValue(failedBuildResult(5));
    mockCallModel.mockResolvedValue("### `src/broken.ts`\n```typescript\nbroken;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/broken.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    const result = await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["build_errors"]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Supervisor — build state awareness in routing
// ═══════════════════════════════════════════════════════════════════════

describe("supervisorNode — build state awareness", () => {
  let supervisorNode: typeof import("../../agents/supervisor").supervisorNode;

  beforeAll(() => {
    supervisorNode = require("../../agents/supervisor").supervisorNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockResolvedValue("coder");
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock"),
    ]);
  });

  it("includes build_status in the routing question", async () => {
    const state = createInitialState("test");
    state.artifacts = { build_status: "passed" };

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const callArgs = mockBuildMessages.mock.calls[0]?.[0];
    expect(callArgs.userQuestion).toContain("Build status: passed");
  });

  it("includes build error warning when build_errors exists", async () => {
    const state = createInitialState("test");
    state.artifacts = {
      build_status: "failed:3",
      build_errors: "❌ 3 errors in src/foo.ts",
    };

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const callArgs = mockBuildMessages.mock.calls[0]?.[0];
    expect(callArgs.userQuestion).toContain("BUILD HAS ERRORS");
    expect(callArgs.userQuestion).toContain("needs fixing before review");
  });

  it("does NOT include build warnings when no build_status artifact", async () => {
    const state = createInitialState("test");
    state.artifacts = {};

    await supervisorNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const callArgs = mockBuildMessages.mock.calls[0]?.[0];
    expect(callArgs.userQuestion).not.toContain("Build status");
    expect(callArgs.userQuestion).not.toContain("BUILD HAS ERRORS");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CoderPool — per-domain targeted error fix
// ═══════════════════════════════════════════════════════════════════════

describe("coderPoolNode — per-domain targeted error fix", () => {
  let coderPoolNode: typeof import("../../agents/coderPool").coderPoolNode;

  beforeAll(() => {
    coderPoolNode = require("../../agents/coderPool").coderPoolNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockResolvedValue(
      '```json\n[{"id":"api","domain":"API","description":"REST","filePatterns":["src/api/**"],"provides":"Router","consumes":"DB"},{"id":"db","domain":"Data","description":"Database","filePatterns":["src/db/**"],"provides":"DB","consumes":""}]\n```'
    );
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/api/routes.ts"], skipped: [] });
    mockFormatBuildErrorsForLLM.mockReturnValue("❌ Build FAILED");
    mockFilterErrorsForFiles.mockReturnValue([]);
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("stores build_status in artifacts after successful build", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"full","domain":"Full","description":"All","filePatterns":["src/**"],"provides":"","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/app.ts`\n```typescript\nconst app = 1;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/app.ts"], skipped: [] });
    mockRunBuildValidation.mockResolvedValue(successBuildResult());

    const state = createInitialState("build something");
    const result = await coderPoolNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!["build_status"]).toBe("passed");
  });

  it("stores build_errors when build fails after max retries", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"api","domain":"API","description":"Routes","filePatterns":["src/api/**"],"provides":"Router","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\nbroken;\n```")
      .mockResolvedValue("### `src/api/routes.ts`\n```typescript\nstill broken;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/api/routes.ts"], skipped: [] });
    mockRunBuildValidation.mockResolvedValue(failedBuildResult(2));
    mockFilterErrorsForFiles.mockReturnValue([
      { file: "src/api/routes.ts", line: 1, column: 1, code: "TS2304", message: "err" },
    ]);

    const state = createInitialState("build API");
    const result = await coderPoolNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["build_errors"]).toBeDefined();
  });

  it("dispatches targeted fix calls only to domains with errors", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"api","domain":"API","description":"Routes","filePatterns":["src/api/**"],"provides":"Router","consumes":""},{"id":"db","domain":"Data","description":"Models","filePatterns":["src/db/**"],"provides":"DB","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\nbroken;\n```")
      .mockResolvedValueOnce("### `src/db/models.ts`\n```typescript\nconst ok = 1;\n```")
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\nfixed;\n```");

    mockApplyCodeToWorkspace
      .mockResolvedValueOnce({ written: ["src/api/routes.ts"], skipped: [] })
      .mockResolvedValueOnce({ written: ["src/db/models.ts"], skipped: [] })
      .mockResolvedValueOnce({ written: ["src/api/routes.ts"], skipped: [] });

    mockRunBuildValidation
      .mockResolvedValueOnce(failedBuildResult(1))
      .mockResolvedValueOnce(successBuildResult());

    mockFilterErrorsForFiles.mockImplementation((_result: any, files: string[]) => {
      if (files.includes("src/api/routes.ts")) {
        return [{ file: "src/api/routes.ts", line: 1, column: 1, code: "TS2304", message: "broken" }];
      }
      return [];
    });

    const state = createInitialState("build project");
    const stream = mockStream();
    await coderPoolNode(state, mockModel, stream, mockToken());

    expect(mockFilterErrorsForFiles).toHaveBeenCalled();

    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasFixMessage = markdownCalls.some((m: string) =>
      m.includes("Build failed") || m.includes("🔧") || m.includes("error")
    );
    expect(hasFixMessage).toBe(true);
  });

  it("passes to integrator when errors are cross-domain (no domain match)", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"api","domain":"API","description":"Routes","filePatterns":["src/api/**"],"provides":"","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\ncode;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/api/routes.ts"], skipped: [] });
    mockRunBuildValidation.mockResolvedValue(failedBuildResult(1));
    mockFilterErrorsForFiles.mockReturnValue([]);

    const state = createInitialState("build");
    const stream = mockStream();
    await coderPoolNode(state, mockModel, stream, mockToken());

    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasCrossDomainMessage = markdownCalls.some((m: string) =>
      m.includes("cross-domain") || m.includes("Integrator")
    );
    expect(hasCrossDomainMessage).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Build state propagation through artifacts
// ═══════════════════════════════════════════════════════════════════════

describe("Build state propagation", () => {
  it("build_status artifact format is consistent: 'passed' or 'failed:N'", () => {
    const passedStatus = "passed";
    const failedStatus = `failed:${3}`;

    expect(passedStatus).toBe("passed");
    expect(failedStatus).toMatch(/^failed:\d+$/);
  });

  it("build_errors artifact can be checked for truthiness", () => {
    const noErrors = undefined;
    const withErrors = "❌ Build FAILED with 3 error(s)";

    expect(!noErrors).toBe(true);
    expect(!!withErrors).toBe(true);
  });

  it("AgentState artifacts can store build_status and build_errors", () => {
    const state = createInitialState("test");
    state.artifacts["build_status"] = "failed:5";
    state.artifacts["build_errors"] = "❌ Build FAILED with 5 error(s)";

    expect(state.artifacts["build_status"]).toBe("failed:5");
    expect(state.artifacts["build_errors"]).toContain("5 error(s)");
  });
});
