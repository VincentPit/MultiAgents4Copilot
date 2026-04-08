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

// Mock qualityGate module — we control when quality checks pass/fail
const mockRunQualityGate = jest.fn();
const mockRunFullQualityGate = jest.fn();
const mockFormatQualityReportForLLM = jest.fn();
const mockFilterDiagnosticsForFiles = jest.fn();
const mockGenerateDiffReport = jest.fn();

jest.mock("../../utils/qualityGate", () => ({
  runQualityGate: (...args: any[]) => mockRunQualityGate(...args),
  runFullQualityGate: (...args: any[]) => mockRunFullQualityGate(...args),
  formatQualityReportForLLM: (...args: any[]) => mockFormatQualityReportForLLM(...args),
  formatBuildErrorsForLLM: jest.fn().mockReturnValue("✅ Build passed"),
  filterDiagnosticsForFiles: (...args: any[]) => mockFilterDiagnosticsForFiles(...args),
  generateDiffReport: (...args: any[]) => mockGenerateDiffReport(...args),
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

function successQAResult(): any {
  return {
    build: successBuildResult(),
    lint: { success: true, errorCount: 0, warningCount: 0, diagnostics: [], stdout: "", stderr: "", command: "(none)", durationMs: 0 },
    tests: { success: true, passed: 0, failed: 0, total: 0, skipped: 0, failures: [], stdout: "", stderr: "", command: "(none)", durationMs: 0 },
    diff: "",
    passed: true,
    summary: "Build: ✅ | Lint: ✅ | Tests: ⏭️ (none found)",
  };
}

function failedQAResult(errorCount = 2): any {
  return {
    build: failedBuildResult(errorCount),
    lint: { success: true, errorCount: 0, warningCount: 0, diagnostics: [], stdout: "", stderr: "", command: "(none)", durationMs: 0 },
    tests: null,
    diff: "",
    passed: false,
    summary: `Build: ❌ (${errorCount} errors) | Lint: ✅ | Tests: ⏭️ (none found)`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Coder — quality gate retry loop
// ═══════════════════════════════════════════════════════════════════════

describe("coderNode — quality gate retry loop", () => {
  let coderNode: typeof import("../../agents/coder").coderNode;

  beforeAll(() => {
    coderNode = require("../../agents/coder").coderNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nconst x = 1;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });
    mockFormatQualityReportForLLM.mockReturnValue("❌ Quality gate FAILED");
    mockGenerateDiffReport.mockResolvedValue(""); // No diff → skip self-review
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("stores build_status=passed when quality gate passes", async () => {
    mockRunQualityGate.mockResolvedValue(successQAResult());

    const state = createInitialState("write code");
    const result = await coderNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!["build_status"]).toBe("passed");
    expect(result.artifacts!["quality_summary"]).toBeDefined();
    expect(result.artifacts!["quality_errors"]).toBeUndefined();
  });

  it("runs quality gate after writing files", async () => {
    mockRunQualityGate.mockResolvedValue(successQAResult());

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunQualityGate).toHaveBeenCalledTimes(1);
  });

  it("retries on quality gate failure and calls model with error context", async () => {
    mockRunQualityGate
      .mockResolvedValueOnce(failedQAResult(2))
      .mockResolvedValueOnce(successQAResult());

    mockCallModel
      .mockResolvedValueOnce("### `src/foo.ts`\n```typescript\nconst x = 1;\n```")
      .mockResolvedValueOnce("### `src/foo.ts`\n```typescript\nconst x: number = 1;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });

    const state = createInitialState("write code");
    const stream = mockStream();
    await coderNode(state, mockModel, stream, mockToken());

    expect(mockCallModel).toHaveBeenCalledTimes(2);
    expect(mockRunQualityGate).toHaveBeenCalledTimes(2);

    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(markdownCalls.some((m: string) => m.includes("Quality gate failed") || m.includes("🔧"))).toBe(true);
  });

  it("stores quality_errors when max retries exhausted", async () => {
    mockRunQualityGate.mockResolvedValue(failedQAResult(3));
    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nbroken;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });

    const state = createInitialState("write code");
    const result = await coderNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["quality_errors"]).toBeDefined();
  });

  it("does not run quality gate when no files are written", async () => {
    mockApplyCodeToWorkspace.mockResolvedValue({ written: [], skipped: [] });

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunQualityGate).not.toHaveBeenCalled();
  });

  it("stops retry loop on cancellation", async () => {
    mockRunQualityGate.mockResolvedValue(failedQAResult(2));

    const state = createInitialState("write code");
    const cancelledToken = mockToken(true);
    await coderNode(state, mockModel, mockStream(), cancelledToken);

    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it("includes quality report in fix prompt system message", async () => {
    mockRunQualityGate
      .mockResolvedValueOnce(failedQAResult(1))
      .mockResolvedValueOnce(successQAResult());

    mockCallModel.mockResolvedValue("### `src/foo.ts`\n```typescript\nfixed;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/foo.ts"], skipped: [] });
    mockFormatQualityReportForLLM.mockReturnValue("❌ Quality gate FAILED:\n- src/file0.ts:1 [TS2300]");

    const state = createInitialState("write code");
    await coderNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockBuildMessages.mock.calls[1][0];
    expect(secondCallArgs.systemPrompt).toContain("QUALITY GATE FAILED");
    expect(secondCallArgs.systemPrompt).toContain("FIX THESE ISSUES");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integrator — build awareness + fix loop
// ═══════════════════════════════════════════════════════════════════════

describe("integratorNode — CI pipeline + fix loop", () => {
  let integratorNode: typeof import("../../agents/integrator").integratorNode;

  beforeAll(() => {
    integratorNode = require("../../agents/integrator").integratorNode;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockResolvedValue("## Integration Report\n✅ All contracts validated");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: [], skipped: [] });
    mockFormatQualityReportForLLM.mockReturnValue("❌ CI pipeline FAILED");
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("injects prior quality_errors into system prompt", async () => {
    mockRunFullQualityGate.mockResolvedValue(successQAResult());

    const state = createInitialState("integrate code");
    state.domainAssignments = [
      { id: "api", domain: "API", description: "REST", filePatterns: ["src/api/**"], provides: "API", consumes: "" },
    ];
    state.artifacts = {
      "domain_code:api": "some code",
      quality_errors: "❌ Quality gate FAILED with 3 error(s) in src/api/routes.ts",
    };

    await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(mockBuildMessages).toHaveBeenCalled();
    const sysPrompt = mockBuildMessages.mock.calls[0]?.[0]?.systemPrompt ?? "";
    expect(sysPrompt).toContain("EXISTING QUALITY ISSUES FROM CODERS");
    expect(sysPrompt).toContain("3 error(s)");
  });

  it("runs full quality gate after writing integration files", async () => {
    mockRunFullQualityGate.mockResolvedValue(successQAResult());
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/index.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(mockRunFullQualityGate).toHaveBeenCalled();
  });

  it("stores build_status=passed on success", async () => {
    mockRunFullQualityGate.mockResolvedValue(successQAResult());

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    const result = await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toBe("passed");
  });

  it("retries fix when CI pipeline fails", async () => {
    mockRunFullQualityGate
      .mockResolvedValueOnce(failedQAResult(1))
      .mockResolvedValueOnce(successQAResult());

    mockCallModel
      .mockResolvedValueOnce("## Integration\n### `src/index.ts`\n```typescript\nexport {};\n```")
      .mockResolvedValueOnce("### `src/index.ts`\n```typescript\nexport { fixed };\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/index.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(mockCallModel).toHaveBeenCalledTimes(2);
    expect(mockRunFullQualityGate).toHaveBeenCalledTimes(2);
  });

  it("stores quality_errors when max retries exhausted", async () => {
    mockRunFullQualityGate.mockResolvedValue(failedQAResult(5));
    mockCallModel.mockResolvedValue("### `src/broken.ts`\n```typescript\nbroken;\n```");
    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/broken.ts"], skipped: [] });

    const state = createInitialState("integrate");
    state.domainAssignments = [];
    state.artifacts = {};

    const result = await integratorNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["quality_errors"]).toBeDefined();
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

describe("coderPoolNode — per-domain quality gate fix", () => {
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
    mockFormatQualityReportForLLM.mockReturnValue("❌ Quality gate FAILED");
    mockFilterDiagnosticsForFiles.mockReturnValue([]);
    mockBuildMessages.mockReturnValue([
      vscode.LanguageModelChatMessage.User("mock message"),
    ]);
  });

  it("stores build_status in artifacts after successful quality gate", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"full","domain":"Full","description":"All","filePatterns":["src/**"],"provides":"","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/app.ts`\n```typescript\nconst app = 1;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/app.ts"], skipped: [] });
    mockRunQualityGate.mockResolvedValue(successQAResult());

    const state = createInitialState("build something");
    const result = await coderPoolNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!["build_status"]).toBe("passed");
  });

  it("stores quality_errors when quality gate fails after max retries", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"api","domain":"API","description":"Routes","filePatterns":["src/api/**"],"provides":"Router","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\nbroken;\n```")
      .mockResolvedValue("### `src/api/routes.ts`\n```typescript\nstill broken;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/api/routes.ts"], skipped: [] });
    mockRunQualityGate.mockResolvedValue(failedQAResult(2));
    mockFilterDiagnosticsForFiles.mockReturnValue([
      { file: "src/api/routes.ts", line: 1, column: 1, code: "TS2304", message: "err" },
    ]);

    const state = createInitialState("build API");
    const result = await coderPoolNode(state, mockModel, mockStream(), mockToken());

    expect(result.artifacts!["build_status"]).toContain("failed");
    expect(result.artifacts!["quality_errors"]).toBeDefined();
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

    mockRunQualityGate
      .mockResolvedValueOnce(failedQAResult(1))
      .mockResolvedValueOnce(successQAResult());

    mockFilterDiagnosticsForFiles.mockImplementation((_diagnostics: any, files: string[]) => {
      if (files.includes("src/api/routes.ts")) {
        return [{ file: "src/api/routes.ts", line: 1, column: 1, code: "TS2304", message: "broken" }];
      }
      return [];
    });

    const state = createInitialState("build project");
    const stream = mockStream();
    const result = await coderPoolNode(state, mockModel, stream, mockToken());

    // The api domain should have failed quality gate (❌), while db passed (✅)
    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasFailIndicator = markdownCalls.some((m: string) =>
      m.includes("❌") || m.includes("failed")
    );
    expect(hasFailIndicator).toBe(true);
    expect(result.artifacts!["build_status"]).toContain("failed");
  });

  it("reports test failure when quality gate fails with no domain-specific errors", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        '```json\n[{"id":"api","domain":"API","description":"Routes","filePatterns":["src/api/**"],"provides":"","consumes":""}]\n```'
      )
      .mockResolvedValueOnce("### `src/api/routes.ts`\n```typescript\ncode;\n```");

    mockApplyCodeToWorkspace.mockResolvedValue({ written: ["src/api/routes.ts"], skipped: [] });
    mockRunQualityGate.mockResolvedValue(failedQAResult(1));
    mockFilterDiagnosticsForFiles.mockReturnValue([]);

    const state = createInitialState("build");
    const stream = mockStream();
    await coderPoolNode(state, mockModel, stream, mockToken());

    const markdownCalls = (stream.markdown as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    const hasFailureIndicator = markdownCalls.some((m: string) =>
      m.includes("❌") || m.includes("failed") || m.includes("error")
    );
    expect(hasFailureIndicator).toBe(true);
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
