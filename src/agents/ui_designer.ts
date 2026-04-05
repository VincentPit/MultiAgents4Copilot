/**
 * UI Designer agent — designs user interfaces and components.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, selectModel, MODELS, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are a senior UI/UX designer and front-end architect.
Design user interfaces: components, layouts, colours, responsive behaviour, accessibility.

When designing:
1. Brief design rationale (2-3 sentences).
2. Markup/component code (HTML, JSX, React, Vue, Svelte, etc.).
3. Styling (CSS/Tailwind) that is production-ready.
4. Accessibility notes (ARIA, focus, contrast).
5. Integrate with any existing code artefact.

Output well-formatted Markdown with fenced code blocks.`;

export async function uiDesigner(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<Partial<AgentState>> {
  stream.markdown(`\n\n---\n#### \u{1F3A8} UI Designer \u{2014} Crafting the interface\n\n`);

  // Prefer Gemini 3 Pro for design work
  const designResult = await selectModel(MODELS.gemini3Pro);
  const activeModel = designResult?.model ?? model;

  if (designResult) {
    logger.info("ui_designer", `Using preferred model: ${designResult.spec.label}`);
  } else {
    logger.fallback("ui_designer", "gemini-3-pro", model.name);
  }

  // Build context block
  let contextBlock = "";
  const msgs = getMessagesFor(state, "ui_designer");
  if (msgs.length > 0) {
    contextBlock = "\n\n## Context from other agents\n" +
      msgs.slice(0, 3).map(m => `[From ${m.from}]: ${capContext(m.content, 1500)}`).join("\n");
  }

  const existingCode = state.artifacts["last_code"] ?? "";
  if (existingCode) {
    contextBlock += `\n\n## Existing code\n\`\`\`\n${capContext(existingCode, 6_000)}\n\`\`\``;
  }

  const plan = state.artifacts["plan"] ?? "";
  if (plan) {
    contextBlock += `\n\n## Plan\n${capContext(plan, 3_000)}`;
  }

  const sysPrompt = SYSTEM_PROMPT + contextBlock;
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: lastUserMsg || "Design the UI",
    maxSystemChars: 12_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  const response = await callModel(activeModel, messages, stream, token, "ui_designer");

  const cappedResponse = response.length > 6000
    ? response.slice(0, 6000) + "\n[... design truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    content: cappedResponse,
    name: "ui_designer",
  };

  postAgentMessage(state, "ui_designer", "coder", "info", capContext(response, 4_000));
  postAgentMessage(state, "ui_designer", "test_gen", "info",
    `UI design produced. Components for tests:\n${capContext(response, 4_000)}`);
  logger.agentMessage("ui_designer", "*", "Design spec posted to message bus");

  return {
    messages: [newMessage],
    artifacts: { ui_design: cappedResponse, last_code: cappedResponse },
    nextAgent: "supervisor",
  };
}
