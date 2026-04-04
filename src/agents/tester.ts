/**
 * Test Generator agent — writes automated tests for produced code.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, selectModel, MODELS, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are a senior test engineer for automated testing.
Generate thorough, production-quality tests for the provided code.

Guidelines:
1. Choose appropriate testing framework (Jest, Vitest, pytest, JUnit, etc.).
2. Cover happy-path, edge cases, error handling, mocks where appropriate.
3. Name tests descriptively ("should ..." or "it ...").
4. Keep tests isolated with own setup/teardown.
5. Output well-formatted Markdown with fenced code blocks.
6. After code, give short coverage summary.`;

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
      msgs.slice(0, 3).map(m => `[From ${m.from}]: ${capContext(m.content, 300)}`).join("\n");
  }

  const codeToTest = state.artifacts["last_code"] ?? "";
  if (codeToTest) {
    contextBlock += `\n\n## Code under test\n\`\`\`\n${capContext(codeToTest, 1500)}\n\`\`\``;
  }

  const uiDesign = state.artifacts["ui_design"] ?? "";
  if (uiDesign) {
    contextBlock += `\n\n## UI Design\n${capContext(uiDesign, 600)}`;
  }

  const plan = state.artifacts["plan"] ?? "";
  if (plan) {
    contextBlock += `\n\n## Plan\n${capContext(plan, 400)}`;
  }

  const sysPrompt = SYSTEM_PROMPT + contextBlock;
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    userQuestion: lastUserMsg || "Generate tests for the code above",
    maxSystemChars: 4000,
    maxWorkspaceChars: 800,
  });

  const response = await callModel(activeModel, messages, stream, token, "test_gen");

  const cappedResponse = response.length > 1500
    ? response.slice(0, 1500) + "\n[... tests truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    content: cappedResponse,
    name: "test_gen",
  };

  postAgentMessage(state, "test_gen", "reviewer", "info",
    `Test suite generated. Review tests with code:\n${capContext(response, 800)}`);
  postAgentMessage(state, "test_gen", "coder", "info",
    `Tests written. Adjust if tests reveal gaps:\n${capContext(response, 800)}`);
  logger.agentMessage("test_gen", "*", "Test suite posted to message bus");

  return {
    messages: [newMessage],
    artifacts: { tests: cappedResponse },
    nextAgent: "supervisor",
  };
}
