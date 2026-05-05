# 🤖 Multi-Agent Copilot

A **graph-based multi-agent system** that runs inside the VS Code Copilot chat panel. Specialised AI agents — orchestrated by a supervisor through a DAG state-machine — collaborate to plan, code, design, test, research, and review your work, all from a single `@team` command. Each agent operates like a **Meta engineer**: running build → lint → test → diff quality gates, self-reviewing their own changes, and only submitting code that passes a full CI pipeline.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.99.0-007ACC?logo=visualstudiocode)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)
![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Agents](https://img.shields.io/badge/Agents-9-blueviolet)
![Tests](https://img.shields.io/badge/Tests-683_passing-brightgreen)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **9 Specialist Agents** | Supervisor, Planner, Coder, Coder Pool (parallel), Integrator, Researcher, UI Designer, Test Generator, Reviewer |
| **Go Worker Parallelism** | Domain coders run as goroutines via a Go child process — true OS-level parallelism, not just `Promise.allSettled` |
| **Live Per-Coder Panels** | Each parallel domain coder gets its own webview panel with **streaming LLM output**, file-write events, and quality-gate results — watch every coder write code in real time |
| **Meta-Style Quality Gates** | Every agent runs `build → lint → tests → diff` before marking code complete — like `arc diff` |
| **Self-Review** | Coders review their own diffs (LLM checks for LGTM) before submitting — runs both for the lone Coder and per-domain in the pool, gated on 30–500 diff lines so tiny/huge diffs skip the LLM call |
| **Smart Reviewer Skip** | Standalone Reviewer is automatically skipped when self-review is LGTM, the quality gate is green, and the diff is under 50 lines — saves a duplicate LLM round-trip |
| **Parallel Domain Coders** | Large tasks fan out to 2–6 independent domain coders, each with their own quality gate (hard cap enforced) |
| **Full CI Pipeline** | The Integrator (staff engineer) merges all domains and runs `runFullQualityGate` on the whole project |
| **Scaffold Generation** | Planner produces a project scaffold (directory tree + boilerplate) before domain coders begin coding |
| **CI-Aware Code Review** | Reviewer sees build/lint/test status badges and reads the actual on-disk file contents (not just last_code) — CI failures are blocking issues |
| **Single-Model (GPT-4.1)** | All agents use GPT-4.1 via the Copilot LM API; falls back to any available Copilot model only if GPT-4.1 itself is unavailable |
| **Inter-Agent Communication** | Shared message bus — agents post context for each other |
| **GitHub Repo Search** | Researcher searches GitHub for professional reference repos matching your idea |
| **DAG Graph Orchestration** | State-machine executor with conditional routing, parallel fan-out, and plan-driven decomposition |
| **Plan-Driven Chaining** | Once a plan exists, agents chain directly between tagged steps without round-tripping the Supervisor LLM — cuts latency and token cost |
| **Request-Scoped File Cache** | `readFilesMatching` caches results within a single chat turn and invalidates on every workspace write — fewer redundant disk reads on revisions |
| **No Per-Agent Timeouts** | Agents run to completion — only a 30-minute wall-clock guard prevents infinite runs |
| **Retry + Fallback** | Each model call retries up to 3× with backoff before falling back to any available Copilot model |
| **Error Recovery** | If an agent crashes, the graph catches it, logs the run, and re-routes through the supervisor |
| **Security Hardening** | Input validation, prompt-injection guards, output sanitisation, integrity checks, regex secret-scan on every file write (AWS/GitHub/Stripe/JWT/PEM keys) |
| **Structured Logging** | Full Output Channel with per-agent timing, routing, and fallback events |
| **Rich Chat UI** | Agent headers, progress indicators, timing breakdowns, summary panels |
| **Slash Commands** | 6 direct commands for bypassing the supervisor |

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     VS Code Copilot Panel                      │
│                         @team <prompt>                         │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Supervisor  │  🧠 Routes & checks quality status
                    │   (GPT-4.1)  │
                    └──────┬───────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
     ┌──────────┐   ┌────────────┐   ┌──────────────┐
     │ Planner  │   │   Coder    │   │  Researcher  │ ...
     │   📋     │   │    💻      │   │     🔍       │
     └──────────┘   └─────┬──────┘   └──────────────┘
                          │
              ┌───────────┴───────────┐
              │   Plan decomposition  │
              │   + scaffold gen      │
              └───────────┬───────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │  Domain A  │  │  Domain B  │  │  Domain C  │  Go goroutines
   │  Coder 💻  │  │  Coder 💻  │  │  Coder 💻  │  (true parallel)
   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
         │               │               │
         ▼               ▼               ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Quality  │    │ Quality  │    │ Quality  │    Per-domain
   │  Gate 🔍 │    │  Gate 🔍 │    │  Gate 🔍 │    build+lint+test
   └─────┬────┘    └─────┬────┘    └─────┬────┘
         │               │               │
         └───────────────┼───────────────┘
                         ▼
        ┌──────────────────────────────────┐
        │   Live Webview Dashboard 📊       │
        │  ┌──────┐ ┌──────┐ ┌──────┐     │
        │  │ Dom A│ │ Dom B│ │ Dom C│     │
        │  │ logs │ │ logs │ │ logs │     │
        │  └──────┘ └──────┘ └──────┘     │
        └────────────────┬─────────────────┘
                         ▼
                  ┌─────────────┐
                  │ Integrator  │  🏗️ Staff engineer — merges all
                  │ (full CI)   │  domains + runs full quality gate
                  └──────┬──────┘
                         ▼
                  ┌─────────────┐
                  │  Reviewer   │  ✅ Sees CI status badges —
                  │ (CI-aware)  │  lint/test/build signals
                  └─────────────┘
```

### Go Worker Pipeline

Domain coders run through a 3-layer pipeline for true parallelism:

```
Go Worker (goroutines)  →  GoWorkerBridge (JSON-RPC)  →  AgentOutputManager (webview)
       ▲                          │                              │
 OS-level parallel         stdin/stdout IPC              postMessage to dashboard
 domain execution          protocol bridge               live DOM updates
```

When Go is unavailable the system falls back to Node.js `Promise.allSettled` with a concurrency semaphore.

### Agent Descriptions

| Agent | Model | Icon | Purpose |
|-------|-------|------|---------|
| **Supervisor** | GPT-4.1 | 🧠 | Reads quality summaries & conversation, routes to the right agent |
| **Planner** | GPT-4.1 | 📋 | Breaks complex tasks into numbered steps + scaffold + domain decomposition |
| **Coder** | GPT-4.1 | 💻 | Writes code → runs quality gate → self-reviews own diff → iterates until LGTM |
| **Coder Pool** | GPT-4.1 | 💻×N | Parallel domain coders (2–6, hard cap) via Go goroutines, independent QA per domain |
| **Integrator** | GPT-4.1 | 🏗️ | Staff engineer — merges all domains, runs full CI pipeline, fixes cross-domain breaks |
| **Researcher** | GPT-4.1 | 🔍 | Gathers information, explains concepts, **searches GitHub** for reference repos |
| **UI Designer** | GPT-4.1 | 🎨 | Designs components, layouts, styling, and accessibility |
| **Test Generator** | GPT-4.1 | 🧪 | Generates unit tests, integration tests, and test suites |
| **Reviewer** | GPT-4.1 | ✅ | CI-aware code review — sees build/lint/test status, blocks on CI failures |

### Inter-Agent Communication Flow

```
Planner ──── scaffold + domain plan ──▶ Coder Pool (fan-out)
Domain Coders ── code + QA ───────────▶ Integrator (merge)
Integrator ── merged code ────────────▶ Reviewer (with CI status)
Reviewer ── sends feedback ───────────▶ Coder / Integrator (revision loop)
Researcher ── sends findings ─────────▶ all agents
UI Designer ── sends specs ───────────▶ Coder + Test Generator
```

### Quality Gate Pipeline (per agent)

```
┌─────────┐   ┌──────┐   ┌───────┐   ┌──────┐   ┌─────────────┐
│  Build  │──▶│ Lint │──▶│ Tests │──▶│ Diff │──▶│ Self-Review │
│  (tsc)  │   │(esli-│   │(jest) │   │(git) │   │ (LLM LGTM)  │
│         │   │ nt)  │   │       │   │      │   │             │
└─────────┘   └──────┘   └───────┘   └──────┘   └─────────────┘
     │            │           │          │              │
     ▼            ▼           ▼          ▼              ▼
  TS2304?    no-unused    FAIL ✗    +/- lines     "Fix X,Y,Z"
  Fix type   -vars?      Fix test   context       Iterate...
  errors     Fix lint     logic     for review     until LGTM
```

---

## 📁 Project Structure

```
MultiAgentCopilt/
├── src/
│   ├── extension.ts              # Entry point — registers @team chat participant
│   ├── agents/
│   │   ├── base.ts               # Model selection, fallback chain, retry, budget
│   │   ├── supervisor.ts         # Routes requests, reads quality summaries
│   │   ├── planner.ts            # Task decomposition + scaffold generation
│   │   ├── coder.ts              # Code gen → quality gate → self-review loop
│   │   ├── coderPool.ts          # Go-powered parallel domain coders (MAX_DOMAINS=6)
│   │   ├── integrator.ts         # Staff engineer — merge + full CI pipeline
│   │   ├── researcher.ts         # Research + GitHub repo search
│   │   ├── ui_designer.ts        # UI/UX design (GPT-4.1)
│   │   ├── tester.ts             # Test generation
│   │   └── reviewer.ts           # CI-aware code review with APPROVE/REVISE
│   ├── go-worker/                # Go child process for true parallelism
│   │   ├── main.go               # Entry point — stdin/stdout JSON-RPC server
│   │   ├── worker.go             # Goroutine-per-domain executor
│   │   ├── protocol.go           # Request/response message types
│   │   └── go.mod                # Go 1.22 module definition
│   ├── graph/
│   │   ├── state.ts              # AgentState, inter-agent messaging, merge logic
│   │   ├── builder.ts            # DAG executor — no per-agent timeouts, 30min wall-clock
│   │   └── router.ts             # Conditional edge routing + plan-driven routing
│   ├── security/
│   │   └── securityConfig.ts     # Security thresholds, prompt-injection guards
│   ├── types/
│   │   ├── index.ts              # Shared type definitions
│   │   └── security.ts           # Security-related types
│   └── utils/
│       ├── agentOutputManager.ts # Per-agent channels + live webview dashboard
│       ├── qualityGate.ts        # Build+lint+test+diff CI pipeline
│       ├── buildValidator.ts     # TypeScript build validation & diagnostics
│       ├── diffViewer.ts         # Side-by-side diff rendering
│       ├── fileWriter.ts         # Safe file writing — workspace resolution + secret-scan
│       ├── secretScan.ts         # Regex secret detection (blocks writes that contain credentials)
│       ├── goWorkerBridge.ts     # JSON-RPC bridge to Go child process
│       ├── terminalRunner.ts     # Terminal command execution
│       ├── logger.ts             # Structured Output Channel logger
│       ├── github.ts             # GitHub Search API integration
│       ├── security.ts           # Input sanitisation & output validation
│       ├── selfProtection.ts     # Self-modification guards
│       ├── integrity.ts          # State integrity checks
│       └── workspace.ts          # Workspace utilities
├── src/__tests__/                # 36 test suites, 683 tests
│   ├── agents/                   # Agent behaviour tests inc. quality gates
│   ├── graph/                    # Graph builder, router, state tests
│   ├── integration/              # File writer & terminal runner integration
│   └── utils/                    # Quality gate, build validator, security tests
├── reinstall.sh                  # Quick package + install shell shortcut
├── package.json                  # Extension manifest with chat participant config
├── tsconfig.json
└── jest.config.js
```

---

## 🚀 Getting Started

### Prerequisites

- **VS Code** ≥ 1.99.0
- **GitHub Copilot Chat** extension installed and signed in
- **Node.js** ≥ 18
- **Go** ≥ 1.22 *(optional — falls back to JS parallelism if missing)*
- A **GitHub Copilot subscription** (provides access to GPT-4.1)

### Install from Source

```bash
# Clone the repo
git clone https://github.com/VincentPit/MultiAgents4Copilot.git
cd MultiAgents4Copilot

# Install dependencies & compile
npm install
npm run compile

# Build Go worker (optional — requires Go 1.22+)
npm run go:build

# Package as VSIX
npx @vscode/vsce package --no-dependencies --allow-missing-repository --allow-package-secrets github

# Install in VS Code
code --install-extension multi-agent-copilot-0.7.0.vsix --force
```

Then reload VS Code: **⌘+Shift+P** → **Developer: Reload Window**

### Quick Reinstall

After making changes, use the included script:

```bash
./reinstall.sh
```

This compiles, packages, and installs in one step.

### Development (F5 Debug)

1. Open the project in VS Code
2. Press **F5** to launch the Extension Development Host
3. In the new window, open Copilot Chat and type `@team hello`

---

## 💬 Usage

### Full Orchestration

Type in the Copilot chat panel — the supervisor will route through agents automatically:

```
@team build a REST API for a todo app with authentication
@team create a React dashboard with dark mode and charts
@team refactor this function to be more testable
```

For large builds the system will:
1. **Plan** — decompose into 2–6 domains with scaffold
2. **Fan out** — spawn parallel domain coders (Go goroutines)
3. **Dashboard** — open a live webview with per-domain log cards
4. **Quality gate** — each domain runs build → lint → test → self-review
5. **Integrate** — staff engineer merges all domains + full CI
6. **Review** — CI-aware code review with status badges

### Slash Commands (Direct Mode)

Bypass the supervisor and talk directly to a specific agent:

| Command | Agent | Example |
|---------|-------|---------|
| `/plan` | 📋 Planner | `@team /plan migrate our auth to OAuth2` |
| `/code` | 💻 Coder | `@team /code fibonacci function in Rust` |
| `/build` | 💻×N Coder Pool | `@team /build a full-stack e-commerce app` |
| `/review` | ✅ Reviewer | `@team /review <paste code>` |
| `/design` | 🎨 UI Designer | `@team /design a settings page with tabs` |
| `/test` | 🧪 Test Generator | `@team /test write tests for this auth module` |

### GitHub Repo Search

The Researcher agent automatically searches GitHub when your request involves building something:

```
@team /research I want to build a real-time collaborative whiteboard
```

This will:
1. Extract search queries from your prompt
2. Search GitHub for top repos by stars
3. Render a table of professional reference repos
4. Analyse architecture patterns, tech stacks, and what you can learn from them

---

## 📊 Live Per-Coder Panels

When parallel domain coders are active, the extension opens an **overview panel** plus an **individual webview panel for each coder**, distributed across editor columns. Every panel shows what its coder is doing in real time:

```
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
│ 🏗️ backend-api       │ │ 🏗️ frontend-ui       │ │ 🏗️ database-layer    │
│ ● coding · 12.3s     │ │ ● writing · 9.1s     │ │ ● testing · 17.8s    │
│ ▓▓▓▓▓▓░░░░ 40%       │ │ ▓▓▓▓▓▓▓▓░░ 65%       │ │ ▓▓▓▓▓▓▓▓▓░ 85%       │
├──────────────────────┤ ├──────────────────────┤ ├──────────────────────┤
│ 📂 Files (2)         │ │ 📂 Files (3)         │ │ 📂 Files (1)         │
│  📄 src/routes.ts    │ │  📄 src/App.tsx      │ │  📄 src/db/client.ts │
│  📄 src/auth.ts      │ │  📄 src/Dashboard.tsx│ │                      │
│                      │ │  📄 src/styles.css   │ │ ✅ Test Results      │
├──────────────────────┤ ├──────────────────────┤ │  All tests passed    │
│ 📋 Output            │ │ 📋 Output            │ ├──────────────────────┤
│ 🤖 Calling GPT-4.1…  │ │ 🤖 Calling GPT-4.1…  │ │ 📋 Output            │
│ export async function│ │ const App = () =>    │ │ 🧪 Quality gate run… │
│   listUsers(req,…    │ │   <Layout>…          │ │ ✅ Build: pass       │
│ 📁 Writing routes.ts │ │ 📁 Writing App.tsx   │ │ ✅ Lint: pass        │
│ ✅ Saved routes.ts   │ │ ✅ Saved App.tsx     │ │ ✅ Tests: 8/8        │
└──────────────────────┘ └──────────────────────┘ └──────────────────────┘
```

Each panel surfaces:
- **Status + progress bar** — queued → coding → writing → testing → done / error.
- **Live LLM token stream** — the model's output is piped line-by-line into the panel as it generates, so you can read the code being written in real time.
- **File-write events** — `📁 Writing <path>` and `✅ Saved <path>` per file as each one lands on disk.
- **Quality-gate verdict** — pass/fail summary + lint/test counts as soon as the gate finishes.
- **Errors and warnings** — `❌` and `⚠️` markers for failed writes, model errors, or quality-gate failures.

The overview panel ties them together with aggregate counts (`done/total`, `files written`) and refreshes every 2 seconds. Updates are pushed via incremental `postMessage` calls so the DOM stays smooth even with 6 panels open simultaneously.

---

## ⚙️ Model Configuration

The extension uses the `vscode.lm` API — **no API keys needed**. Models are accessed through your Copilot subscription.

| Model | Used By | Fallback |
|-------|---------|----------|
| GPT-4.1 | All agents (Supervisor, Planner, Coder, Coder Pool, Integrator, Researcher, Reviewer, UI Designer, Test Generator) | → any available Copilot model |

### Fallback Chain

If GPT-4.1 is unavailable or fails:

1. **Retry** GPT-4.1 (up to 2 attempts with backoff)
2. **Last resort** — use any available Copilot model

---

## 📋 Logging

Open the Output panel (**⌘+Shift+U**) and select **"Multi-Agent Copilot"** from the dropdown to see structured logs:

```
[12:34:56] [INFO]  [extension] Multi-Agent Copilot activated
[12:34:58] [INFO]  [model] Selected GPT-4.1
[12:34:58] [START] [supervisor]
[12:34:59] [END]   [supervisor] 1.2s
[12:34:59] [ROUTE] supervisor → planner
[12:34:59] [START] [planner]
[12:35:03] [END]   [planner] 4.1s
[12:35:03] [MSG]   coder → * : Code posted to message bus
[12:35:10] [FALLBACK] coder: gpt-4.1 unavailable → any copilot model
```

---

## 🔄 Upgrade Workflow

After making changes to the source:

```bash
# Option 1 — one-liner
./reinstall.sh

# Option 2 — manual
npm run compile && \
npm run go:build && \
npx @vscode/vsce package --no-dependencies --allow-missing-repository --allow-package-secrets github && \
code --install-extension multi-agent-copilot-0.7.0.vsix --force
```

Then: **⌘+Shift+P** → **Developer: Reload Window**

### Cross-Platform Go Builds

```bash
npm run go:build:all   # builds darwin-arm64, darwin-amd64, linux-amd64, windows-amd64
```

---

## 🛠️ Technical Details

### Graph Execution

The graph is a lightweight state-machine (no LangGraph dependency):

- **Nodes** are async functions: `(state, model, stream, token) → Partial<AgentState>`
- **Edges** are determined by router functions (`routeSupervisor`, `routeReviewer`)
- **Max 15 steps** to prevent infinite loops
- **30-minute wall-clock** — no per-agent timeouts (agents run to completion)
- Each node is timed and wrapped in try/catch for error recovery
- Errored agents are still recorded in the summary (not silently dropped)

### State

```typescript
interface AgentState {
  messages: AgentMessage[];       // Conversation history
  nextAgent: string;              // Supervisor's routing decision
  plan: string[];                 // Planner's output
  artifacts: Record<string, string>; // Shared scratch-pad (see keys below)
  reviewCount: number;            // Review iteration counter
  reviewVerdict: ReviewVerdict;   // "approve" | "revise" | "pending"
  agentComms: InterAgentMessage[]; // Inter-agent message bus
  errors: string[];               // Error log
  status: "in_progress" | "completed" | "error";
  finalAnswer: string;
}

// Key artifact keys set by agents:
// build_status      — "success" | "failed (N errors)"
// quality_summary   — "Build: ✅ | Lint: ✅ | Tests: ✅ (42/42)"
// quality_errors    — formatted diagnostic report for LLM consumption
// test_results      — "10 passed, 0 failed"
// lint_results      — "0 errors, 0 warnings"
```

### Domain Decomposition

The Planner's domain plan is capped at **MAX_DOMAINS = 6**:

1. The LLM prompt instructs "BETWEEN 2 AND 6 independent domains" (hard limit)
2. `parseDomainAssignments()` clamps results with `slice(0, MAX_DOMAINS)`
3. If the LLM returns more, a warning is logged and excess domains are dropped

### Review Loop

The Reviewer can send code back to the Coder for revision. CI status is visible throughout:

```
Coder → Quality Gate → Self-Review → Integrator → Full CI → Reviewer
  ↑                                                           │
  └───────────── (REVISE — fix CI failures) ──────────────────┘
```

Max 3 review cycles — auto-approves at the limit.

---

## 🏭 Meta Engineering Workflow

The agents mirror what a team of real Meta engineers would do:

| Step | Real Engineer | Agent Equivalent |
|------|--------------|------------------|
| 1. Plan | Tech lead breaks project into domains | **Planner** decomposes into domain tasks + generates scaffold |
| 2. Branch | Each IC takes a domain branch | **Coder Pool** fans out to parallel domain coders (Go goroutines) |
| 3. Dashboard | Engineers watch CI dashboards | **Webview Dashboard** shows live per-domain progress |
| 4. Code | Write code in isolation | Each domain coder generates code independently |
| 5. `arc lint` | Run automated lint checks | **Quality Gate** runs ESLint/Biome on written files |
| 6. `arc unit` | Run related unit tests | **Quality Gate** runs `jest --findRelatedTests` |
| 7. `arc diff` | Submit diff for review | **Self-Review** — LLM reviews own diff, iterates until LGTM |
| 8. Merge | Staff engineer merges all branches | **Integrator** merges domains + runs full CI |
| 9. CI | Full CI pipeline on merged code | `runFullQualityGate` — build + lint + all tests |
| 10. Review | Senior engineer reviews with CI context | **Reviewer** sees CI status badges, blocks on failures |
| 11. Land | Approve and land the diff | **Supervisor** checks `quality_summary`, marks complete |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📄 License

MIT © [VincentPit](https://github.com/VincentPit)
