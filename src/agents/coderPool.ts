/**
 * Coder Pool — Big Corp Engineering: domain-specialized parallel coders.
 *
 * This meta-agent operates like a Staff Engineer spinning up a feature team:
 *   1. Decomposes the task into domain areas (Backend, Frontend, Data, etc.)
 *   2. Spawns N domain-scoped coders with clear file ownership
 *   3. Runs all domain coders in parallel via Promise.allSettled
 *   4. Applies file writes sequentially and merges outputs
 *
 * Each domain coder knows:
 *   • Which files/directories they own (no overlap)
 *   • What interfaces they must provide to other domains
 *   • What interfaces they consume from other domains
 *   • What the rest of the team is building (for compatibility)
 *
 * The result feeds into the Integrator agent, which validates
 * cross-domain contracts and writes any glue code.
 */

import * as vscode from "vscode";
import {
  AgentState,
  AgentMessage,
  postAgentMessage,
  type DomainAssignment,
  type TerminalResult,
} from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import { applyCodeToWorkspace } from "../utils/fileWriter";
import { runCommandsFromOutput } from "../utils/terminalRunner";
import {
  runQualityGate,
  formatQualityReportForLLM,
  filterDiagnosticsForFiles,
  type QualityGateResult,
  type BuildDiagnostic,
} from "../utils/qualityGate";
import { AgentOutputManager } from "../utils/agentOutputManager";
import { showBatchDiffs } from "../utils/diffViewer";

// ── Concurrency limiter ──────────────────────────────────────────────
// Limits parallel LLM API calls to avoid overwhelming the Copilot rate
// limit. Without this, N simultaneous domain coders cause throttling
// and timeouts.

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

/** Max concurrent LLM calls across domain coders. */
const LLM_CONCURRENCY = 2;

// ── Prompts ──────────────────────────────────────────────────────────

const DECOMPOSE_PROMPT = `You are a Staff Engineer responsible for decomposing a coding task
into parallel domain assignments for a team of engineers.

Given the task, workspace structure, and optional plan, split the work
into 2-5 independent domains. Each domain is an area of the codebase
that one engineer can own and implement without blocking others.

Rules:
1. Domains MUST have clear file ownership — NO overlapping file patterns.
2. Explicitly define interface contracts between domains (provides/consumes).
3. Each domain should be independently implementable.
4. Minimize cross-domain dependencies.
5. If the task only needs 1 domain, output exactly 1 domain.
6. Use descriptive, short IDs (kebab-case): "backend-api", "data-layer", "ui-components".

Output a JSON array inside a \`\`\`json code fence. Example:

\`\`\`json
[
  {
    "id": "backend-api",
    "domain": "Backend API",
    "description": "REST API routes, middleware, request/response handling",
    "filePatterns": ["src/api/**", "src/routes/**", "src/middleware/**"],
    "provides": "GET /users endpoint, POST /users endpoint, AuthMiddleware",
    "consumes": "UserService from data-layer"
  },
  {
    "id": "data-layer",
    "domain": "Data Layer",
    "description": "Database models, queries, business logic services",
    "filePatterns": ["src/models/**", "src/services/**", "src/db/**"],
    "provides": "UserService, DatabaseClient",
    "consumes": "nothing"
  }
]
\`\`\`

Output ONLY the JSON code block. No commentary.`;

