import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, selectModel, MODELS, sysMsg, userMsg, assistantMsg } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are a senior test engineer specialising in automated testing.
Your job is to generate thorough, production-quality tests for the code provided
by other agents.

Guidelines:
1. Choose the appropriate testing framework for the language / stack
   (Jest, Vitest, Mocha, pytest, JUnit, etc.).
2. Cover:
   - Happy-path / success cases
   - Edge cases & boundary values
   - Error / exception handling
   - Mocks and stubs where appropriate (external APIs, file I/O, databases)
3. Name tests descriptively using "should …" or "it …" phrasing.
4. Keep tests isolated — each test should set up & tear down its own state.
5. If a UI design spec is provided, include snapshot or visual regression test
   stubs where applicable.
6. Output well-formatted Markdown with fenced code blocks.
7. After the code, give a short summary of coverage areas.`;

export async function testGen(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<Partial<AgentState>> {
  stream.markdown(`\n\n---\n#### 🧪 Test Generator — Writing tests\n\n`);

  // Prefer Claude Opus 4.6 for test generation
  const testResult = await selectModel(MODELS.claudeOpus);
  const activeModel = testResult?.model ?? model;

  if (testResult) {
    logger.info("test_gen", `Using preferred model: ${testResult.spec.label}`);
  } else {
    logger.fallback("test_gen", "claude-opus-4.6", model.name);
  }

  // Gather context from inter-agent messages
  let contextBlock = "";
  const msgs = getMessagesFor(state, "test_gen");
  if (msgs.length > 0) {
    contextBlock = "\n\n## Context from other agents\n" +
      msgs.map(m => `[From ${m.from}]: ${m.content}`).join("\n");
  }

  // Read code artefact to test
  const codeToTest = state.artifacts["last_code"] ?? "";
  if (codeToTest) {
    contextBlock += `\n\n## Code under test\n\`\`\`\n${codeToTest}\n\`\`\``;
  }

  // Read UI design if available
  const uiDesign = state.artifacts["ui_design"] ?? "";
  if (uiDesign) {
    contextBlock += `\n\n## UI Design spec (for component / snapshot tests)\n${uiDesign}`;
  }

  // Read plan for broader context
  const plan = state.artifacts["plan"] ?? "";
  if (plan) {
    contextBlock += `\n\n## Project plan\n${plan}`;
  }

  const fullSystemPrompt = SYSTEM_PROMPT + contextBlock;

  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(fullSystemPrompt)];
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  const response = await callModel(activeModel, messages, stream, token, "test_gen");

  const newMessage: AgentMessage = {
    role: "assistant",
    content: response,
    name: "test_gen",
  };

  // Post test suite to message bus so reviewer can verify test quality
  postAgentMessage(state, "test_gen", "reviewer", "info",
    `Test suite generated. Please review the tests along with the code:\n${response}`);
  postAgentMessage(state, "test_gen", "coder", "info",
    `Tests written for your code. You may need to adjust implementation if tests reveal gaps:\n${response}`);
  logger.agentMessage("test_gen", "*", "Test suite posted to message bus");

  return {
    messages: [newMessage],
    artifacts: { tests: response },
    nextAgent: "supervisor",
  };
}
