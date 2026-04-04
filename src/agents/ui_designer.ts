import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, selectModel, MODELS, sysMsg, userMsg, assistantMsg, truncateMessages, safeBudget } from "./base";
import { logger } from "../utils/logger";

const SYSTEM_PROMPT = `You are a senior UI/UX designer and front-end architect.
Your job is to design user interfaces: components, layouts, colour palettes,
responsive behaviour, accessibility, and visual hierarchy.

When designing:
1. Start with a brief design rationale (2-3 sentences).
2. Provide the markup / component code (HTML, JSX, React, Vue, Svelte, etc.).
3. Include styling (CSS / Tailwind / styled-components) that is production-ready.
4. Note any accessibility considerations (ARIA, focus management, contrast).
5. If an existing code artefact was supplied by the Coder agent, make sure your
   design integrates with it seamlessly.

Output well-formatted Markdown with fenced code blocks.`;

export async function uiDesigner(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<Partial<AgentState>> {
  stream.markdown(`\n\n---\n#### 🎨 UI Designer — Crafting the interface\n\n`);

  // Prefer Gemini 3 Pro for design work
  const designResult = await selectModel(MODELS.gemini3Pro);
  const activeModel = designResult?.model ?? model;

  if (designResult) {
    logger.info("ui_designer", `Using preferred model: ${designResult.spec.label}`);
  } else {
    logger.fallback("ui_designer", "gemini-3-pro", model.name);
  }

  // Build context from inter-agent messages
  let contextBlock = "";
  const msgs = getMessagesFor(state, "ui_designer");
  if (msgs.length > 0) {
    contextBlock = "\n\n## Context from other agents\n" +
      msgs.map(m => `[From ${m.from}]: ${m.content}`).join("\n");
  }

  // Also read any existing code artefact
  const existingCode = state.artifacts["last_code"] ?? "";
  if (existingCode) {
    contextBlock += `\n\n## Existing code to integrate with\n\`\`\`\n${existingCode}\n\`\`\``;
  }

  const plan = state.artifacts["plan"] ?? "";
  if (plan) {
    contextBlock += `\n\n## Project plan\n${plan}`;
  }

  let fullSystemPrompt = SYSTEM_PROMPT + contextBlock;
  if (state.workspaceContext) {
    fullSystemPrompt += `\n\n${state.workspaceContext}`;
  }

  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(fullSystemPrompt)];
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  const response = await callModel(activeModel, truncateMessages(messages, safeBudget(activeModel)), stream, token, "ui_designer");

  const newMessage: AgentMessage = {
    role: "assistant",
    content: response,
    name: "ui_designer",
  };

  // Post design spec to message bus for coder and tester
  postAgentMessage(state, "ui_designer", "coder", "info", response);
  postAgentMessage(state, "ui_designer", "test_gen", "info",
    `UI design was produced. Here are the components to consider for visual regression / snapshot tests:\n${response}`);
  logger.agentMessage("ui_designer", "*", "Design spec posted to message bus");

  return {
    messages: [newMessage],
    artifacts: { ui_design: response, last_code: response },
    nextAgent: "supervisor",
  };
}