function buildDomainCoderPrompt(
  domain: DomainAssignment,
  allDomains: DomainAssignment[]
): string {
  const otherDomains = allDomains.filter((d) => d.id !== domain.id);
  const teammates =
    otherDomains.length > 0
      ? otherDomains
          .map(
            (d) =>
              `  • ${d.domain} (${d.filePatterns.join(", ")}): ${d.description}\n` +
              `    Provides: ${d.provides}`
          )
          .join("\n")
      : "  (solo assignment — no teammates)";

  return `You are a Senior Engineer on a parallel feature team.
You are coder "${domain.id}" — you own one specific domain of the codebase.

═══════════════════════════════════════
YOUR ASSIGNMENT
═══════════════════════════════════════
  Domain:           ${domain.domain}
  Files you own:    ${domain.filePatterns.join(", ")}
  Responsibilities: ${domain.description}

INTERFACE CONTRACTS:
  You PROVIDE: ${domain.provides || "No external contracts"}
  You CONSUME: ${domain.consumes || "Nothing from other domains"}

YOUR TEAMMATES (working in parallel — their code will exist):
${teammates}

═══════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════
1. ONLY create/modify files within your file patterns: ${domain.filePatterns.join(", ")}
2. When you CONSUME an interface from another domain, import it as if it
   already exists — your teammate IS creating it right now.
   Use the EXACT contract specified above.
3. When you PROVIDE an interface, export it clearly with the EXACT signature
   specified in the contract. Other domains depend on it.
4. Write clean, production-quality, well-typed, well-documented code.
5. Do NOT duplicate work that belongs to another domain.
6. Include comprehensive JSDoc/docstrings at module and export boundaries.

YOUR CODE WILL BE AUTOMATICALLY VALIDATED:
  • Type checking (tsc --noEmit) — full project
  • Lint (eslint) — your files
  • Related tests (jest --findRelatedTests) — your files
  Any failures will be sent back to you for fixing.
  Write production-quality code that passes CI on the first attempt.

═══════════════════════════════════════
FILE FORMAT (mandatory for workspace writes)
═══════════════════════════════════════
For EVERY file you create or modify, use this exact format:

### \`path/to/file.ts\`
\`\`\`typescript
// full file contents here
\`\`\`

Rules:
- Use RELATIVE paths from project root.
- Include COMPLETE file contents — not diffs.
- Use correct language tags on code fences.
- If dependencies need installing, include a \`\`\`bash block.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself (src/agents/, src/graph/, src/utils/, src/security/,
src/types/, src/extension.ts). You are that extension — modifying your own
source code causes corruption and is blocked by the file writer.`;
}

// ── Domain decomposition ─────────────────────────────────────────────

/**
 * Parse a JSON array of DomainAssignment from LLM output.
 * Handles ```json fences and bare JSON arrays.
 */
export function parseDomainAssignments(raw: string): DomainAssignment[] {
  // Extract JSON from ```json fence if present
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (d: any) =>
          d && typeof d.id === "string" && typeof d.domain === "string"
      )
      .map((d: any) => ({
        id: String(d.id).trim(),
        domain: String(d.domain).trim(),
        description: String(d.description ?? "").trim(),
        filePatterns: Array.isArray(d.filePatterns)
          ? d.filePatterns.map(String)
          : [],
        provides: String(d.provides ?? "").trim(),
        consumes: String(d.consumes ?? "").trim(),
      }));
  } catch (err) {
    logger.error("coder-pool", `Failed to parse domain assignments: ${err}`);
    return [];
  }
}

/**
 * Use the LLM to decompose a task into domain assignments.
 */
