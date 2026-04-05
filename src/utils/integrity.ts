/**
 * Module integrity checker — validates that all critical exports exist
 * at activation time.
 *
 * This catches the exact failure mode from the multi-agent incident:
 *   - Truncated files that lost their exports
 *   - Rewritten modules that changed their public API surface
 *   - Missing functions that other modules depend on
 *
 * Run verifyModuleIntegrity() at extension activation. If any check
 * fails, the extension logs a clear diagnostic and refuses to start
 * the agent graph (preventing cryptic runtime crashes).
 */

import { logger } from "./logger.js";

/** A single export that must exist in a module. */
interface ExportCheck {
  /** The named export to verify. */
  name: string;
  /** Expected type: "function", "object", "string", etc. */
  expectedType: string;
}

/** A module and its required exports. */
interface ModuleContract {
  /** Human-readable label for diagnostics. */
  label: string;
  /** The module object (already imported). */
  module: Record<string, unknown>;
  /** Exports that MUST exist. */
  requiredExports: ExportCheck[];
}

/** Result of the integrity check. */
export interface IntegrityReport {
  ok: boolean;
  /** One entry per failed check. */
  failures: { module: string; export: string; expected: string; actual: string }[];
  /** Modules that passed all checks. */
  passed: string[];
}

/**
 * Verify that all critical module contracts are satisfied.
 */
export function verifyModuleIntegrity(contracts: ModuleContract[]): IntegrityReport {
  const failures: IntegrityReport["failures"] = [];
  const passed: string[] = [];

  for (const contract of contracts) {
    let modulePassed = true;

    for (const check of contract.requiredExports) {
      const actual = contract.module[check.name];
      const actualType = typeof actual;

      if (actual === undefined || actual === null) {
        failures.push({
          module: contract.label,
          export: check.name,
          expected: check.expectedType,
          actual: "missing",
        });
        modulePassed = false;
      } else if (actualType !== check.expectedType) {
        failures.push({
          module: contract.label,
          export: check.name,
          expected: check.expectedType,
          actual: actualType,
        });
        modulePassed = false;
      }
    }

    if (modulePassed) {
      passed.push(contract.label);
    }
  }

  return { ok: failures.length === 0, failures, passed };
}

/**
 * Build the contract list for all critical modules, run the check,
 * and log diagnostics.
 *
 * Call this from activate() in extension.ts. It dynamically imports
 * the modules so that a truncated file is caught at startup rather
 * than mid-conversation.
 */
export async function runIntegrityCheck(): Promise<IntegrityReport> {
  // Dynamic imports so a broken module does not prevent the checker from loading
  let base: Record<string, unknown>;
  let stateModule: Record<string, unknown>;
  let routerModule: Record<string, unknown>;
  let builderModule: Record<string, unknown>;
  let fileWriterModule: Record<string, unknown>;
  let terminalRunnerModule: Record<string, unknown>;
  let githubModule: Record<string, unknown>;

  const earlyFail = (mod: string, e: unknown): IntegrityReport => {
    logger.error("integrity", `Failed to import ${mod}: ${e}`);
    return {
      ok: false,
      failures: [{ module: mod, export: "*", expected: "module", actual: "import failed" }],
      passed: [],
    };
  };

  try { base = await import("../agents/base.js"); } catch (e) { return earlyFail("agents/base", e); }
  try { stateModule = await import("../graph/state.js"); } catch (e) { return earlyFail("graph/state", e); }
  try { routerModule = await import("../graph/router.js"); } catch (e) { return earlyFail("graph/router", e); }
  try { builderModule = await import("../graph/builder.js"); } catch (e) { return earlyFail("graph/builder", e); }
  try { fileWriterModule = await import("../utils/fileWriter.js"); } catch (e) { return earlyFail("utils/fileWriter", e); }
  try { terminalRunnerModule = await import("../utils/terminalRunner.js"); } catch (e) { return earlyFail("utils/terminalRunner", e); }
  try { githubModule = await import("../utils/github.js"); } catch (e) { return earlyFail("utils/github", e); }

  const contracts: ModuleContract[] = [
    {
      label: "agents/base",
      module: base,
      requiredExports: [
        { name: "callModel", expectedType: "function" },
        { name: "buildMessages", expectedType: "function" },
        { name: "selectModel", expectedType: "function" },
        { name: "createBudget", expectedType: "function" },
        { name: "capContext", expectedType: "function" },
        { name: "safeBudget", expectedType: "function" },
        { name: "countTokens", expectedType: "function" },
        { name: "truncateMessages", expectedType: "function" },
        { name: "sysMsg", expectedType: "function" },
        { name: "userMsg", expectedType: "function" },
        { name: "assistantMsg", expectedType: "function" },
        { name: "MODELS", expectedType: "object" },
      ],
    },
    {
      label: "graph/state",
      module: stateModule,
      requiredExports: [
        { name: "createInitialState", expectedType: "function" },
        { name: "mergeState", expectedType: "function" },
        { name: "postAgentMessage", expectedType: "function" },
        { name: "getMessagesFor", expectedType: "function" },
      ],
    },
    {
      label: "graph/router",
      module: routerModule,
      requiredExports: [
        { name: "routeSupervisor", expectedType: "function" },
        { name: "routeReviewer", expectedType: "function" },
        { name: "routeFromPlan", expectedType: "function" },
      ],
    },
    {
      label: "graph/builder",
      module: builderModule,
      requiredExports: [
        { name: "buildGraph", expectedType: "function" },
        { name: "AGENT_DISPLAY", expectedType: "object" },
      ],
    },
    {
      label: "utils/fileWriter",
      module: fileWriterModule,
      requiredExports: [
        { name: "parseFileBlocks", expectedType: "function" },
        { name: "writeFileBlocks", expectedType: "function" },
        { name: "applyCodeToWorkspace", expectedType: "function" },
      ],
    },
    {
      label: "utils/terminalRunner",
      module: terminalRunnerModule,
      requiredExports: [
        { name: "parseCommandBlocks", expectedType: "function" },
        { name: "runCommandsFromOutput", expectedType: "function" },
        { name: "runSingleCommand", expectedType: "function" },
      ],
    },
    {
      label: "utils/github",
      module: githubModule,
      requiredExports: [
        { name: "searchGitHubRepos", expectedType: "function" },
        { name: "formatRepoResults", expectedType: "function" },
        { name: "repoContextForLLM", expectedType: "function" },
      ],
    },
  ];

  const report = verifyModuleIntegrity(contracts);

  if (report.ok) {
    logger.info("integrity", `All ${contracts.length} module contracts verified (${report.passed.join(", ")})`);
  } else {
    logger.error("integrity", `Module integrity check FAILED — ${report.failures.length} issue(s):`);
    for (const f of report.failures) {
      logger.error("integrity", `  ${f.module}.${f.export}: expected ${f.expected}, got ${f.actual}`);
    }
  }

  return report;
}
