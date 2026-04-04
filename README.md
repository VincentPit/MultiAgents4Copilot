# 🤖 Multi-Agent Copilot

A **graph-based multi-agent system** that runs inside the VS Code Copilot chat panel. Seven specialised AI agents — orchestrated by a supervisor through a lightweight state-machine — collaborate to plan, code, design, test, research, and review your work, all from a single `@team` command.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.93.0-007ACC?logo=visualstudiocode)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Agents](https://img.shields.io/badge/Agents-7-blueviolet)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **7 Specialist Agents** | Supervisor, Planner, Coder, Researcher, UI Designer, Test Generator, Reviewer |
| **Multi-Model** | Claude Opus 4.6 (default) + Gemini 3 Pro (UI design) with automatic fallback |
| **Inter-Agent Communication** | Shared message bus — agents post context for each other |
| **GitHub Repo Search** | Researcher searches GitHub for professional reference repos matching your idea |
| **Graph Orchestration** | Lightweight state-machine executor with conditional routing |
| **Retry + Fallback** | Each model call retries 2× then falls back through the model chain |
| **Error Recovery** | If an agent crashes, the graph catches it and re-routes through the supervisor |
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
                    │  Supervisor  │  🧠 Routes to the right agent
                    │ (Claude Opus)│
                    └──────┬───────┘
                           │
          ┌────────┬───────┼────────┬───────────┬──────────┐
          ▼        ▼       ▼        ▼           ▼          ▼
     ┌─────────┐ ┌──────┐ ┌──────┐ ┌──────────┐ ┌───────┐ ┌────────┐
     │ Planner │ │Coder │ │Resea-│ │UI Design-│ │ Test  │ │Revie-  │
     │   📋    │ │  💻  │ │rcher │ │er  🎨    │ │ Gen   │ │wer ✅  │
     │         │ │      │ │  🔍  │ │(Gemini   │ │ 🧪    │ │        │
     │         │ │      │ │      │ │ 3 Pro)   │ │       │ │        │
     └─────────┘ └──────┘ └──────┘ └──────────┘ └───────┘ └────────┘
          │          │        │          │           │          │
          └──────────┴────────┴──────────┴───────────┴──────────┘
                              │
                    ┌─────────▼──────────┐
                    │  Inter-Agent Bus   │  Messages, code, specs,
                    │  (Shared State)    │  test suites, feedback
                    └────────────────────┘
```

### Agent Descriptions

| Agent | Model | Icon | Purpose |
|-------|-------|------|---------|
| **Supervisor** | Claude Opus 4.6 | 🧠 | Reads the conversation and decides which agent should act next |
| **Planner** | Claude Opus 4.6 | 📋 | Breaks complex tasks into numbered, actionable steps |
| **Coder** | Claude Opus 4.6 | 💻 | Writes, edits, and generates production code |
| **Researcher** | Claude Opus 4.6 | 🔍 | Gathers information, explains concepts, **searches GitHub** for reference repos |
| **UI Designer** | Gemini 3 Pro | 🎨 | Designs components, layouts, styling, and accessibility |
| **Test Generator** | Claude Opus 4.6 | 🧪 | Generates unit tests, integration tests, and test suites |
| **Reviewer** | Claude Opus 4.6 | ✅ | Reviews code for correctness, quality — can send revisions back to Coder |

### Inter-Agent Communication Flow

```
Coder ──── broadcasts code ────▶ all agents
UI Designer ── sends specs ────▶ Coder + Test Generator
Test Generator ── sends tests ─▶ Reviewer + Coder
Reviewer ── sends feedback ────▶ Coder (triggers revision loop)
Researcher ── sends findings ──▶ all agents
```

---

## 📁 Project Structure

```
MultiAgentCopilt/
├── src/
│   ├── extension.ts            # Entry point — registers @team chat participant
│   ├── agents/
│   │   ├── base.ts             # Model selection, fallback chain, retry logic
│   │   ├── supervisor.ts       # Routes requests to specialist agents
│   │   ├── planner.ts          # Task decomposition
│   │   ├── coder.ts            # Code generation with revision support
│   │   ├── researcher.ts       # Research + GitHub repo search
│   │   ├── ui_designer.ts      # UI/UX design (Gemini 3 Pro)
│   │   ├── tester.ts           # Test generation
│   │   └── reviewer.ts         # Code review with APPROVE/REVISE cycles
│   ├── graph/
│   │   ├── state.ts            # AgentState, inter-agent messaging, merge logic
│   │   ├── builder.ts          # Graph executor with timing & error recovery
│   │   └── router.ts           # Conditional edge routing
│   └── utils/
│       ├── logger.ts           # Structured Output Channel logger
│       └── github.ts           # GitHub Search API integration
├── package.json                # Extension manifest with chat participant config
├── tsconfig.json
└── .vscodeignore
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
  artifacts: Record<string, string>; // Shared scratch-pad
  reviewCount: number;            // Review iteration counter
  reviewVerdict: ReviewVerdict;   // "approve" | "revise" | "pending"
  agentComms: InterAgentMessage[]; // Inter-agent message bus
  errors: string[];               // Error log
  status: "in_progress" | "completed" | "error";
  finalAnswer: string;
}
```

### Review Loop

The Reviewer can send code back to the Coder for revision:

```
Coder → Reviewer → (REVISE) → Coder → Reviewer → (APPROVE) → FINISH
```

Max 3 review cycles — auto-approves at the limit.

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