async function decomposeDomains(
  task: string,
  workspaceContext: string,
  plan: string[],
  chatHistory: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<DomainAssignment[]> {
  let prompt = DECOMPOSE_PROMPT;
  if (plan.length > 0) {
    prompt += `\n\n## Current Plan\n${capContext(plan.join("\n"), 3_000)}`;
  }

  const messages = buildMessages({
    systemPrompt: prompt,
    workspaceContext,
    chatHistory,
    userQuestion: task,
    maxSystemChars: 6_000,
    maxWorkspaceChars: 8_000,
  });

  const response = await callModel(model, messages, null, token, "coder-pool-decompose");
  return parseDomainAssignments(response);
}

// ── Single domain coder ──────────────────────────────────────────────

interface DomainCoderResult {
  domain: DomainAssignment;
  response: string;
  durationMs: number;
  error?: string;
}

/**
 * Run a single domain-scoped coder via LLM.
 * Runs with stream=null (no direct streaming) since multiple run in parallel.
 */
async function runSingleDomainCoder(
  domain: DomainAssignment,
  allDomains: DomainAssignment[],
  state: AgentState,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<DomainCoderResult> {
  const start = Date.now();
  const sysPrompt = buildDomainCoderPrompt(domain, allDomains);

  let fullPrompt = sysPrompt;
  if (state.plan.length > 0) {
    fullPrompt += `\n\n## Plan\n${capContext(state.plan.join("\n"), 2_000)}`;
  }
  if (state.artifacts["review_feedback"]) {
    fullPrompt += `\n\n## Previous Review Feedback\n${capContext(state.artifacts["review_feedback"], 2_000)}`;
  }

  const lastUserContent =
    [...state.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const messages = buildMessages({
    systemPrompt: fullPrompt,
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    userQuestion: lastUserContent,
    maxSystemChars: 14_000,
    maxWorkspaceChars: 6_000,
    maxReferencesChars: 8_000,
  });

  try {
    const response = await callModel(
      model,
      messages,
      null, // no streaming — runs in parallel
      token,
      `coder:${domain.id}`
    );

    return {
      domain,
      response,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      domain,
      response: "",
      durationMs: Date.now() - start,
      error: err?.message ?? String(err),
    };
  }
}

// ── Coder Pool node (the graph-facing agent) ─────────────────────────

export async function coderPoolNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  const isRevision = !!state.artifacts["review_feedback"];

  stream.markdown(
    `---\n\n` +
      `#### 🏢 Engineering Team${isRevision ? ` — Revision #${state.reviewCount + 1}` : ""}\n\n`
  );

  // ── 1. Get or create domain assignments ──
  let domains = state.domainAssignments;

  if (domains.length === 0) {
    stream.markdown(`> 📐 **Staff Engineer** decomposing task into domains…\n\n`);

    const task =
      [...state.messages].reverse().find((m) => m.role === "user")?.content ??
      "";
    domains = await decomposeDomains(
      task,
      state.workspaceContext,
      state.plan,
      state.chatHistory,
      model,
      token
    );

    if (domains.length === 0) {
      // Fallback: create a single "full-stack" domain
      logger.warn("coder-pool", "Decomposition failed — falling back to single domain");
      domains = [
        {
          id: "full-stack",
          domain: "Full Stack",
          description: "Complete implementation",
          filePatterns: ["src/**", "**/*"],
          provides: "Everything",
          consumes: "Nothing",
        },
      ];
    }
  }

  // ── 2. Display domain roster ──
  stream.markdown(
    `> 🏗️ **${domains.length} domain coder${domains.length > 1 ? "s" : ""} assigned:**\n\n` +
      `| # | Domain | Owns | Responsibility |\n` +
      `|---|--------|------|----------------|\n` +
      domains
        .map(
          (d, i) =>
            `| ${i + 1} | **${d.domain}** | \`${d.filePatterns.join("`, `")}\` | ${d.description.slice(0, 60)} |`
        )
        .join("\n") +
      `\n\n`
  );

  // ── Set up output channels for parallel domain coders ──
  const outputMgr = AgentOutputManager.getInstance();
  if (domains.length > 1) {
    stream.markdown(`> 🔀 Running **${domains.length} domain coders in parallel** (max ${LLM_CONCURRENCY} concurrent)…\n\n`);
    // Reveal output channels for all domains
    const domainChannelNames = domains.map(d => `coder`);
    outputMgr.revealParallel(domainChannelNames);
  }

  // ── 3. Run domain coders with concurrency limit ──
  // Cap parallel LLM calls to avoid overwhelming the Copilot API rate limit.
  // With LLM_CONCURRENCY=2, two domain coders run at a time while others wait.
  const startAll = Date.now();
  const sem = new Semaphore(LLM_CONCURRENCY);
  const promises = domains.map(async (domain, idx) => {
    outputMgr.append("coder", `⏳ Domain ${idx + 1}/${domains.length}: ${domain.domain} — waiting for slot…\n`);
    await sem.acquire();
    outputMgr.append("coder", `🚀 Domain ${idx + 1}/${domains.length}: ${domain.domain} — generating code…\n`);
    try {
      return await runSingleDomainCoder(domain, domains, state, model, token);
    } finally {
      sem.release();
    }
  });
  const settled = await Promise.allSettled(promises);

  const results: DomainCoderResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") {
      results.push(s.value);
    } else {
      results.push({
        domain: domains[results.length] ?? domains[0],
        response: "",
        durationMs: 0,
        error: s.reason?.message ?? String(s.reason),
      });
    }
  }

  const parallelMs = Date.now() - startAll;

  // ── 4. Process each domain's output sequentially ──
  const allWrittenFiles: string[] = [];
  const allTerminalResults: TerminalResult[] = [];
  const allMessages: AgentMessage[] = [];
  const domainArtifacts: Record<string, string> = {};
  const errors: string[] = [];
  /** Track which files each domain wrote (for targeted error reporting). */
  const domainWrittenFiles: Map<string, string[]> = new Map();

  for (const result of results) {
    const { domain, response, durationMs, error } = result;
    const coderLabel = `📦 Coder: ${domain.domain}`;

    if (error) {
      stream.markdown(
        `\n##### ${coderLabel}\n\n` +
          `> ⚠️ **Error:** ${error}\n\n`
      );
      errors.push(`coder:${domain.id}: ${error}`);
      continue;
    }

    // Stream status to chat; detailed output goes to output channel
    stream.markdown(
      `\n##### ${coderLabel} _(${formatMs(durationMs)})_\n\n`
    );
    // Log status (NOT raw code) to the output channel
    outputMgr.append("coder", `\n✅ Domain: ${domain.domain} — completed in ${formatMs(durationMs)}\n`);

    // Apply file writes
    const domainFiles: string[] = [];
    try {
      const writeResult = await applyCodeToWorkspace(response, stream);
      domainFiles.push(...writeResult.written);
      allWrittenFiles.push(...writeResult.written);
      if (writeResult.written.length > 0) {
        // Show inline diffs for modified files
        await showBatchDiffs(writeResult.written, writeResult.oldContents);
        outputMgr.append("coder", `   📁 Wrote ${writeResult.written.length} file(s): ${writeResult.written.join(", ")}\n`);
        stream.markdown(`> ✅ **${domain.domain}**: ${writeResult.written.length} file(s) written — diffs shown in editor\n`);
        logger.info(
          `coder:${domain.id}`,
          `Wrote ${writeResult.written.length} file(s): ${writeResult.written.join(", ")}`
        );
      }
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      logger.error(`coder:${domain.id}`, `File write failed: ${errMsg}`);
      stream.markdown(`\n> ⚠️ File write error in ${domain.domain}: ${errMsg}\n`);
      errors.push(`coder:${domain.id}: file write failed: ${errMsg}`);
    }
    domainWrittenFiles.set(domain.id, domainFiles);

    // Run terminal commands
    try {
      const cmdResult = await runCommandsFromOutput(response, stream);
      for (const executed of cmdResult.executed) {
        allTerminalResults.push({
          command: executed.command,
          success: executed.success,
          stdout: executed.stdout,
          stderr: executed.stderr,
          agent: `coder:${domain.id}`,
        });
      }
    } catch (err: any) {
      logger.error(`coder:${domain.id}`, `Terminal command failed: ${err?.message}`);
    }

    // Store per-domain output
    const cappedResponse =
      response.length > 5000
        ? response.slice(0, 5000) + "\n[… truncated in state]"
        : response;

    allMessages.push({
      role: "assistant",
      name: `coder:${domain.id}`,
      content: cappedResponse,
    });

    domainArtifacts[`domain_code:${domain.id}`] = cappedResponse;
    postAgentMessage(state, `coder:${domain.id}`, "*", "info", cappedResponse);
  }

  // ── 5. Quality Gate + targeted error-feedback retry ──
  // After ALL domain coders have written their files, run the full quality
  // gate (build + lint + tests). If there are errors, identify which domain
  // caused each error and dispatch targeted fixes — each engineer only
  // sees THEIR OWN mistakes, like a real CI pipeline.
  let qaReport: QualityGateResult | null = null;
  const MAX_POOL_FIX_RETRIES = 2;
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (wsRoot && allWrittenFiles.length > 0) {
    for (let attempt = 0; attempt <= MAX_POOL_FIX_RETRIES; attempt++) {
      if (token.isCancellationRequested) { break; }

      qaReport = await runQualityGate(wsRoot, allWrittenFiles);

      if (qaReport.passed) {
        stream.markdown(`\n> ✅ **Quality gate passed** — ${qaReport.summary}\n`);
        break;
      }

      if (attempt >= MAX_POOL_FIX_RETRIES) {
        stream.markdown(
          `\n> ⚠️ **Quality gate still failing** after ${MAX_POOL_FIX_RETRIES} fix round(s). ` +
          `${qaReport.summary}. Passing to Integrator for resolution.\n`
        );
        break;
      }

      stream.markdown(
        `\n> 🔧 **Quality gate failed** (${qaReport.summary}) — ` +
        `dispatching targeted fixes (round ${attempt + 1}/${MAX_POOL_FIX_RETRIES})…\n`
      );

      // ── Dispatch targeted fix calls per domain ──
      // Build + lint errors have file paths → attribute to specific domains.
      // Test failures are included in all fix prompts (hard to attribute).
      const allDiagnostics: BuildDiagnostic[] = [
        ...qaReport.build.diagnostics,
        ...(qaReport.lint?.diagnostics ?? []),
      ];
      const testFailureSummary = qaReport.tests && !qaReport.tests.success
        ? qaReport.tests.failures.map(f => `- **${f.suiteName} › ${f.testName}**: ${f.message.slice(0, 200)}`).join("\n")
        : "";

      const fixPromises: Promise<DomainCoderResult>[] = [];
      for (const result of results) {
        if (result.error) { continue; }
        const domFiles = domainWrittenFiles.get(result.domain.id) ?? [];
        if (domFiles.length === 0) { continue; }

        const domainErrors = filterDiagnosticsForFiles(allDiagnostics, domFiles);
        if (domainErrors.length === 0 && !testFailureSummary) { continue; }

        let errorReport = domainErrors.map(d =>
          `- **${d.file}:${d.line}** [${d.code}] ${d.message}`
        ).join("\n");

        if (testFailureSummary) {
          errorReport += `\n\n### Test Failures (may relate to your domain):\n${testFailureSummary}`;
        }

        const totalIssues = domainErrors.length + (testFailureSummary ? 1 : 0);
        stream.markdown(
          `> 🔧 **${result.domain.domain}**: ${totalIssues} issue(s) — sending back for fix\n`
        );

        const fixPrompt = buildDomainCoderPrompt(result.domain, domains) +
          `\n\n## ❌ QUALITY GATE FAILED — FIX YOUR FILES\n` +
          `Your code failed the quality gate (build/lint/tests):\n${errorReport}\n\n` +
          `Rewrite ONLY the files that have errors. Include COMPLETE fixed file contents.\n` +
          `Do NOT re-output files that are already correct.`;

        fixPromises.push(
          (async (): Promise<DomainCoderResult> => {
            await sem.acquire();
            const start = Date.now();
            try {
              const fixMessages = buildMessages({
                systemPrompt: fixPrompt,
                workspaceContext: state.workspaceContext,
                chatHistory: "",
                userQuestion: `Fix the quality gate failures in your files: ${domFiles.join(", ")}`,
                maxSystemChars: 14_000,
                maxWorkspaceChars: 4_000,
              });
              const fixResponse = await callModel(model, fixMessages, null, token, `coder-fix:${result.domain.id}`);
              return { domain: result.domain, response: fixResponse, durationMs: Date.now() - start };
            } catch (err: any) {
              return { domain: result.domain, response: "", durationMs: Date.now() - start, error: err?.message ?? String(err) };
            } finally {
              sem.release();
            }
          })()
        );
      }

      if (fixPromises.length === 0) {
        stream.markdown(`> ℹ️ Errors may be cross-domain — passing to Integrator.\n`);
        break;
      }

      const fixSettled = await Promise.allSettled(fixPromises);
      for (const s of fixSettled) {
        const fixResult = s.status === "fulfilled" ? s.value : null;
        if (!fixResult || fixResult.error || !fixResult.response) { continue; }

        try {
          const writeResult = await applyCodeToWorkspace(fixResult.response, stream);
          if (writeResult.written.length > 0) {
            allWrittenFiles.push(...writeResult.written);
            const existing = domainWrittenFiles.get(fixResult.domain.id) ?? [];
            existing.push(...writeResult.written);
            domainWrittenFiles.set(fixResult.domain.id, existing);
            await showBatchDiffs(writeResult.written, writeResult.oldContents);
            logger.info(`coder-fix:${fixResult.domain.id}`, `Fix wrote ${writeResult.written.length} file(s)`);
          }
        } catch (err: any) {
          logger.error(`coder-fix:${fixResult.domain.id}`, `Fix write failed: ${err?.message}`);
        }
      }
    }
  }

  // ── 6. Summary ──
  const successCount = results.filter((r) => !r.error).length;
  const totalFiles = allWrittenFiles.length;
  const buildStatus = qaReport
    ? (qaReport.passed ? `✅ QA passed` : `⚠️ ${qaReport.summary}`)
    : "⏭️ no quality check";

  stream.markdown(
    `\n---\n\n` +
      `> ✅ **Engineering Team complete** ` +
      `(${successCount}/${domains.length} coders · ${totalFiles} files · ${formatMs(parallelMs)} wall-clock · ${buildStatus})\n`
  );

  if (allWrittenFiles.length > 0) {
    const byDomain = results
      .filter((r) => !r.error)
      .map((r) => `>   📦 ${r.domain.domain}`)
      .join("\n");
    stream.markdown(`\n${byDomain}\n\n`);
  }

  return {
    messages: allMessages,
    artifacts: {
      ...domainArtifacts,
      last_code: results
        .filter((r) => !r.error)
        .map((r) => r.response)
        .join("\n\n---\n\n"),
      ...(allWrittenFiles.length > 0
        ? { written_files: allWrittenFiles.join(", ") }
        : {}),
      ...(qaReport ? { build_status: qaReport.build.success ? "passed" : `failed:${qaReport.build.errorCount}` } : {}),
      ...(qaReport ? { quality_summary: qaReport.summary } : {}),
      ...(qaReport?.tests ? { test_results: qaReport.tests.success ? `passed:${qaReport.tests.passed}/${qaReport.tests.total}` : `failed:${qaReport.tests.failed}/${qaReport.tests.total}` } : {}),
      ...(qaReport?.lint ? { lint_results: qaReport.lint.success ? "passed" : `errors:${qaReport.lint.errorCount}` } : {}),
      ...(qaReport && !qaReport.passed ? { quality_errors: formatQualityReportForLLM(qaReport) } : {}),
    },
    domainAssignments: domains,
    terminalResults: allTerminalResults,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
