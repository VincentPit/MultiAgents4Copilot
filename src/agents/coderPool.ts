/**
 * Coder Pool — Staff Engineer orchestration with Go-powered true parallelism.
 *
 * This meta-agent operates like a Staff Engineer running a feature team:
 *   1. Decomposes the task into domains with DETAILED API specs, schemas,
 *      interface contracts, and explicit test case requirements.
 *   2. Spawns a Go worker process that runs domain coders as goroutines
 *      for TRUE OS-level parallelism (not Node.js Promise.allSettled).
 *   3. Each Go goroutine gets its own VS Code output channel (separate window).
 *   4. Each domain coder writes individual tests for their own code.
 *   5. Results feed into the Integrator for merge + production test + feedback.
 *
 * If Go is not available, falls back to the Node.js Promise.allSettled approach.
 */

import * as vscode from "vscode";
import {
  AgentState,
  AgentMessage,
  postAgentMessage,
  type DomainAssignment,
  type BranchResult,
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
import { MultiCoderViewManager } from "../utils/multiCoderView";
import { showBatchDiffs } from "../utils/diffViewer";
import { GoWorkerBridge } from "../utils/goWorkerBridge";
import {
  readFilesMatching,
  formatFilesForLLM,
  domainPatternsToGlobs,
} from "../utils/fileReader";

// ── Concurrency limiter ──────────────────────────────────────────────
// Limits parallel LLM API calls to avoid overwhelming the Copilot rate
// limit. Without this, N simultaneous domain coders cause throttling
// and timeouts.

export class Semaphore {
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
export const LLM_CONCURRENCY = 2;

/** Hard ceiling on domain count — prevents runaway decomposition. */
export const MAX_DOMAINS = 6;

// ── Prompts ──────────────────────────────────────────────────────────

const DECOMPOSE_PROMPT = `You are a Staff Engineer responsible for decomposing a coding task
into parallel domain assignments for a team of engineers.

You must provide DETAILED, ACTIONABLE specifications — not vague descriptions.
Each engineer needs enough detail to implement independently without asking questions.

Given the task, workspace structure, and optional plan, split the work
into BETWEEN 2 AND 6 independent domains. NEVER output more than 6 domains.
This is a HARD LIMIT. If you think the project has more than 6 concerns,
merge related concerns into broader domains (e.g., combine all API routes
into one "backend-api" domain, all UI pages into one "frontend" domain).

Rules:
1. MAXIMUM 6 DOMAINS. No exceptions. Merge related concerns if needed.
2. Domains MUST have clear file ownership — NO overlapping file patterns.
3. Explicitly define interface contracts between domains (provides/consumes).
4. Each domain should be independently implementable AND testable.
5. Minimize cross-domain dependencies.
6. If the task only needs 1 domain, output exactly 1 domain.
7. Use descriptive, short IDs (kebab-case): "backend-api", "data-layer", "ui-components".

CRITICAL — DETAILED API SPEC:
For each domain, include a detailed "apiSpec" object with:
  - "endpoints": exact HTTP endpoints with request/response schemas
  - "interfaces": TypeScript/Python type definitions to export/import
  - "testCases": specific test cases the engineer MUST write and pass
  - "dependencies": npm/pip packages needed

Output a JSON array inside a \`\`\`json code fence:

\`\`\`json
[
  {
    "id": "backend-api",
    "domain": "Backend API",
    "description": "REST API routes with validation, error handling, middleware",
    "filePatterns": ["src/api/**", "src/routes/**", "src/middleware/**"],
    "provides": "GET /api/users, POST /api/users, PUT /api/users/:id, AuthMiddleware",
    "consumes": "UserService from data-layer, User type from shared-types",
    "apiSpec": {
      "endpoints": [
        {
          "method": "GET",
          "path": "/api/users",
          "requestSchema": "query: { page?: number; limit?: number; search?: string }",
          "responseSchema": "{ users: User[]; total: number; page: number; pageSize: number }",
          "description": "List users with pagination and optional search filter"
        },
        {
          "method": "POST",
          "path": "/api/users",
          "requestSchema": "body: { name: string; email: string; role?: UserRole }",
          "responseSchema": "{ user: User; token: string }",
          "description": "Create a new user with input validation"
        }
      ],
      "interfaces": [
        {
          "name": "User",
          "definition": "{ id: string; name: string; email: string; role: UserRole; createdAt: Date }",
          "exportedFrom": "src/types/user.ts"
        },
        {
          "name": "UserRole",
          "definition": "'admin' | 'user' | 'viewer'",
          "exportedFrom": "src/types/user.ts"
        }
      ],
      "testCases": [
        "should return paginated user list with default page size",
        "should filter users by search query",
        "should create user with valid data and return JWT",
        "should return 400 for invalid email format",
        "should return 400 for missing required fields",
        "should return 409 for duplicate email",
        "should return 401 for requests without auth token"
      ],
      "dependencies": ["express", "@types/express", "zod", "jsonwebtoken"]
    }
  },
  {
    "id": "data-layer",
    "domain": "Data Layer",
    "description": "Database models, repositories, business logic services",
    "filePatterns": ["src/models/**", "src/services/**", "src/db/**"],
    "provides": "UserService.create(), UserService.findAll(), UserService.findById(), DatabaseClient",
    "consumes": "User type from shared-types",
    "apiSpec": {
      "endpoints": [],
      "interfaces": [
        {
          "name": "UserService",
          "definition": "{ create(data: CreateUserDTO): Promise<User>; findAll(opts: PaginationOpts): Promise<PaginatedResult<User>>; findById(id: string): Promise<User | null> }",
          "exportedFrom": "src/services/userService.ts"
        }
      ],
      "testCases": [
        "should create a user and return with generated ID",
        "should find all users with pagination",
        "should return null for non-existent user ID",
        "should throw on duplicate email constraint"
      ],
      "dependencies": ["better-sqlite3", "@types/better-sqlite3"]
    }
  }
]
\`\`\`

Output ONLY the JSON code block. No commentary.`;

// ── Scaffold Prompt ──────────────────────────────────────────────────
// After domain decomposition but BEFORE parallel coding, the Staff
// Engineer generates a shared scaffold (the "main branch") that all
// domain coders build ON TOP of. This eliminates glue-code drift.

const SCAFFOLD_PROMPT = `You are a Staff Engineer setting up the shared foundation for a team
of parallel domain engineers. You just decomposed a task into domains.

NOW you must create the SCAFFOLD — the shared skeleton that ALL engineers
will build on top of. Think of this as setting up the repo before anyone
starts coding.

YOUR JOB — generate ONLY these shared foundation files:
1. **Shared type definitions** — all cross-domain interfaces and types
   that appear in ANY domain's "provides" or "consumes" contracts.
   Put these in a central location (e.g., src/types/, src/shared/).
2. **Configuration files** — package.json (with all dependencies from
   all domains), tsconfig.json, .env.example, jest.config.js, etc.
3. **Barrel exports** — index.ts files that will re-export from each domain.
   Leave them as stubs that import from the paths each domain will create.
4. **Directory structure** — create empty placeholder files or directories
   if needed to establish the project layout.
5. **Entry point stubs** — main.ts / app.ts / index.ts with skeleton
   wiring that imports from each domain (implementation left to domains).

CRITICAL RULES:
- Output ONLY shared/foundation files — NOT domain implementation code.
- Every type/interface that crosses domain boundaries MUST be defined here.
- Use the EXACT type names and signatures from the domain API specs.
- Keep files minimal — just enough for domain coders to import from.
- Include a package.json if dependencies need installing.
- Do NOT include test files — each domain writes their own tests.
- Use the standard file format: ### \`path/to/file.ts\` + code fence.

SELF-PROTECTION — NEVER modify files belonging to the Multi-Agent Copilot
extension itself (src/agents/, src/graph/, src/utils/, src/security/,
src/types/, src/extension.ts). You are that extension.`;

/** Files written by the scaffold step, tracked for context. */
interface ScaffoldResult {
  filesWritten: string[];
  scaffoldCode: string;
}

/**
 * Generate and write the shared scaffold — called BEFORE parallel domain coders.
 * Returns the list of files written and the scaffold LLM output for context injection.
 */
async function generateScaffold(
  domains: DomainAssignment[],
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<ScaffoldResult> {
  // Build rich context about all domains for the scaffold generator
  const domainSpecs = domains.map(d => {
    let spec = `### ${d.domain} (${d.id})\n` +
      `  Files: ${d.filePatterns.join(", ")}\n` +
      `  Provides: ${d.provides}\n` +
      `  Consumes: ${d.consumes}\n`;

    if (d.apiSpec) {
      if (d.apiSpec.interfaces.length > 0) {
        spec += `  Interfaces:\n`;
        for (const iface of d.apiSpec.interfaces) {
          spec += `    - ${iface.name}: ${iface.definition} (from ${iface.exportedFrom})\n`;
        }
      }
      if (d.apiSpec.endpoints.length > 0) {
        spec += `  Endpoints:\n`;
        for (const ep of d.apiSpec.endpoints) {
          spec += `    - ${ep.method} ${ep.path}: req=${ep.requestSchema}, res=${ep.responseSchema}\n`;
        }
      }
      if (d.apiSpec.dependencies.length > 0) {
        spec += `  Dependencies: ${d.apiSpec.dependencies.join(", ")}\n`;
      }
    }

    return spec;
  }).join("\n");

  // Build contract map for cross-domain types
  const contractMap = domains.map(d =>
    `• ${d.domain}: provides [${d.provides}], consumes [${d.consumes}]`
  ).join("\n");

  let prompt = SCAFFOLD_PROMPT;
  prompt += `\n\n## Domain Assignments\n${domainSpecs}`;
  prompt += `\n\n## Cross-Domain Contract Map\n${contractMap}`;

  const lastUserContent =
    [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  if (state.plan.length > 0) {
    prompt += `\n\n## Plan\n${capContext(state.plan.join("\n"), 2_000)}`;
  }

  const messages = buildMessages({
    systemPrompt: prompt,
    workspaceContext: state.workspaceContext,
    chatHistory: "",
    userQuestion: `Set up the shared scaffold for: ${lastUserContent}`,
    maxSystemChars: 16_000,
    maxWorkspaceChars: 6_000,
  });

  const scaffoldCode = await callModel(model, messages, null, token, "staff-scaffold");

  // Write scaffold files to disk
  let filesWritten: string[] = [];
  try {
    const writeResult = await applyCodeToWorkspace(scaffoldCode, stream, { autoApprove: true });
    filesWritten = writeResult.written;
    if (filesWritten.length > 0) {
      await showBatchDiffs(filesWritten, writeResult.oldContents);
    }
  } catch (err: any) {
    logger.error("staff-scaffold", `Scaffold write failed: ${err?.message}`);
  }

  // Run any setup commands (e.g., npm install) — auto-approve common ones
  try {
    await runCommandsFromOutput(scaffoldCode, stream, { autoApprove: true });
  } catch (err: any) {
    logger.warn("staff-scaffold", `Scaffold commands failed: ${err?.message}`);
  }

  return { filesWritten, scaffoldCode };
}

function buildDomainCoderPrompt(
  domain: DomainAssignment,
  allDomains: DomainAssignment[],
  scaffoldFiles?: string[],
  scaffoldCode?: string,
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

  // Build API spec section if available
  let apiSpecSection = "";
  if (domain.apiSpec) {
    const spec = domain.apiSpec;

    if (spec.endpoints.length > 0) {
      const endpointLines = spec.endpoints.map(
        (e) => `  ${e.method} ${e.path} — ${e.description}\n` +
               `    Request:  ${e.requestSchema}\n` +
               `    Response: ${e.responseSchema}`
      ).join("\n\n");
      apiSpecSection += `\n\n═══════════════════════════════════════
API SPECIFICATIONS (implement these EXACTLY)
═══════════════════════════════════════

### Endpoints:
${endpointLines}`;
    }

    if (spec.interfaces.length > 0) {
      const ifaceLines = spec.interfaces.map(
        (i) => `  ${i.name}: ${i.definition}\n    Export from: ${i.exportedFrom}`
      ).join("\n\n");
      apiSpecSection += `\n\n### Interface Contracts:
${ifaceLines}`;
    }

    if (spec.dependencies.length > 0) {
      apiSpecSection += `\n\n### Dependencies to install:
${spec.dependencies.map(d => `  - ${d}`).join("\n")}`;
    }

    if (spec.testCases.length > 0) {
      apiSpecSection += `\n\n═══════════════════════════════════════
REQUIRED INDIVIDUAL TESTS (you MUST write these)
═══════════════════════════════════════
Write a test file for YOUR domain. Include at minimum:
${spec.testCases.map(t => `  ✓ ${t}`).join("\n")}

Put tests in a file matching your domain pattern
(e.g., src/api/__tests__/routes.test.ts).
Use the appropriate test framework (Jest for TS/JS, pytest for Python, etc.).
Each test must be independently runnable.`;
    }
  }

  return `You are a Senior Engineer on a parallel feature team.
You are coder "${domain.id}" — you own one specific domain of the codebase.

═══════════════════════════════════════
YOUR ASSIGNMENT
═══════════════════════════════════════
  Domain:           ${domain.domain}
  Files you own:    ${domain.filePatterns.join(", ")}
  Responsibilities: ${domain.description}
${apiSpecSection}

INTERFACE CONTRACTS:
  You PROVIDE: ${domain.provides || "No external contracts"}
  You CONSUME: ${domain.consumes || "Nothing from other domains"}

YOUR TEAMMATES (working in parallel — their code will exist):
${teammates}
${scaffoldFiles && scaffoldFiles.length > 0 ? `
═══════════════════════════════════════
SHARED SCAFFOLD (already on disk — DO NOT recreate these)
═══════════════════════════════════════
The Staff Engineer already set up a shared foundation that you MUST build
on top of. These files are already written to disk:

  ${scaffoldFiles.map(f => `📄 ${f}`).join("\n  ")}

IMPORT from these files — do NOT redefine the types/interfaces they contain.
If a type you need is already in the scaffold, import it from there.
${scaffoldCode ? `\nScaffold contents (for reference):\n${capContext(scaffoldCode, 4_000)}` : ""}
` : ""}
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
7. YOU MUST WRITE INDIVIDUAL TESTS for your domain's code.
   Each domain must have its own test file(s) — tests run before integration.

YOUR CODE WILL BE AUTOMATICALLY VALIDATED:
  • Type checking (tsc --noEmit) — full project
  • Lint (eslint) — your files
  • Individual tests (jest --findRelatedTests) — your files
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

    // Hard-cap: never return more than MAX_DOMAINS regardless of LLM output
    const capped = parsed.slice(0, MAX_DOMAINS);
    if (parsed.length > MAX_DOMAINS) {
      logger.warn("coder-pool", `LLM returned ${parsed.length} domains — clamped to ${MAX_DOMAINS}`);
    }

    return capped
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
        apiSpec: d.apiSpec ? {
          endpoints: Array.isArray(d.apiSpec.endpoints) ? d.apiSpec.endpoints : [],
          interfaces: Array.isArray(d.apiSpec.interfaces) ? d.apiSpec.interfaces : [],
          testCases: Array.isArray(d.apiSpec.testCases) ? d.apiSpec.testCases.map(String) : [],
          dependencies: Array.isArray(d.apiSpec.dependencies) ? d.apiSpec.dependencies.map(String) : [],
        } : undefined,
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
  token: vscode.CancellationToken,
  scaffold?: ScaffoldResult,
): Promise<DomainCoderResult> {
  const start = Date.now();
  const sysPrompt = buildDomainCoderPrompt(
    domain, allDomains, scaffold?.filesWritten, scaffold?.scaffoldCode,
  );

  let fullPrompt = sysPrompt;

  // ── Read existing files matching this domain's patterns ──
  // Gives the coder visibility into what's already on disk so it can
  // integrate with (rather than overwrite) the existing codebase.
  try {
    const globs = domainPatternsToGlobs(domain.filePatterns);
    const existingFiles = await readFilesMatching(globs, {
      maxFiles: 20,
      maxCharsPerFile: 6_000,
      maxTotalChars: 40_000,
    });
    if (existingFiles.length > 0) {
      const existingContext = formatFilesForLLM(
        existingFiles,
        "EXISTING SOURCE FILES (already on disk — read before coding)",
      );
      fullPrompt += `\n\n${existingContext}`;
      logger.info(`coder:${domain.id}`, `Injected ${existingFiles.length} existing file(s) into prompt`);
    }
  } catch (err: any) {
    logger.warn(`coder:${domain.id}`, `Failed to read existing files: ${err?.message}`);
  }

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

  // ── 1. Get or create domain assignments (enhanced Staff Engineer) ──
  let domains = state.domainAssignments;

  if (domains.length === 0) {
    stream.markdown(`> 📐 **Staff Engineer** decomposing task with detailed API specs…\n\n`);

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

  // ── 2. Display enhanced domain roster ──
  const apiSpecCount = domains.filter(d => d.apiSpec).length;
  const totalEndpoints = domains.reduce((sum, d) => sum + (d.apiSpec?.endpoints?.length ?? 0), 0);
  const totalTestCases = domains.reduce((sum, d) => sum + (d.apiSpec?.testCases?.length ?? 0), 0);

  stream.markdown(
    `> 🏗️ **${domains.length} domain coder${domains.length > 1 ? "s" : ""} assigned** ` +
    `(${apiSpecCount} with API specs, ${totalEndpoints} endpoints, ${totalTestCases} test cases):\n\n` +
      `| # | Domain | Owns | Endpoints | Tests | Responsibility |\n` +
      `|---|--------|------|-----------|-------|----------------|\n` +
      domains
        .map(
          (d, i) =>
            `| ${i + 1} | **${d.domain}** | \`${d.filePatterns.join("`, `")}\` | ` +
            `${d.apiSpec?.endpoints?.length ?? 0} | ${d.apiSpec?.testCases?.length ?? 0} | ` +
            `${d.description.slice(0, 50)} |`
        )
        .join("\n") +
      `\n\n`
  );

  // ── 3. Generate shared scaffold ("main branch") ──
  // The Staff Engineer writes shared types, config, barrel exports, and
  // entry point stubs BEFORE domain coders start. This way every coder
  // builds ON TOP of an agreed foundation instead of inventing their own.
  let scaffold: ScaffoldResult = { filesWritten: [], scaffoldCode: "" };

  if (domains.length > 1 && !isRevision) {
    stream.markdown(`> 🏗️ **Staff Engineer** generating shared scaffold…\n\n`);
    scaffold = await generateScaffold(domains, state, model, stream, token);

    if (scaffold.filesWritten.length > 0) {
      stream.markdown(
        `> ✅ **Scaffold ready** — ${scaffold.filesWritten.length} shared file(s) on disk:\n` +
        scaffold.filesWritten.map(f => `>   📄 \`${f}\``).join("\n") +
        `\n\n`
      );
    } else {
      stream.markdown(`> ℹ️ No scaffold files generated (coders will create from scratch)\n\n`);
    }
  }

  // ── 4. Create per-domain output channels + multi-window view ──
  const outputMgr = AgentOutputManager.getInstance();
  outputMgr.createDomainChannels(domains);

  // Open individual webview panels for each coder
  const multiView = MultiCoderViewManager.getInstance();
  multiView.openAll(domains);

  // ── 5. Try Go workers for true parallelism, fall back to JS ──
  const extensionPath = vscode.extensions.getExtension("stephenlee.multi-agent-copilot")
    ?.extensionUri?.fsPath ?? "";
  const goAvailable = extensionPath && await GoWorkerBridge.isAvailable(extensionPath);

  let branchResults: BranchResult[];
  const startAll = Date.now();

  if (goAvailable && domains.length > 1) {
    stream.markdown(
      `> 🚀 **Go worker** launched — ${domains.length} goroutines for **true parallel** execution\n\n`
    );
    branchResults = await runWithGoWorkers(
      extensionPath, domains, state, model, stream, token, outputMgr,
      scaffold,
    );
  } else {
    if (!goAvailable) {
      stream.markdown(
        `> ℹ️ Go worker not available — using Node.js parallel execution (install Go for true parallelism)\n\n`
      );
    }
    stream.markdown(`> 🔀 Running **${domains.length} domain coders in parallel** (max ${LLM_CONCURRENCY} concurrent)…\n\n`);
    branchResults = await runWithJSFallback(
      domains, state, model, stream, token, outputMgr,
      scaffold,
    );
  }

  const parallelMs = Date.now() - startAll;

  // ── 5. Summary ──
  const successCount = branchResults.filter((r) => r.errors.length === 0).length;
  const totalFiles = branchResults.reduce((sum, r) => sum + r.filesWritten.length, 0);
  const testsPassedCount = branchResults.filter(r => r.testsPassed).length;

  stream.markdown(
    `\n---\n\n` +
      `> ✅ **Engineering Team complete** ` +
      `(${successCount}/${domains.length} coders · ${totalFiles} files · ` +
      `${testsPassedCount}/${domains.length} tests passed · ` +
      `${formatMs(parallelMs)} wall-clock` +
      `${goAvailable && domains.length > 1 ? " · Go goroutines" : ""})\n`
  );

  // Build per-domain artifacts
  const domainArtifacts: Record<string, string> = {};
  const allMessages: AgentMessage[] = [];

  for (const br of branchResults) {
    domainArtifacts[`domain_code:${br.domainId}`] = br.code.length > 5000
      ? br.code.slice(0, 5000) + "\n[… truncated]"
      : br.code;

    allMessages.push({
      role: "assistant",
      name: `coder:${br.domainId}`,
      content: br.code.length > 5000 ? br.code.slice(0, 5000) + "\n[… truncated]" : br.code,
    });
  }

  // Clean up domain channels (keep multi-window view open for review)
  outputMgr.disposeDomainChannels();

  // Aggregate build/quality status for downstream nodes
  const allErrors = branchResults.flatMap(r => r.errors);
  const allTestsFailed = branchResults.filter(r => !r.testsPassed);
  const buildPassed = allErrors.length === 0 && allTestsFailed.length === 0;
  const qualityErrors = [
    ...allErrors,
    ...allTestsFailed
      .filter(r => r.testOutput)
      .map(r => `[${r.domainId}] ${r.testOutput}`),
  ];

  return {
    messages: allMessages,
    artifacts: {
      ...domainArtifacts,
      last_code: branchResults.map(r => r.code).join("\n\n---\n\n"),
      written_files: [
        ...scaffold.filesWritten,
        ...branchResults.flatMap(r => r.filesWritten),
      ].join(", "),
      build_status: buildPassed
        ? "passed"
        : `failed:${allTestsFailed.length}`,
      ...(qualityErrors.length > 0 ? {
        quality_errors: qualityErrors.join("\n"),
      } : {}),
      ...(scaffold.filesWritten.length > 0 ? {
        scaffold_files: scaffold.filesWritten.join(", "),
        scaffold_code: scaffold.scaffoldCode.length > 5000
          ? scaffold.scaffoldCode.slice(0, 5000) + "\n[… truncated]"
          : scaffold.scaffoldCode,
      } : {}),
    },
    domainAssignments: domains,
    branchResults,
  };
}

// ── Go Worker execution ──────────────────────────────────────────────

async function runWithGoWorkers(
  extensionPath: string,
  domains: DomainAssignment[],
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  outputMgr: AgentOutputManager,
  scaffold?: ScaffoldResult,
): Promise<BranchResult[]> {
  const bridge = new GoWorkerBridge(extensionPath, model, state, stream, token);
  const multiView = MultiCoderViewManager.getInstance();

  // Mark all domains as coding in the multi-window view
  for (const d of domains) {
    multiView.updateStatus(d.id, "coding", { phase: "goroutine started" });
    multiView.appendLog(d.id, "🚀 Go goroutine started…");
  }

  try {
    const results = await bridge.run(
      domains,
      [...state.messages].reverse().find(m => m.role === "user")?.content ?? "",
      state.plan,
      2, // maxFixRetries
      (result) => {
        // Per-worker completion callback — update dashboard + multi-window view
        const status = result.testsPassed ? "✅" : "⚠️";
        const elapsed = formatMs(result.durationMs);
        outputMgr.updateDomainStatus(
          result.domainId,
          `${status} done (${elapsed})`,
        );
        multiView.updateStatus(result.domainId, result.testsPassed ? "done" : "error", {
          phase: `${result.filesWritten?.length ?? 0} file(s), ${elapsed}`,
        });
        if (result.filesWritten?.length) {
          multiView.addFiles(result.domainId, result.filesWritten);
        }
        multiView.setTestResult(
          result.domainId,
          result.testsPassed,
          result.testOutput ?? "",
        );
        stream.markdown(
          `\n##### 📦 ${result.domain} ${status} _(${elapsed})_\n` +
          `> ${result.filesWritten.length} file(s), ` +
          `tests: ${result.testsPassed ? "passed" : "failed"}, ` +
          `fixes: ${result.fixAttempts}\n\n`
        );
      },
      scaffold?.filesWritten,
      scaffold?.scaffoldCode,
    );

    return results.map(r => ({
      domainId: r.domainId,
      domain: r.domain,
      filesWritten: r.filesWritten ?? [],
      testsPassed: r.testsPassed,
      testOutput: r.testOutput ?? "",
      errors: r.errors ?? [],
      fixAttempts: r.fixAttempts ?? 0,
      code: r.code ?? "",
      durationMs: r.durationMs ?? 0,
    }));
  } catch (err: any) {
    logger.error("go-bridge", `Go worker failed: ${err.message}`);
    stream.markdown(`\n> ⚠️ Go worker failed: ${err.message}. Falling back to JS.\n\n`);

    // Fallback to JS execution
    return runWithJSFallback(domains, state, model, stream, token, outputMgr, scaffold);
  }
}

// ── JavaScript fallback execution ────────────────────────────────────

async function runWithJSFallback(
  domains: DomainAssignment[],
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  outputMgr: AgentOutputManager,
  scaffold?: ScaffoldResult,
): Promise<BranchResult[]> {
  const sem = new Semaphore(LLM_CONCURRENCY);

  const multiView = MultiCoderViewManager.getInstance();

  const promises = domains.map(async (domain, idx) => {
    const channelName = `domain:${domain.id}`;
    outputMgr.append(channelName, `⏳ Domain ${idx + 1}/${domains.length}: ${domain.domain} — waiting…`);
    outputMgr.updateDomainStatus(domain.id, `⏳ queued (${idx + 1}/${domains.length})`);
    multiView.appendLog(domain.id, `⏳ Queued (${idx + 1}/${domains.length})`);
    await sem.acquire();
    outputMgr.append(channelName, `🚀 Generating code…`);
    outputMgr.updateDomainStatus(domain.id, "🚀 coding…");
    multiView.updateStatus(domain.id, "coding", { phase: "generating code" });
    multiView.appendLog(domain.id, `🚀 Generating code…`);

    const start = Date.now();
    try {
      const result = await runSingleDomainCoder(domain, domains, state, model, token, scaffold);
      const durationMs = Date.now() - start;

      // Apply code blocks + run individual tests
      let filesWritten: string[] = [];
      let testsPassed = false;
      let testOutput = "";

      if (!result.error && result.response) {
        // Write files
        try {
          const writeResult = await applyCodeToWorkspace(result.response, stream, { autoApprove: true });
          filesWritten = writeResult.written;
          if (filesWritten.length > 0) {
            await showBatchDiffs(filesWritten, writeResult.oldContents);
            outputMgr.append(channelName, `📁 Wrote ${filesWritten.length} file(s): ${filesWritten.join(", ")}`);
            outputMgr.updateDomainStatus(domain.id, `📁 ${filesWritten.length} file(s) written`);
            multiView.updateStatus(domain.id, "writing", { phase: `${filesWritten.length} file(s)` });
            multiView.addFiles(domain.id, filesWritten);
            multiView.appendLog(domain.id, `📁 Wrote ${filesWritten.length} file(s): ${filesWritten.join(", ")}`);
          }
        } catch (err: any) {
          outputMgr.append(channelName, `⚠️ File write error: ${err?.message}`);
          multiView.appendLog(domain.id, `⚠️ File write error: ${err?.message}`);
        }

        // Run individual tests
        if (filesWritten.length > 0) {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (wsRoot) {
            outputMgr.append(channelName, `🧪 Running individual tests…`);
            multiView.updateStatus(domain.id, "testing", { phase: "running tests" });
            multiView.appendLog(domain.id, `🧪 Running individual tests…`);
            const qa = await runQualityGate(wsRoot, filesWritten);
            testsPassed = qa.passed;
            testOutput = qa.passed ? "All passed" : formatQualityReportForLLM(qa);
            outputMgr.append(channelName, testsPassed ? `✅ Tests passed` : `❌ Tests failed`);
            outputMgr.updateDomainStatus(domain.id, testsPassed ? "✅ tests passed" : "❌ tests failed");
            multiView.setTestResult(domain.id, testsPassed, testOutput);
            multiView.appendLog(domain.id, testsPassed ? `✅ Tests passed` : `❌ Tests failed`);
          }
        }
      }

      const elapsed = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
      outputMgr.updateDomainStatus(domain.id, `✅ done (${elapsed})`);
      multiView.updateStatus(domain.id, result.error ? "error" : "done", {
        phase: result.error ? result.error.slice(0, 60) : `${filesWritten.length} file(s), ${elapsed}`,
      });

      const branchResult: BranchResult = {
        domainId: domain.id,
        domain: domain.domain,
        filesWritten,
        testsPassed,
        testOutput,
        errors: result.error ? [result.error] : [],
        fixAttempts: 0,
        code: result.response || "",
        durationMs,
      };

      stream.markdown(
        `\n##### 📦 ${domain.domain} _(${formatMs(durationMs)})_\n` +
        `> ${filesWritten.length} file(s), tests: ${testsPassed ? "✅" : "❌"}\n\n`
      );

      return branchResult;
    } finally {
      sem.release();
    }
  });

  const settled = await Promise.allSettled(promises);
  return settled.map((s, i) => {
    if (s.status === "fulfilled") { return s.value; }
    return {
      domainId: domains[i].id,
      domain: domains[i].domain,
      filesWritten: [],
      testsPassed: false,
      testOutput: "",
      errors: [s.reason?.message ?? String(s.reason)],
      fixAttempts: 0,
      code: "",
      durationMs: 0,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
