/**
 * Coder agent — writes, edits, and generates code.
 *
 * Unlike a chat-only agent, the coder **actually applies changes to the
 * workspace** by parsing fenced code blocks from the LLM response and
 * writing them to disk via `vscode.workspace.fs`.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage, getMessagesFor } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput, type CommandResult } from "../utils/terminalRunner";
import {
  runQualityGate,
  formatQualityReportForLLM,
  generateDiffReport,
  type QualityGateResult,
} from "../utils/qualityGate";
import { AgentOutputManager } from "../utils/agentOutputManager";
import { showBatchDiffs } from "../utils/diffViewer";
import type { TerminalResult } from "../graph/state";

const SYSTEM_PROMPT = `You are the Coder agent — an expert software engineer who writes real files.

CRITICAL FORMAT RULES — follow these exactly so your code is applied to the workspace:

1. For EVERY file you create or modify, put the relative file path on its own line
   as a Markdown heading immediately before the fenced code block:

   ### \`src/utils/helper.ts\`
   \`\`\`typescript
   // full file contents here
   \`\`\`

2. Always use the RELATIVE path from the project root (e.g. \`src/foo.ts\`, not \`/Users/.../src/foo.ts\`).
3. Include the COMPLETE file contents — not just a diff or snippet.
4. Use the correct language tag on the code fence (typescript, python, etc.).
5. You may include brief explanations between file blocks, but every code block
   that should be written MUST be preceded by a heading with the file path.
6. Produce clean, idiomatic, well-commented code.
7. If a plan exists, follow it step by step.

TERMINAL COMMANDS — if your changes require running commands (e.g. installing
dependencies, building, running scripts), include them in a fenced \`\`\`bash block:

   \`\`\`bash
   npm install express
   npm run build
   \`\`\`

Commands will be executed in the workspace root after the user approves them.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself (src/agents/, src/graph/, src/utils/, src/security/,
src/types/, src/extension.ts, package.json, tsconfig.json, jest.config.js,
or any file in the extension's own project). You are that extension —
modifying your own source code causes corruption. If asked to work on "this"
extension, explain that self-modification is blocked for safety.`;

const SELF_REVIEW_PROMPT = `You are reviewing your own code before submitting it for peer review.
This is your pre-submit self-review — like reviewing your PR diff before requesting reviewers.

SELF-REVIEW CHECKLIST (apply to the diff below):
□ No unused imports or variables
□ All error handling in place (try/catch for async, null checks)
□ No hardcoded secrets, passwords, or API keys
□ No console.log or debug statements left in production code
□ Type safety — no unnecessary \`any\` types
□ Consistent naming (camelCase for vars, PascalCase for types)
□ No code duplication — extract shared logic
□ JSDoc/comments for non-obvious logic
□ Edge cases handled (empty arrays, null inputs, etc.)
□ No off-by-one errors in loops or slices

If you find issues, output the corrected files using ### \`path\` format.
If the code looks good, respond with exactly: "LGTM — no issues found."`;

export async function coderNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const isRevision = !!state.artifacts["review_feedback"];
  const header = isRevision
    ? `---\n\n#### \u{1F4BB} Coder \u2014 Revision #${state.reviewCount + 1} (addressing feedback)\n\n`
    : `---\n\n#### \u{1F4BB} Coder \u2014 Writing code\n\n`;
  stream.markdown(header);

  // ── Set up output channel for detailed LLM output ──
  const outputMgr = AgentOutputManager.getInstance();
  const taskSummary = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "coding task";
  outputMgr.startRun("coder", taskSummary);
  outputMgr.reveal("coder");
  stream.markdown(`> 📺 _Detailed output streaming to **Coder** output channel_\n\n`);

  // Build system prompt with capped sections
  let sysPrompt = SYSTEM_PROMPT;

  if (state.plan.length > 0) {
    sysPrompt += `\n\n## Plan\n${capContext(state.plan.join("\n"), 3000)}`;
  }
  if (state.artifacts["review_feedback"]) {
    sysPrompt += `\n\n## Reviewer Feedback\n${capContext(state.artifacts["review_feedback"], 2000)}`;
  }

  const incomingMsgs = getMessagesFor(state, "coder").slice(-2);
  if (incomingMsgs.length > 0) {
    const comms = incomingMsgs.map(m => `[${m.from}]: ${m.content.slice(0, 1500)}`).join("\n");
    sysPrompt += `\n\n## Agent Messages\n${comms}`;
  }

  const lastUserContent = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: sysPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: lastUserContent,
    maxSystemChars: 12_000,
    maxWorkspaceChars: 8_000,
    maxReferencesChars: 10_000,
  });

  // Stream LLM output to the output channel, NOT the chat panel
  const outputSink = { append: (text: string) => outputMgr.append("coder", text) };
  const response = await callModel(model, messages, null, token, "coder", outputSink);

  postAgentMessage(state, "coder", "*", "info", response);
  logger.agentMessage("coder", "*", "Code posted to message bus");

  // ── Apply code blocks to the workspace ──────────────────────────────
  let writtenFiles: string[] = [];
  let allOldContents: Map<string, string> = new Map();
  try {
    const result = await applyCodeToWorkspace(response, stream);
    writtenFiles = result.written;
    allOldContents = result.oldContents;
    if (writtenFiles.length > 0) {
      logger.info("coder", `Applied ${writtenFiles.length} file(s) to workspace: ${writtenFiles.join(", ")}`);
      // Show inline diffs for modified files (like Copilot/Claude)
      await showBatchDiffs(writtenFiles, allOldContents);
    } else {
      logger.warn("coder", "No file blocks with paths found in LLM response — nothing written to disk");
    }
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    logger.error("coder", `File write failed: ${errMsg}`);
    stream.markdown(`\n> ⚠️ Failed to apply code changes: ${errMsg}\n`);
  }

  // ── Quality Gate: build → lint → test → self-review ─────────────────
  // Like a real engineer's pre-submit pipeline: code must pass ALL
  // automated checks before it goes to peer review.
  const MAX_FIX_RETRIES = 2;
  let qaReport: QualityGateResult | null = null;
  let lastResponse = response;

  if (writtenFiles.length > 0) {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      // Phase 1: Quality Gate (build + lint + tests)
      for (let attempt = 0; attempt <= MAX_FIX_RETRIES; attempt++) {
        if (token.isCancellationRequested) { break; }

        qaReport = await runQualityGate(wsRoot, writtenFiles);

        if (qaReport.passed) {
          stream.markdown(`\n> ✅ **Quality gate passed** — ${qaReport.summary}\n`);
          break;
        }

        if (attempt >= MAX_FIX_RETRIES) {
          stream.markdown(
            `\n> ⚠️ **Quality gate still failing** after ${MAX_FIX_RETRIES} fix attempt(s). ` +
            `${qaReport.summary}. Proceeding anyway.\n`
          );
          break;
        }

        const qualityReport = formatQualityReportForLLM(qaReport);
        stream.markdown(
          `\n> 🔧 **Quality gate failed** (${qaReport.summary}) — ` +
          `asking coder to fix (attempt ${attempt + 1}/${MAX_FIX_RETRIES})…\n`
        );

        const fixMessages = buildMessages({
          systemPrompt: SYSTEM_PROMPT + `\n\n## ❌ QUALITY GATE FAILED — FIX THESE ISSUES\n` +
            `Your code failed the automated quality gate (build, lint, and/or tests).\n` +
            `Fix ALL issues below. Rewrite ONLY the files that have errors.\n` +
            `Include the COMPLETE fixed file contents.\n\n` + qualityReport,
          workspaceContext: state.workspaceContext,
          references: state.references,
          chatHistory: "",
          userQuestion: `Fix ALL quality gate failures. Output only corrected files using ### \`path\` format.`,
          maxSystemChars: 16_000,
          maxWorkspaceChars: 6_000,
          maxReferencesChars: 6_000,
        });

        outputMgr.append("coder", `\n--- Fix attempt ${attempt + 1} ---\n`);
        const fixResponse = await callModel(model, fixMessages, null, token, `coder-fix-${attempt + 1}`, outputSink);
        lastResponse = fixResponse;

        try {
          const fixResult = await applyCodeToWorkspace(fixResponse, stream);
          if (fixResult.written.length > 0) {
            writtenFiles.push(...fixResult.written);
            // Merge old contents
            for (const [k, v] of fixResult.oldContents) { allOldContents.set(k, v); }
            await showBatchDiffs(fixResult.written, fixResult.oldContents);
            logger.info("coder", `Fix attempt ${attempt + 1}: wrote ${fixResult.written.length} file(s)`);
          }
        } catch (err: any) {
          logger.error("coder", `Fix attempt ${attempt + 1} file write failed: ${err?.message}`);
        }
      }

      // Phase 2: Self-Review (like reviewing your own PR before requesting reviewers)
      if (qaReport?.passed && !token.isCancellationRequested) {
        const diff = qaReport.diff || await generateDiffReport(wsRoot, writtenFiles);
        if (diff && diff.trim().length > 50) {
          stream.markdown(`\n> 🔍 **Self-reviewing** changes before peer review…\n`);
          outputMgr.append("coder", "\n--- Self-review ---\n");

          const reviewMessages = buildMessages({
            systemPrompt: SELF_REVIEW_PROMPT +
              `\n\n## Your Changes (diff)\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
            workspaceContext: state.workspaceContext,
            chatHistory: "",
            userQuestion: "Review the diff of your changes above. If you find issues, " +
              "output corrected files using ### `path` format. If code looks good, say LGTM.",
            maxSystemChars: 14_000,
            maxWorkspaceChars: 4_000,
          });

          const reviewResp = await callModel(model, reviewMessages, null, token, "coder-self-review", outputSink);

          if (!reviewResp.toUpperCase().includes("LGTM")) {
            try {
              const fixResult = await applyCodeToWorkspace(reviewResp, stream);
              if (fixResult.written.length > 0) {
                writtenFiles.push(...fixResult.written);
                for (const [k, v] of fixResult.oldContents) { allOldContents.set(k, v); }
                await showBatchDiffs(fixResult.written, fixResult.oldContents);
                lastResponse = reviewResp;
                logger.info("coder", `Self-review: fixed ${fixResult.written.length} file(s)`);
                // Quick re-validation after self-review fixes
                qaReport = await runQualityGate(wsRoot, writtenFiles);
                if (qaReport.passed) {
                  stream.markdown(`\n> ✅ **Post-review quality gate passed**\n`);
                }
              }
            } catch (err: any) {
              logger.error("coder", `Self-review fix write failed: ${err?.message}`);
            }
          } else {
            stream.markdown(`\n> ✅ **Self-review: LGTM** — code looks clean.\n`);
          }
        }
      }
    }
  }

  // ── Run terminal commands from the LLM response ──────────────────────
  const terminalResults: TerminalResult[] = [];
  try {
    const cmdResult = await runCommandsFromOutput(response, stream);
    for (const executed of cmdResult.executed) {
      terminalResults.push({
        command: executed.command,
        success: executed.success,
        stdout: executed.stdout,
        stderr: executed.stderr,
        agent: "coder",
      });
    }
    if (cmdResult.executed.length > 0) {
      logger.info("coder", `Ran ${cmdResult.executed.length} command(s)`);
    }
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    logger.error("coder", `Terminal command execution failed: ${errMsg}`);
    stream.markdown(`\n> ⚠️ Failed to run terminal commands: ${errMsg}\n`);
  }

  const cappedResponse = lastResponse.length > 6000
    ? lastResponse.slice(0, 6000) + "\n[... code truncated in state]"
    : lastResponse;

  // ── End the output channel run ──
  const totalDuration = Date.now() - (state.artifacts["_coderStartMs"] ? Number(state.artifacts["_coderStartMs"]) : Date.now());
  outputMgr.endRun("coder", totalDuration, writtenFiles.length > 0);

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "coder",
    content: cappedResponse,
  };

  return {
    messages: [newMessage],
    artifacts: {
      last_code: lastResponse,
      ...(writtenFiles.length > 0 ? { written_files: writtenFiles.join(", ") } : {}),
      ...(terminalResults.length > 0 ? { terminal_output: terminalResults.map(r => `$ ${r.command} → ${r.success ? "OK" : "FAIL"}`).join("\n") } : {}),
      ...(qaReport ? { build_status: qaReport.build.success ? "passed" : `failed:${qaReport.build.errorCount}` } : {}),
      ...(qaReport ? { quality_summary: qaReport.summary } : {}),
      ...(qaReport?.tests ? { test_results: qaReport.tests.success ? `passed:${qaReport.tests.passed}/${qaReport.tests.total}` : `failed:${qaReport.tests.failed}/${qaReport.tests.total}` } : {}),
      ...(qaReport?.lint ? { lint_results: qaReport.lint.success ? "passed" : `errors:${qaReport.lint.errorCount}` } : {}),
      ...(qaReport && !qaReport.passed ? { quality_errors: formatQualityReportForLLM(qaReport) } : {}),
    },
    terminalResults,
  };
}
