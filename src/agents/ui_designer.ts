/**
 * UI Designer agent — designs user interfaces and components.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";

/** Maximum characters stored for a design response in state. */
export const MAX_DESIGN_CHARS = 6_000;

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

  // Single-model setup: use the GPT-4.1 model handle passed in.
  const activeModel = model;
  logger.info("ui_designer", `Using model: ${model.name}`);

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

  const cappedResponse = response.length > MAX_DESIGN_CHARS
    ? response.slice(0, MAX_DESIGN_CHARS) + "\n[... design truncated in state]"
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

  // Extract code blocks — handles language tags (```tsx, ```css, etc.) and blocks at end of string
  const codeBlocks: string[] = [];
  const codeBlockRegex = /```[\w.+-]*\s*\n([\s\S]*?)```/g;
  let codeMatch;
  while ((codeMatch = codeBlockRegex.exec(response)) !== null) {
    if (codeMatch[1]?.trim()) { codeBlocks.push(codeMatch[1].trim()); }
  }
  const extractedCode = codeBlocks.length > 0 ? codeBlocks.join("\n\n") : "";

  return {
    messages: [newMessage],
    artifacts: {
      ui_design: cappedResponse,
      ...(extractedCode ? { last_code: extractedCode } : {}),
    },
    nextAgent: "supervisor",
  };
}
