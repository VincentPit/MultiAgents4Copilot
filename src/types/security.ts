/**
 * @module security-types
 * @description Shared type definitions used across all security domains.
 * This is GLUE CODE — it defines the common interfaces that domain modules
 * can optionally conform to, enabling unified security middleware.
 */

// ─── Common Security Event Types ──────────────────────────────────────────────

/** Severity levels for security events across all domains */
export type SecuritySeverity = "low" | "medium" | "high" | "critical";

/** Canonical security event structure emitted by any domain */
export interface SecurityEvent {
  /** ISO-8601 timestamp */
  readonly timestamp: string;
  /** Which domain reported it */
  readonly domain:
    | "file-writer"
    | "terminal-runner"
    | "agent-input"
    | "prompt-guard"
    | "github-client"
    | "graph-router"
    | "state-integrity";
  /** Event severity */
  readonly severity: SecuritySeverity;
  /** Machine-readable error/event code */
  readonly code: string;
  /** Human-readable description (must be secret-free) */
  readonly message: string;
  /** Optional structured metadata (must be secret-free) */
  readonly metadata?: Record<string, unknown>;
}

/** Callback type for security event listeners */
export type SecurityEventListener = (event: SecurityEvent) => void;

// ─── Common Validation Result ─────────────────────────────────────────────────

/** Standardized result type returned by validators across domains */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ─── Circuit Breaker Config (shared between graph & agent domains) ────────────

export interface CircuitBreakerConfig {
  readonly maxIterations: number;
  readonly maxErrors: number;
  readonly cooldownMs: number;
}

// ─── Agent Identity (shared between agent & router domains) ───────────────────

/** The canonical list of agent identifiers used system-wide */
export const CANONICAL_AGENT_IDS = [
  "planner",
  "researcher",
  "coder",
  "coder_pool",
  "integrator",
  "reviewer",
  "tester",
  "ui_designer",
  "supervisor",
  "__end__",
] as const;

export type CanonicalAgentId = (typeof CANONICAL_AGENT_IDS)[number];
