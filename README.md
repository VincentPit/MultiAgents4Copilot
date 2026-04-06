# 🤖 Multi-Agent Copilot

A **graph-based multi-agent system** that runs inside the VS Code Copilot chat panel. Specialised AI agents — orchestrated by a supervisor through a DAG state-machine — collaborate to plan, code, design, test, research, and review your work, all from a single `@team` command. Each agent operates like a **Meta engineer**: running build → lint → test → diff quality gates, self-reviewing their own changes, and only submitting code that passes a full CI pipeline.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.99.0-007ACC?logo=visualstudiocode)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Agents](https://img.shields.io/badge/Agents-9-blueviolet)
![Tests](https://img.shields.io/badge/Tests-401_passing-brightgreen)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **9 Specialist Agents** | Supervisor, Planner, Coder, Coder Pool (parallel), Integrator, Researcher, UI Designer, Test Generator, Reviewer |
| **Meta-Style Quality Gates** | Every agent runs `build → lint → tests → diff` before marking code complete — like `arc diff` |
| **Self-Review** | Coders review their own diffs (LLM checks for LGTM) before submitting — catches mistakes before review |
| **Parallel Domain Coders** | Large tasks fan out to independent domain coders that work simultaneously, each with their own quality gate |
| **Full CI Pipeline** | The Integrator (staff engineer) merges all domains and runs `runFullQualityGate` on the whole project |
| **CI-Aware Code Review** | Reviewer sees build/lint/test status badges — CI failures are blocking issues |
| **Multi-Model** | Claude Opus 4.6 (default) + Gemini 3 Pro (UI design) with automatic fallback |
| **Inter-Agent Communication** | Shared message bus — agents post context for each other |
| **GitHub Repo Search** | Researcher searches GitHub for professional reference repos matching your idea |
| **DAG Graph Orchestration** | State-machine executor with conditional routing, parallel fan-out, and plan-driven decomposition |
| **Retry + Fallback** | Each model call retries 2× then falls back through the model chain |
| **Error Recovery** | If an agent crashes, the graph catches it and re-routes through the supervisor |
| **Security Hardening** | Input validation, prompt-injection guards, output sanitisation, integrity checks |
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
                    │ (Claude Opus)│
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
              │  (multi-domain tasks) │
              └───────────┬───────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │  Domain A  │  │  Domain B  │  │  Domain C  │  Parallel coders
   │  Coder 💻  │  │  Coder 💻  │  │  Coder 💻  │  (independent)
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

### Agent Descriptions

| Agent | Model | Icon | Purpose |
|-------|-------|------|---------|
| **Supervisor** | Claude Opus 4.6 | 🧠 | Reads quality summaries & conversation, routes to the right agent |
| **Planner** | Claude Opus 4.6 | 📋 | Breaks complex tasks into numbered, actionable steps with domain decomposition |
| **Coder** | Claude Opus 4.6 | 💻 | Writes code → runs quality gate → self-reviews own diff → iterates until LGTM |
| **Coder Pool** | Claude Opus 4.6 | 💻×N | Parallel domain coders — each owns a domain, runs independent quality gates |
| **Integrator** | Claude Opus 4.6 | 🏗️ | Staff engineer — merges all domains, runs full CI pipeline, fixes cross-domain breaks |
| **Researcher** | Claude Opus 4.6 | 🔍 | Gathers information, explains concepts, **searches GitHub** for reference repos |
| **UI Designer** | Gemini 3 Pro | 🎨 | Designs components, layouts, styling, and accessibility |
| **Test Generator** | Claude Opus 4.6 | 🧪 | Generates unit tests, integration tests, and test suites |
| **Reviewer** | Claude Opus 4.6 | ✅ | CI-aware code review — sees build/lint/test status, blocks on CI failures |

### Inter-Agent Communication Flow

```
Planner ──── domain plan ──────▶ Coder Pool (fan-out)
Domain Coders ── code + QA ────▶ Integrator (merge)
Integrator ── merged code ─────▶ Reviewer (with CI status)
Reviewer ── sends feedback ────▶ Coder / Integrator (revision loop)
Researcher ── sends findings ──▶ all agents
UI Designer ── sends specs ────▶ Coder + Test Generator
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
│   │   ├── planner.ts            # Task decomposition with domain planning
│   │   ├── coder.ts              # Code gen → quality gate → self-review loop
│   │   ├── coderPool.ts          # Parallel domain coders with independent QA
│   │   ├── integrator.ts         # Staff engineer — merge + full CI pipeline
│   │   ├── researcher.ts         # Research + GitHub repo search
│   │   ├── ui_designer.ts        # UI/UX design (Gemini 3 Pro)
│   │   ├── tester.ts             # Test generation
│   │   └── reviewer.ts           # CI-aware code review with APPROVE/REVISE
│   ├── graph/
│   │   ├── state.ts              # AgentState, inter-agent messaging, merge logic
│   │   ├── builder.ts            # DAG executor with parallel fan-out & timing
│   │   └── router.ts             # Conditional edge routing + plan-driven routing
│   ├── security/
│   │   └── securityConfig.ts     # Security thresholds, prompt-injection guards
│   ├── types/
│   │   ├── index.ts              # Shared type definitions
│   │   └── security.ts           # Security-related types
│   └── utils/
│       ├── qualityGate.ts        # 🆕 Build+lint+test+diff CI pipeline
│       ├── buildValidator.ts     # TypeScript build validation & diagnostics
│       ├── fileWriter.ts         # Safe file writing with workspace resolution
│       ├── terminalRunner.ts     # Terminal command execution
│       ├── logger.ts             # Structured Output Channel logger
│       ├── github.ts             # GitHub Search API integration
│       ├── security.ts           # Input sanitisation & output validation
│       ├── selfProtection.ts     # Self-modification guards
│       ├── integrity.ts          # State integrity checks
│       └── workspace.ts          # Workspace utilities
├── src/__tests__/                # 21 test suites, 401 tests
│   ├── agents/                   # Agent behaviour tests inc. quality gates
│   ├── graph/                    # Graph builder, router, state tests
│   ├── integration/              # File writer & terminal runner integration
│   └── utils/                    # Quality gate, build validator, security tests
├── package.json                  # Extension manifest with chat participant config
├── tsconfig.json
└── jest.config.js
```

---

## 🚀 Getting Started

### Prerequisites

- **VS Code** ≥ 1.93.0
- **GitHub Copilot Chat** extension installed and signed in
- **Node.js** ≥ 18
- A **GitHub Copilot subscription** (provides access to Claude Opus 4.6 and Gemini 3 Pro)

### Install from VSIX

```bash
# Clone the repo
git clone https://github.com/VincentPit/MultiAgents4Copilot.git
cd MultiAgents4Copilot

# Install dependencies & compile
npm install
npm run compile

# Package as VSIX
npx @vscode/vsce package --allow-missing-repository -o multi-agent-copilot.vsix

# Install in VS Code
code --install-extension multi-agent-copilot.vsix --force
```

Then reload VS Code: **⌘+Shift+P** → **Developer: Reload Window**

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

### Slash Commands (Direct Mode)

Bypass the supervisor and talk directly to a specific agent:

| Command | Agent | Example |
|---------|-------|---------|
| `/plan` | 📋 Planner | `@team /plan migrate our auth to OAuth2` |
| `/code` | 💻 Coder | `@team /code fibonacci function in Rust` |
| `/research` | 🔍 Researcher | `@team /research best real-time database for collaborative apps` |
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

## ⚙️ Model Configuration

The extension uses the `vscode.lm` API — **no API keys needed**. Models are accessed through your Copilot subscription.

| Model | Used By | Fallback |
|-------|---------|----------|
| Claude Opus 4.6 | Supervisor, Planner, Coder, Researcher, Reviewer, Test Generator | → Gemini 3 Pro → any Copilot model |
| Gemini 3 Pro | UI Designer | → Claude Opus 4.6 → any Copilot model |

### Fallback Chain

If a model is unavailable or fails:

1. **Retry** the same model (up to 2 attempts with backoff)
2. **Fall back** to the next model in the chain
3. **Last resort** — use any available Copilot model

---

## 📊 Logging

Open the Output panel (**⌘+Shift+U**) and select **"Multi-Agent Copilot"** from the dropdown to see structured logs:

```
[12:34:56] [INFO]  [extension] Multi-Agent Copilot activated
[12:34:58] [INFO]  [model] Selected Claude Opus 4.6
[12:34:58] [START] [supervisor]
[12:34:59] [END]   [supervisor] 1.2s
[12:34:59] [ROUTE] supervisor → planner
[12:34:59] [START] [planner]
[12:35:03] [END]   [planner] 4.1s
[12:35:03] [MSG]   coder → * : Code posted to message bus
[12:35:10] [FALLBACK] ui_designer: gemini-3-pro unavailable → Claude Opus 4.6
```

---

## 🔄 Upgrade Workflow

After making changes to the source:

```bash
npm run compile && \
npx @vscode/vsce package --allow-missing-repository -o multi-agent-copilot.vsix && \
code --install-extension multi-agent-copilot.vsix --force
```

Then: **⌘+Shift+P** → **Developer: Reload Window**

---

## 🛠️ Technical Details

### Graph Execution

The graph is a lightweight state-machine (no LangGraph dependency):

- **Nodes** are async functions: `(state, model, stream, token) → Partial<AgentState>`
- **Edges** are determined by router functions (`routeSupervisor`, `routeReviewer`)
- **Max 15 steps** to prevent infinite loops
- Each node is timed and wrapped in try/catch for error recovery

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
| 1. Plan | Tech lead breaks project into domains | **Planner** decomposes into domain tasks |
| 2. Branch | Each IC takes a domain branch | **Coder Pool** fans out to parallel domain coders |
| 3. Code | Write code in isolation | Each domain coder generates code independently |
| 4. `arc lint` | Run automated lint checks | **Quality Gate** runs ESLint/Biome on written files |
| 5. `arc unit` | Run related unit tests | **Quality Gate** runs `jest --findRelatedTests` |
| 6. `arc diff` | Submit diff for review | **Self-Review** — LLM reviews own diff, iterates until LGTM |
| 7. Merge | Staff engineer merges all branches | **Integrator** merges domains + runs full CI |
| 8. CI | Full CI pipeline on merged code | `runFullQualityGate` — build + lint + all tests |
| 9. Review | Senior engineer reviews with CI context | **Reviewer** sees CI status badges, blocks on failures |
| 10. Land | Approve and land the diff | **Supervisor** checks `quality_summary`, marks complete |

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
