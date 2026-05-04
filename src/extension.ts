/**
 * Extension entry point — registers the `@team` chat participant
 * and wires up the multi-agent graph.
 *
 * Usage in the Copilot panel:
 *   @team build a REST API for a todo app
 *   @team /plan migrate our auth to OAuth2
 *   @team /code fibonacci function in Rust
 *   @team /review <paste code>
 */

import * as vscode from "vscode";
import { buildGraph, AgentNode, GraphResult, AGENT_DISPLAY } from "./graph/builder";
import { createInitialState } from "./graph/state";
import { createBudget } from "./agents/base";
import { supervisorNode } from "./agents/supervisor";
import { plannerNode } from "./agents/planner";
import { coderNode } from "./agents/coder";
import { coderPoolNode } from "./agents/coderPool";
import { reviewerNode } from "./agents/reviewer";
import { integratorNode } from "./agents/integrator";
import { uiDesigner } from "./agents/ui_designer";
import { testGen } from "./agents/tester";
import { logger } from "./utils/logger";
import { getWorkspaceSnapshot, formatSnapshotForLLM } from "./utils/workspace";
import { runIntegrityCheck, type IntegrityReport } from "./utils/integrity";
import { registerExtensionRoot } from "./utils/selfProtection";
import { registerDiffProvider, clearDiffStore } from "./utils/diffViewer";
import { AgentOutputManager } from "./utils/agentOutputManager";
import { MultiCoderViewManager } from "./utils/multiCoderView";
import { clearFileReadCache } from "./utils/fileReader";

const PARTICIPANT_ID = "multi-agent-copilot.team";

/** Cached integrity report promise — checked once at activation, awaited in handler. */
let _integrityPromise: Promise<IntegrityReport> | null = null;

export function activate(context: vscode.ExtensionContext) {
  const agent = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  agent.iconPath = new vscode.ThemeIcon("hubot");

  // Provide contextual follow-up suggestions after each response
  agent.followupProvider = {
    provideFollowups(
      _result: vscode.ChatResult,
      _ctx: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      return [
        { prompt: "Review the code above", command: "review", label: "🔍 Review" },
        { prompt: "Refine the plan", command: "plan", label: "📋 Re-plan" },
        { prompt: "Implement the next step", command: "code", label: "💻 Code" },
        { prompt: "Generate tests", command: "test", label: "🧪 Test" },
      ];
    },
  };

  context.subscriptions.push(agent);
  logger.info("extension", "Multi-Agent Copilot activated (v0.7.0)");

  // Register the in-memory diff content provider so agents can show
  // before/after diffs in the editor instead of streaming code in chat.
  registerDiffProvider(context);

  // Register the extension's own root so the self-protection guard
  // can prevent agents from modifying the extension's own source files.
  registerExtensionRoot(context.extensionUri.fsPath);

  // Run module integrity check asynchronously at activation.
  // The promise is awaited in the chat handler to ensure the check
  // completes before any user request is processed.
  _integrityPromise = runIntegrityCheck().catch(err => {
    logger.error("integrity", `Integrity check threw: ${err}`);
    // Return a passing report on check failure so we don't block the user
    return { ok: true, failures: [], checkedCount: 0, passed: [] } as IntegrityReport;
  });

  _integrityPromise.then(report => {
    if (!report.ok) {
      const failList = report.failures.map(f => `${f.module}.${f.export}`).join(", ");
      vscode.window.showErrorMessage(
        `Multi-Agent Copilot: Module integrity check failed (${report.failures.length} issue(s): ${failList}). The extension may not work correctly.`
      );
    }
  });
}

// ── Agent node map ────────────────────────────────────────────────────

const AGENT_NODES: Record<string, AgentNode> = {
  supervisor: supervisorNode,
  planner: plannerNode,
  coder: coderNode,
  coder_pool: coderPoolNode,
  reviewer: reviewerNode,
  integrator: integratorNode,
  ui_designer: uiDesigner,
  test_gen: testGen,
};

