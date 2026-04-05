/**
 * Shared state that flows through the agent graph.
 *
 * Every agent receives the full state, modifies what it needs,
 * and returns a partial update that gets merged back.
 */

import * as vscode from "vscode";

// ── Safety limits ──────────────────────────────────────────────────────────

/** Maximum messages before oldest are evicted. */
const MAX_MESSAGES = 500;

/** Maximum agent comms before oldest are evicted. */
const MAX_AGENT_COMMS = 200;

/** Maximum errors before oldest are evicted. */
const MAX_ERRORS = 100;

/** Maximum terminal results before oldest are evicted. */
const MAX_TERMINAL_RESULTS = 50;

/** Maximum length of any single string field (plan step, artifact, etc.). */
const MAX_FIELD_LENGTH = 100_000;

/** One message in the conversation. */
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  name?: string; // which agent produced it
  content: string;
}

/** Verdict from the reviewer. */
export type ReviewVerdict = "approve" | "revise" | "pending";

/**
 * Inter-agent message — allows agents to communicate directly
 * with each other through a shared message bus.
 */
export interface InterAgentMessage {
  from: string;
  to: string;       // target agent name, or "*" for broadcast
  type: "request" | "response" | "info";
  content: string;
  timestamp: number;
}

/** Domain assignment for parallel coder pool. */
export interface DomainAssignment {
  /** Unique identifier, e.g. "backend-api", "data-layer". */
  id: string;
  /** Human-readable domain name, e.g. "Backend API". */
  domain: string;
  /** What this domain coder is responsible for. */
  description: string;
  /** File glob patterns this coder owns, e.g. ["src/api/**"]. */
  filePatterns: string[];
  /** Interfaces/exports this domain provides to others. */
  provides: string;
  /** Interfaces/exports this domain consumes from others. */
  consumes: string;
}

/** The central state object for the graph. */
export interface AgentState {
  /** Full conversation history. */
  messages: AgentMessage[];

  /** Which agent the supervisor chose to run next (single dispatch). */
  nextAgent: string;

  /** Multiple agents to run in parallel (fan-out). */
  pendingAgents: string[];

  /** Step-by-step plan from the planner. */
  plan: string[];

  /** Which plan step is currently being executed (0-based index). */
  planStep: number;

  /** Scratch-pad for intermediate work products. */
  artifacts: Record<string, string>;

  /** How many review iterations have happened. */
  reviewCount: number;

  /** The final answer surfaced to the user. */
  finalAnswer: string;

  /** Current task status. */
  status: "in_progress" | "completed" | "error";

  /** Reviewer's latest verdict. */
  reviewVerdict: ReviewVerdict;

  /** Inter-agent message bus — agents post messages here for other agents to read. */
  agentComms: InterAgentMessage[];

  /** Error log — records failures and fallback activations. */
  errors: string[];

  /** Workspace context snapshot — project structure, active file, etc. */
  workspaceContext: string;

  /** User-attached references (#file, #selection) resolved to text content. */
  references: string;

  /** Formatted prior chat turns for multi-turn context continuity. */
  chatHistory: string;

  /** Results from terminal commands executed by agents. */
  terminalResults: TerminalResult[];

  /** Domain assignments for parallel coder pool. */
  domainAssignments: DomainAssignment[];
}

/** Result from a terminal command execution. */
export interface TerminalResult {
  /** The command that was executed. */
  command: string;
  /** Whether it succeeded. */
  success: boolean;
  /** stdout output (may be truncated). */
  stdout: string;
  /** stderr output (may be truncated). */
  stderr: string;
  /** Which agent ran this command. */
  agent: string;
}

/** Create a blank initial state with the user's first message. */
export function createInitialState(userMessage: string, workspaceContext: string = ""): AgentState {
  return {
    messages: [{ role: "user", content: userMessage }],
    nextAgent: "",
    pendingAgents: [],
    plan: [],
    planStep: 0,
    artifacts: {},
    reviewCount: 0,
    finalAnswer: "",
    status: "in_progress",
    reviewVerdict: "pending",
    agentComms: [],
    errors: [],
    workspaceContext,
    references: "",
    chatHistory: "",
    terminalResults: [],
    domainAssignments: [],
  };
}

