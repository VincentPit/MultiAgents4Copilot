# Domain Ownership

All 5 domain branches are created from commit `c788141` on `main`.

Each coder owns a slice of the codebase. **Only modify files in your domain.** If you need a change in another domain, coordinate with that coder.

| Branch | Coder | Owns |
|--------|-------|------|
| `domain/alice-foundation-security` | **Alice** | `src/types/`, `src/security/`, `src/utils/logger.ts`, `src/utils/security.ts`, `src/utils/selfProtection.ts`, `src/utils/integrity.ts` |
| `domain/bob-graph-engine` | **Bob** | `src/graph/state.ts`, `src/graph/router.ts`, `src/graph/builder.ts` |
| `domain/carol-agent-framework` | **Carol** | `src/agents/base.ts`, `src/agents/supervisor.ts`, `src/agents/planner.ts`, `src/agents/reviewer.ts`, `src/agents/ui_designer.ts` |
| `domain/dave-code-pipeline` | **Dave** | `src/utils/fileWriter.ts`, `src/utils/fileReader.ts`, `src/utils/diffViewer.ts`, `src/utils/buildValidator.ts`, `src/utils/qualityGate.ts`, `src/utils/terminalRunner.ts`, `src/utils/workspace.ts`, `src/utils/github.ts` |
| `domain/eve-parallel-execution` | **Eve** | `src/agents/coder.ts`, `src/agents/coderPool.ts`, `src/agents/integrator.ts`, `src/agents/tester.ts`, `src/utils/goWorkerBridge.ts`, `src/utils/multiCoderView.ts`, `src/utils/agentOutputManager.ts`, `src/go-worker/*`, `src/extension.ts`, config files (`package.json`, `tsconfig.json`, `jest.config.js`) |

## Rules

1. **Stay in your lane.** Only edit files listed under your domain.
2. **Tests live next to code.** If you modify `src/utils/foo.ts`, update `src/__tests__/utils/foo.test.ts` too.
3. **All 477 tests must pass** before committing (`npx tsc --noEmit && npx jest --forceExit`).
4. **Shared types** (`src/types/`) are Alice's domain. If you need a new type export, ask Alice.
5. **No cross-domain imports of internal helpers.** Use the public API exported from each module.

## Merge Order

After all branches are done, merge in this order (fewest cross-domain deps first):

1. `domain/alice-foundation-security` — types & security (no deps on other domains)
2. `domain/bob-graph-engine` — graph engine (depends on types)
3. `domain/carol-agent-framework` — agent framework (depends on types, graph)
4. `domain/dave-code-pipeline` — pipeline utilities (depends on types, security)
5. `domain/eve-parallel-execution` — orchestration (depends on all of the above)
