/**
 * @module security
 * @provides Shared security utilities used across the multi-agent system.
 *
 * Centralizes sanitization, validation, and secret-scanning logic so that
 * every trust boundary uses the same rules.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum allowed length for a single string field in agent state. */
export const MAX_STRING_LENGTH = 100_000;

/** Maximum number of messages allowed in state. */
export const MAX_MESSAGES = 500;

/** Maximum number of agent outputs allowed in state. */
export const MAX_AGENT_OUTPUTS = 200;

/** Maximum total serialized state size in bytes (5 MB). */
export const MAX_STATE_SIZE_BYTES = 5 * 1024 * 1024;

/** Maximum iterations before the circuit breaker trips. */
export const MAX_ITERATIONS = 50;

/** Maximum consecutive visits to the same agent before tripping. */
export const MAX_CONSECUTIVE_SAME_AGENT = 3;

/**
 * Forbidden keys that must never appear in serialized state.
 * All entries are **lowercase** so we can do case-insensitive matching
 * by lowercasing the candidate key before the lookup.
 */
export const FORBIDDEN_STATE_KEYS: ReadonlySet<string> = new Set([
  "token",
  "password",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
]);

/**
 * Regex patterns that detect inline secrets/credentials inside string values.
 * Each pattern is paired with a human-readable label for error messages.
 */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /ghp_[A-Za-z0-9_]{36,}/, label: "GitHub PAT" },
  { pattern: /gho_[A-Za-z0-9_]{36,}/, label: "GitHub OAuth token" },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/, label: "GitHub fine-grained PAT" },
  { pattern: /sk-[A-Za-z0-9]{32,}/, label: "OpenAI API key" },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i, label: "Bearer token" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: "PEM private key" },
  { pattern: /AKIA[0-9A-Z]{16}/, label: "AWS Access Key ID" },
];

// ─── Custom Errors ───────────────────────────────────────────────────────────

/**
 * Thrown when a security-sensitive validation check fails.
 */
export class SecurityValidationError extends Error {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Security validation failed on "${field}": ${reason}`);
    this.name = "SecurityValidationError";
    this.field = field;
    this.reason = reason;
    Object.setPrototypeOf(this, SecurityValidationError.prototype);
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Deep-freeze an object graph so that no nested property can be mutated.
 * Returns the same reference, now frozen at every level.
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj as Readonly<T>;
}

/**
 * Recursively scan an object for keys or values that look like secrets.
 *
 * @throws SecurityValidationError if a forbidden key or secret value is found.
 */
export function scanForSecrets(
  obj: unknown,
  path: string = "state",
): void {
  if (obj === null || obj === undefined) {
    return;
  }

  if (typeof obj === "string") {
    for (const { pattern, label } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(obj)) {
        throw new SecurityValidationError(
          path,
          `Value appears to contain a ${label}`,
        );
      }
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      scanForSecrets(obj[i], `${path}[${i}]`);
    }
    return;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Case-insensitive key check — all set entries are lowercase
      if (FORBIDDEN_STATE_KEYS.has(key.toLowerCase())) {
        throw new SecurityValidationError(
          `${path}.${key}`,
          `Key "${key}" is forbidden — it may contain credentials`,
        );
      }
      scanForSecrets(value, `${path}.${key}`);
    }
  }
}

/**
 * Validate that a string does not exceed the maximum allowed length.
 *
 * @throws SecurityValidationError if the string is too long.
 */
export function validateStringLength(
  value: string,
  field: string,
  max: number = MAX_STRING_LENGTH,
): void {
  if (value.length > max) {
    throw new SecurityValidationError(
      field,
      `String length ${value.length} exceeds maximum ${max}`,
    );
  }
}

/**
 * Validate that an array does not exceed the given size limit.
 *
 * @throws SecurityValidationError if the array is too large.
 */
export function validateArrayLength(
  arr: readonly unknown[],
  field: string,
  max: number,
): void {
  if (arr.length > max) {
    throw new SecurityValidationError(
      field,
      `Array length ${arr.length} exceeds maximum ${max}`,
    );
  }
}

/**
 * Validate total serialized size of an object in bytes.
 *
 * @throws SecurityValidationError if the serialized form exceeds the limit.
 */
export function validateSerializedSize(
  obj: unknown,
  field: string,
  maxBytes: number = MAX_STATE_SIZE_BYTES,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    throw new SecurityValidationError(field, "State is not JSON-serializable");
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    throw new SecurityValidationError(
      field,
      `Serialized size ${byteLength} bytes exceeds maximum ${maxBytes} bytes`,
    );
  }
}

/**
 * Safely serialize state for logging — redacts any value whose key matches
 * the forbidden-keys list and truncates very long strings.
 */
export function safeSerializeState(obj: unknown, maxValueLength = 200): string {
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        if (typeof _key === "string" && FORBIDDEN_STATE_KEYS.has(_key.toLowerCase())) {
          return "[REDACTED]";
        }
        if (typeof value === "string" && value.length > maxValueLength) {
          return value.slice(0, maxValueLength) + `…[truncated ${value.length - maxValueLength} chars]`;
        }
        return value;
      },
      2,
    );
  } catch {
    return "[unserializable state]";
  }
}