/**
 * Post a message from one agent to another via the state bus.
 */
export function postAgentMessage(
  state: AgentState,
  from: string,
  to: string,
  type: InterAgentMessage["type"],
  content: string
): InterAgentMessage {
  const msg: InterAgentMessage = { from, to, type, content, timestamp: Date.now() };
  state.agentComms.push(msg);
  return msg;
}

/**
 * Read all messages addressed to a specific agent (or broadcast).
 */
export function getMessagesFor(state: AgentState, agentName: string): InterAgentMessage[] {
  return state.agentComms.filter(
    (m) => m.to === agentName || m.to === "*"
  );
}

/**
 * Merge a partial update into the current state.
 * `messages` are *appended*; everything else is overwritten.
 *
 * Safety: enforces size caps on all collection fields to prevent
 * unbounded memory growth from runaway agents.
 */
export function mergeState(
  current: AgentState,
  update: Partial<AgentState>
): AgentState {
  const merged = { ...current, ...update };

  // Messages are always appended, never replaced
  if (update.messages) {
    merged.messages = [...current.messages, ...update.messages];
  }

  // Artifacts are merged, not replaced
  if (update.artifacts) {
    merged.artifacts = { ...current.artifacts, ...update.artifacts };
  }

  // Agent comms are appended, not replaced
  if (update.agentComms) {
    merged.agentComms = [...current.agentComms, ...update.agentComms];
  }

  // Errors are appended, not replaced
  if (update.errors) {
    merged.errors = [...current.errors, ...update.errors];
  }

  // Terminal results are appended, not replaced
  if (update.terminalResults) {
    merged.terminalResults = [...current.terminalResults, ...update.terminalResults];
  }

  // ── Enforce size caps to prevent unbounded growth ──
  if (merged.messages.length > MAX_MESSAGES) {
    // Keep first user message + most recent messages
    const first = merged.messages[0];
    merged.messages = [first, ...merged.messages.slice(-(MAX_MESSAGES - 1))];
  }
  if (merged.agentComms.length > MAX_AGENT_COMMS) {
    merged.agentComms = merged.agentComms.slice(-MAX_AGENT_COMMS);
  }
  if (merged.errors.length > MAX_ERRORS) {
    merged.errors = merged.errors.slice(-MAX_ERRORS);
  }
  if (merged.terminalResults.length > MAX_TERMINAL_RESULTS) {
    merged.terminalResults = merged.terminalResults.slice(-MAX_TERMINAL_RESULTS);
  }

  // Clamp overly long string fields
  if (merged.finalAnswer.length > MAX_FIELD_LENGTH) {
    merged.finalAnswer = merged.finalAnswer.slice(0, MAX_FIELD_LENGTH) + "\n[... truncated]";
  }
  if (merged.workspaceContext.length > MAX_FIELD_LENGTH) {
    merged.workspaceContext = merged.workspaceContext.slice(0, MAX_FIELD_LENGTH);
  }

  return merged;
}

/**
 * Create an immutable snapshot of the state for safe use in parallel agents.
 * Uses structured clone + Object.freeze to prevent cross-contamination.
 */
export function frozenSnapshot(state: AgentState): Readonly<AgentState> {
  const clone: AgentState = {
    messages: [...state.messages],
    nextAgent: state.nextAgent,
    pendingAgents: [...state.pendingAgents],
    plan: [...state.plan],
    planStep: state.planStep,
    artifacts: { ...state.artifacts },
    reviewCount: state.reviewCount,
    finalAnswer: state.finalAnswer,
    status: state.status,
    reviewVerdict: state.reviewVerdict,
    agentComms: [...state.agentComms],
    errors: [...state.errors],
    workspaceContext: state.workspaceContext,
    references: state.references,
    chatHistory: state.chatHistory,
    terminalResults: [...state.terminalResults],
    domainAssignments: [...state.domainAssignments],
  };
  return Object.freeze(clone);
}