// ── Chat handler ──────────────────────────────────────────────────────

const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> => {
  // 0. Gate: abort early if module integrity check failed
  //    Await the promise so we don't bypass the check during startup
  const integrityReport = _integrityPromise ? await _integrityPromise : null;
  if (integrityReport && !integrityReport.ok) {
    const failList = integrityReport.failures
      .map((f: { module: string; export: string; expected: string; actual: string }) =>
        `\`${f.module}.${f.export}\` (expected ${f.expected}, got ${f.actual})`)
      .join("\n- ");
    stream.markdown(
      `## ⛔ Module Integrity Failure\n\n` +
      `The extension detected broken or missing modules at startup:\n\n` +
      `- ${failList}\n\n` +
      `> This usually means source files were corrupted or truncated. ` +
      `Try restoring from git: \`git checkout HEAD -- src/\`\n`
    );
    return;
  }

  // 0b. Clear request-scoped caches so a new chat turn always sees fresh
  //     workspace state (the previous turn may have written files).
  clearFileReadCache();

  // 1. Use the model from the chat request (user's dropdown), fall back to explicit selection
  let model: vscode.LanguageModelChat | undefined = request.model;
  if (!model) {
    const [selected] = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4.1",
    });
    model = selected;
  }

  if (!model) {
    stream.markdown(
      "⚠️ **No Copilot model available.** Make sure GitHub Copilot Chat is installed and you're signed in."
    );
    return;
  }

  // 2. Gather workspace context — budget-aware based on model capacity
  const budget = createBudget(model);
  const snapshot = await getWorkspaceSnapshot();
  const workspaceCtx = formatSnapshotForLLM(snapshot, budget.workspaceChars);

  // 3. Resolve user-attached references (#file, #selection)
  const references = await resolveReferences(request.references ?? [], budget.referencesChars);

  // 4. Format chat history for multi-turn context continuity
  const chatHistory = formatChatHistory((chatContext as any).history ?? []);

  // 5. Slash command → direct single-agent mode
  if (request.command) {
    await handleDirectCommand(request, model, stream, token, workspaceCtx, references);
    return;
  }

  // 6. Full graph execution
  await runGraph(request.prompt, model, stream, token, workspaceCtx, references, chatHistory);
};

// ── Direct command handler ────────────────────────────────────────────

async function handleDirectCommand(
  request: vscode.ChatRequest,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  workspaceCtx: string,
  references: string = ""
): Promise<void> {
  const state = createInitialState(request.prompt, workspaceCtx);
  state.references = references;
  const command = request.command!;

  const commandToAgent: Record<string, string> = {
    plan: "planner",
    code: "coder",
    build: "coder_pool",
    review: "reviewer",
    design: "ui_designer",
    test: "test_gen",
  };

  const agentName = commandToAgent[command];
  const agentFn = agentName ? AGENT_NODES[agentName] : undefined;

  if (!agentFn || !agentName) {
    stream.markdown(`> ⚠️ Unknown command: \`/${command}\``);
    return;
  }

  const display = AGENT_DISPLAY[agentName] ?? { icon: "⚙️", label: agentName };

  // ── Header ──
  stream.markdown(
    `## ${display.icon} Direct Mode — ${display.label}\n\n` +
    `> Running \`/${command}\` without supervisor routing\n\n` +
    `---\n\n`
  );

  const start = Date.now();
  await agentFn(state, model, stream, token);
  const ms = Date.now() - start;

  // ── Footer ──
  stream.markdown(
    `\n\n---\n` +
    `> ${display.icon} **${display.label}** completed in **${formatDuration(ms)}**\n`
  );
}

// ── Full graph execution with rich UI ────────────────────────────────

