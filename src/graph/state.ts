/**
 * Shared state that flows through the agent graph.
 *
 * Every agent receives the full state, modifies what it needs,
 * and returns a partial update that gets merged back.
 */

import * as vscode from "vscode";

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

/** The central state object for the graph. */
export interface AgentState {
  /** Full conversation history. */
  messages: AgentMessage[];

  /** Which agent the supervisor chose to run next. */
  nextAgent: string;

  /** Step-by-step plan from the planner. */
  plan: string[];

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
}

/** Create a blank initial state with the user's first message. */
export function createInitialState(userMessage: string): AgentState {
  return {
    messages: [{ role: "user", content: userMessage }],
    nextAgent: "",
    plan: [],
    artifacts: {},
    reviewCount: 0,
    finalAnswer: "",
    status: "in_progress",
    reviewVerdict: "pending",
    agentComms: [],
    errors: [],
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

  return merged;
}
