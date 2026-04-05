/**
 * Test Generator agent — writes automated tests for produced code.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, selectModel, MODELS, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput, type CommandResult } from "../utils/terminalRunner";
import type { TerminalResult } from "../graph/state";

const SYSTEM_PROMPT = `You are a senior test engineer for automated testing.
Generate thorough, production-quality tests for the provided code.

Guidelines:
1. Choose appropriate testing framework (Jest, Vitest, pytest, JUnit, etc.).
2. Cover happy-path, edge cases, error handling, mocks where appropriate.
3. Name tests descriptively ("should ..." or "it ...").
4. Keep tests isolated with own setup/teardown.
5. Output well-formatted Markdown with fenced code blocks.
6. After code, give short coverage summary.

FILE OUTPUT — write test files using the same format as the Coder agent:

   ### \`src/__tests__/helper.test.ts\`
   \`\`\`typescript
   // full test file contents
   \`\`\`

TERMINAL COMMANDS — after the test files, include commands to install test
dependencies and run the tests in a fenced \`\`\`bash block:

   \`\`\`bash
   npm install --save-dev jest @types/jest ts-jest
   npx jest --verbose
   \`\`\`

Commands will be executed in the workspace root after the user approves them.`;

export async function testGen(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<Partial<AgentState>> {
  stream.markdown(`\n\n---\n#### \u{1F9EA} Test Generator \u{2014} Writing tests\n\n`);

  // Prefer Claude Opus for test generation
  const testResult = await selectModel(MODELS.claudeOpus);
  const activeModel = testResult?.model ?? model;

  if (testResult) {
    logger.info("test_gen", `Using preferred model: ${testResult.spec.label}`);
  } else {
    logger.fallback("test_gen", "claude-opus-4.6", model.name);
  }

  // Build context
  let contextBlock = "";
  const msgs = getMessagesFor(state, "test_gen");
  if (msgs.length > 0) {
    contextBlock = "\n\n## Context from other agents\n" +
      msgs.slice(0, 3).map(m => `[From ${m.from}]: ${capContext(m.content, 1500)}`).join("\n");
  }

  const codeToTest = state.artifacts["last_code"] ?? "";
  if (codeToTest) {
    contextBlock += `\n\n## Code under test\n\`\`\`\n${capContext(codeToTest, 8_000)}\n\`\`\``;
  }

  const uiDesign = state.artifacts["ui_design"] ?? "";
  if (uiDesign) {
    contextBlock += `\n\n## UI Design\n${capContext(uiDesign, 3_000)}`;
  }

  const plan = state.artifacts["plan"] ?? "";
  if (plan) {
    contextBlock += `\n\n## Plan\n${capContext(plan, 2_000)}`;
  }

  const sysPrompt = SYSTEM_PROMPT + contextBlock;
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    userQuestion: lastUserMsg || "Generate tests for the code above",
    maxSystemChars: 12_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(activeModel, messages, stream, token, "test_gen");

  // ── Write test files to the workspace ──────────────────────────────
  let writtenFiles: string[] = [];
  try {
    const writeResult = await applyCodeToWorkspace(response, stream);
    writtenFiles = writeResult.written;
    if (writtenFiles.length > 0) {
      logger.info("test_gen", `Wrote ${writtenFiles.length} test file(s): ${writtenFiles.join(", ")}`);
    }
  } catch (err: any) {
    logger.error("test_gen", `Failed to write test files: ${err.message}`);
    stream.markdown(`\n> ⚠️ Failed to write test files: ${err.message}\n`);
  }

  // ── Run test commands ─────────────────────────────────────────
  const terminalResults: TerminalResult[] = [];
  try {
    const cmdResult = await runCommandsFromOutput(response, stream);
    for (const executed of cmdResult.executed) {
      terminalResults.push({
        command: executed.command,
        success: executed.success,
        stdout: executed.stdout,
        stderr: executed.stderr,
        agent: "test_gen",
      });
    }
    if (cmdResult.executed.length > 0) {
      const passed = cmdResult.executed.filter(r => r.success).length;
      const failed = cmdResult.executed.filter(r => !r.success).length;
      logger.info("test_gen", `Ran ${cmdResult.executed.length} command(s): ${passed} passed, ${failed} failed`);
    }
  } catch (err: any) {
    logger.error("test_gen", `Terminal command execution failed: ${err.message}`);
    stream.markdown(`\n> ⚠️ Failed to run test commands: ${err.message}\n`);
  }

  const cappedResponse = response.length > 6000
    ? response.slice(0, 6000) + "\n[... tests truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    content: cappedResponse,
    name: "test_gen",
  };

  postAgentMessage(state, "test_gen", "reviewer", "info",
    `Test suite generated. Review tests with code:\n${capContext(response, 4_000)}`);
  postAgentMessage(state, "test_gen", "coder", "info",
    `Tests written. Adjust if tests reveal gaps:\n${capContext(response, 4_000)}`);
  logger.agentMessage("test_gen", "*", "Test suite posted to message bus");

  return {
    messages: [newMessage],
    artifacts: {
      tests: cappedResponse,
      ...(writtenFiles.length > 0 ? { written_test_files: writtenFiles.join(", ") } : {}),
      ...(terminalResults.length > 0 ? { test_output: terminalResults.map(r => `$ ${r.command} → ${r.success ? "PASS" : "FAIL"}`).join("\n") } : {}),
    },
    terminalResults,
    nextAgent: "supervisor",
  };
}