async function runGraph(
  prompt: string,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  workspaceCtx: string,
  references: string = "",
  chatHistory: string = ""
): Promise<void> {
  const state = createInitialState(prompt, workspaceCtx);
  state.references = references;
  state.chatHistory = chatHistory;

  const graph = buildGraph({
    nodes: AGENT_NODES,
    entryPoint: "supervisor",
    maxSteps: 15,
  });

  // ── Opening banner ──
  stream.markdown(
    `## 🤖 Multi-Agent Team\n\n` +
    `| Agent | Role |\n` +
    `|-------|------|\n` +
    `| 🧠 Supervisor | Routes your request to the right specialist |\n` +
    `| 📋 Planner | Breaks complex tasks into steps |\n` +
    `| 💻 Coder | Writes & edits code (single domain) |\n` +
    `| 🏢 Engineering Team | Spawns parallel domain coders for large projects |\n` +
    `| 🔗 Integration Engineer | Merges parallel outputs into cohesive code |\n` +
    `| 🎨 UI Designer | Designs interfaces & components (Gemini 3 Pro) |\n` +
    `| 🧪 Test Generator | Creates comprehensive test suites |\n` +
    `| ✅ Reviewer | Reviews code for quality & correctness |\n\n` +
    `---\n\n` +
    `### 🔄 Execution\n\n`
  );

  // ── Run the graph ──
  const result: GraphResult = await graph.run(state, model, stream, token);

  // ── Summary panel ──
  renderSummary(stream, result);
}

// ── Summary renderer ─────────────────────────────────────────────────

function renderSummary(stream: vscode.ChatResponseStream, result: GraphResult): void {
  const { agentRuns, totalDurationMs, totalSteps } = result;

  // Build the agent flow pipeline — show parallel groups with ∥ notation
  const workerRuns = agentRuns.filter((r) => r.name !== "supervisor");

  // Group consecutive parallel runs into batches
  const flowSegments: string[] = [];
  let i = 0;
  while (i < workerRuns.length) {
    if (workerRuns[i].parallel) {
      // Collect all consecutive parallel runs
      const parallelGroup: string[] = [];
      while (i < workerRuns.length && workerRuns[i].parallel) {
        const d = AGENT_DISPLAY[workerRuns[i].name] ?? { icon: "⚙️", label: workerRuns[i].name };
        parallelGroup.push(`${d.icon} ${d.label}`);
        i++;
      }
      flowSegments.push(`⟨${parallelGroup.join(" ∥ ")}⟩`);
    } else {
      const d = AGENT_DISPLAY[workerRuns[i].name] ?? { icon: "⚙️", label: workerRuns[i].name };
      flowSegments.push(`${d.icon} ${d.label}`);
      i++;
    }
  }
  const flowLine = flowSegments.join("  →  ");

  // Build timing breakdown
  const timingRows = workerRuns.map((r) => {
    const d = AGENT_DISPLAY[r.name] ?? { icon: "⚙️", label: r.name };
    const tag = r.parallel ? " ∥" : "";
    return `| ${d.icon} ${d.label}${tag} | ${formatDuration(r.durationMs)} |`;
  });

  const parallelCount = workerRuns.filter(r => r.parallel).length;
  const statusEmoji = result.state.status === "completed" ? "✅" : "⚠️";
  const statusLabel = result.state.status === "completed" ? "Completed" : "Stopped";

  stream.markdown(
    `\n\n---\n\n` +
    `### 📊 Summary\n\n` +
    `**Status:** ${statusEmoji} ${statusLabel}\n\n` +
    `**Agent flow:**\n> ${flowLine || "_(no worker agents ran)_"}\n\n` +
    (parallelCount > 0
      ? `> _⟨ ⟩ = parallel group · ∥ = ran concurrently_\n\n`
      : "") +
    `**Performance:**\n\n` +
    `| Agent | Time |\n` +
    `|-------|------|\n` +
    timingRows.join("\n") + "\n" +
    `| **Total** | **${formatDuration(totalDurationMs)}** |\n\n` +
    `> 🔢 ${totalSteps} graph steps · ` +
    `${workerRuns.length} agent invocations` +
    (parallelCount > 0 ? ` (${parallelCount} parallel)` : "") +
    ` · ${result.state.reviewCount} review cycles\n`
  );
}
// ── Reference & history resolution ────────────────────────────────────

