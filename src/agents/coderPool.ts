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

  if (domains.length > 1) {
    stream.markdown(`> 🔀 Running **${domains.length} domain coders in parallel**…\n\n`);
  }

  // ── 3. Run all domain coders in parallel ──
  const startAll = Date.now();
  const promises = domains.map((domain) =>
    runSingleDomainCoder(domain, domains, state, model, token)
  );
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

    // Show the domain coder's output
    stream.markdown(
      `\n##### ${coderLabel} _(${formatMs(durationMs)})_\n\n`
    );
    stream.markdown(response);

    // Apply file writes
    try {
      const writeResult = await applyCodeToWorkspace(response, stream);
      allWrittenFiles.push(...writeResult.written);
      if (writeResult.written.length > 0) {
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

    // Parse terminal commands (collect, run after all domains)
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

    // Post to the agent message bus
    postAgentMessage(state, `coder:${domain.id}`, "*", "info", cappedResponse);
  }

  // ── 5. Summary ──
  const successCount = results.filter((r) => !r.error).length;
  const totalFiles = allWrittenFiles.length;

  stream.markdown(
    `\n---\n\n` +
      `> ✅ **Engineering Team complete** ` +
      `(${successCount}/${domains.length} coders · ${totalFiles} files · ${formatMs(parallelMs)} wall-clock)\n`
  );

  if (allWrittenFiles.length > 0) {
    const byDomain = results
      .filter((r) => !r.error)
      .map((r) => {
        // Count files per domain by checking which written files match domain patterns
        return `>   📦 ${r.domain.domain}`;
      })
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
