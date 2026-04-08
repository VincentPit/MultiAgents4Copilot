/**
 * @module securityConfig
 * @description Centralized security configuration that all domains can reference.
 * Provides a single source of truth for security thresholds, limits, and feature flags.
 *
 * This is GLUE CODE — domain modules define their own defaults but this file
 * allows an operator to override them from one place.
 */

import type { CircuitBreakerConfig } from "../types/security.js";

export interface SecurityConfig {
  /** Input validation limits */
  readonly input: {
    readonly maxInputLength: number;
    readonly maxOutputLength: number;
    readonly maxChatHistoryLength: number;
    readonly maxChatMessageLength: number;
  };

  /** File writer constraints */
  readonly fileWriter: {
    readonly maxFileSizeBytes: number;
    readonly blockedExtensions: readonly string[];
  };

  /** Terminal runner constraints */
  readonly terminalRunner: {
    readonly commandTimeoutMs: number;
    readonly maxArgLength: number;
  };

  /** GitHub client constraints */
  readonly github: {
    readonly requestTimeoutMs: number;
    readonly maxTimeoutMs: number;
  };

  /** Graph circuit breaker */
  readonly circuitBreaker: CircuitBreakerConfig;

  /** Whether prompt injection detection is enabled */
  readonly promptGuardEnabled: boolean;

  /** Whether to log security events to the VS Code output channel */
  readonly auditLoggingEnabled: boolean;
}

/**
 * Default security configuration. These values match the defaults defined
 * within each domain module — this file centralizes them for visibility
 * and optional override.
 */
/** Recursively freeze an object and all nested objects/arrays. */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

export const DEFAULT_SECURITY_CONFIG: Readonly<SecurityConfig> = deepFreeze({
  input: {
    maxInputLength: 50_000,
    maxOutputLength: 100_000,
    maxChatHistoryLength: 100,
    maxChatMessageLength: 30_000,
  },
  fileWriter: {
    maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB
    blockedExtensions: [
      ".exe", ".dll", ".so", ".dylib", ".bin", ".com",
      ".cmd", ".msi", ".app", ".dmg", ".iso", ".img",
      ".scr", ".pif", ".hta", ".cpl", ".jar", ".class",
      ".war", ".sys", ".drv", ".ocx",
    ],
  },
  terminalRunner: {
    commandTimeoutMs: 30_000,
    maxArgLength: 8192,
  },
  github: {
    requestTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
  },
  circuitBreaker: {
    maxIterations: 25,
    maxErrors: 5,
    cooldownMs: 60_000,
  },
  promptGuardEnabled: true,
  auditLoggingEnabled: true,
});

/**
 * Returns the active security config. Currently returns defaults;
 * can be extended to read from VS Code settings or environment variables.
 */
export function getSecurityConfig(): Readonly<SecurityConfig> {
  return DEFAULT_SECURITY_CONFIG;
}