/**
 * Resolve user-attached references (#file, #selection, etc.) into text content.
 * This is how Copilot Chat gives the model visibility into attached files.
 */
async function resolveReferences(
  refs: readonly vscode.ChatPromptReference[],
  maxChars: number = 40_000
): Promise<string> {
  if (refs.length === 0) { return ""; }

  const parts: string[] = [];
  let totalChars = 0;

  for (const ref of refs) {
    if (totalChars >= maxChars) { break; }

    try {
      if (typeof ref.value === "string") {
        // String reference — include directly
        const text = `### Reference: ${ref.id}\n${ref.value}`;
        parts.push(text);
        totalChars += text.length;
      } else if (ref.value && typeof (ref.value as vscode.Uri).fsPath === "string") {
        // Uri reference — read the full file
        const uri = ref.value as vscode.Uri;
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = doc.getText();
        const relPath = vscode.workspace.asRelativePath(uri);
        const maxFileChars = Math.min(maxChars - totalChars, 30_000);
        const cappedContent = content.length > maxFileChars
          ? content.slice(0, maxFileChars) + "\n[… file truncated]"
          : content;
        const text = `### ${relPath}\n\`\`\`${doc.languageId}\n${cappedContent}\n\`\`\``;
        parts.push(text);
        totalChars += text.length;
      } else if (ref.value && (ref.value as vscode.Location).uri) {
        // Location reference — read the specific range
        const loc = ref.value as vscode.Location;
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const content = doc.getText(loc.range);
        const relPath = vscode.workspace.asRelativePath(loc.uri);
        const text = `### ${relPath} (selection)\n\`\`\`${doc.languageId}\n${content}\n\`\`\``;
        parts.push(text);
        totalChars += text.length;
      } else if (ref.modelDescription) {
        // Fallback: use the model description
        const text = `### Reference\n${ref.modelDescription}`;
        parts.push(text);
        totalChars += text.length;
      }
    } catch {
      logger.warn("references", `Could not resolve reference: ${ref.id}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Format chat history from prior turns for multi-turn context continuity.
 * This is how Copilot Chat maintains conversation context across turns.
 */
function formatChatHistory(
  history: ReadonlyArray<any>,
  maxChars: number = 8_000
): string {
  if (!history || history.length === 0) { return ""; }

  const parts: string[] = [];
  let totalChars = 0;

  // Work backwards from most recent to include the most relevant context
  for (let i = history.length - 1; i >= 0 && totalChars < maxChars; i--) {
    const turn = history[i];
    let text: string;

    if ("prompt" in turn) {
      // ChatRequestTurn — user's message
      text = `**User**: ${turn.prompt}`;
    } else if ("response" in turn) {
      // ChatResponseTurn — extract markdown from response parts
      const responseParts = turn.response as any[];
      const responseText = responseParts
        ?.map((p: any) => p?.value?.value ?? p?.value ?? "")
        .filter(Boolean)
        .join("") ?? "[response]";
      text = `**Assistant**: ${responseText.slice(0, 2_000)}`;
    } else {
      continue;
    }

    if (totalChars + text.length > maxChars) { break; }
    parts.unshift(text);
    totalChars += text.length;
  }

  return parts.length > 0 ? `## Prior Conversation\n\n${parts.join("\n\n")}` : "";
}
// ── Helpers ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function deactivate() {
  AgentOutputManager.getInstance().dispose();
  MultiCoderViewManager.getInstance().dispose();
  clearDiffStore();
  logger.dispose();
}

