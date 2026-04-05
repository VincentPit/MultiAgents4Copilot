/**
 * Tests for src/utils/security.ts
 * Covers: deepFreeze, scanForSecrets, validation functions,
 * safeSerializeState, SecurityValidationError.
 */

import {
  deepFreeze,
  scanForSecrets,
  validateStringLength,
  validateArrayLength,
  validateSerializedSize,
  safeSerializeState,
  SecurityValidationError,
  FORBIDDEN_STATE_KEYS,
  SECRET_VALUE_PATTERNS,
  MAX_STRING_LENGTH,
  MAX_STATE_SIZE_BYTES,
} from "../../utils/security";

// ─── deepFreeze ──────────────────────────────────────────────────────────────

describe("deepFreeze", () => {
  it("should freeze top-level properties", () => {
    const obj = { a: 1, b: "two" };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it("should freeze nested objects", () => {
    const obj = { nested: { deep: { value: 42 } } };
    deepFreeze(obj);
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(Object.isFrozen(obj.nested.deep)).toBe(true);
  });

  it("should freeze arrays", () => {
    const obj = { list: [1, 2, { x: 3 }] };
    deepFreeze(obj);
    expect(Object.isFrozen(obj.list)).toBe(true);
    expect(Object.isFrozen(obj.list[2])).toBe(true);
  });

  it("should prevent mutation after freezing", () => {
    const obj = { value: "original" };
    deepFreeze(obj);
    expect(() => {
      (obj as Record<string, unknown>)["value"] = "modified";
    }).toThrow();
  });
});

// ─── scanForSecrets ──────────────────────────────────────────────────────────

describe("scanForSecrets", () => {
  it("should pass for clean objects", () => {
    expect(() => scanForSecrets({ name: "test", count: 42 })).not.toThrow();
  });

  it("should detect forbidden keys (case insensitive)", () => {
    expect(() => scanForSecrets({ apiKey: "value" })).toThrow(/forbidden/i);
    expect(() => scanForSecrets({ APIKEY: "value" })).toThrow(/forbidden/i);
    expect(() => scanForSecrets({ ApiKey: "value" })).toThrow(/forbidden/i);
    expect(() => scanForSecrets({ TOKEN: "value" })).toThrow(/forbidden/i);
    expect(() => scanForSecrets({ Password: "value" })).toThrow(/forbidden/i);
  });

  it("should detect nested forbidden keys", () => {
    expect(() =>
      scanForSecrets({ config: { database: { password: "hunter2" } } }),
    ).toThrow(/forbidden/i);
  });

  it.each(SECRET_VALUE_PATTERNS.map((p) => [p.label, p.pattern.source]))(
    "should detect %s in string values",
    (label) => {
      const testValues: Record<string, string> = {
        "GitHub PAT": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
        "GitHub OAuth token": "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
        "GitHub fine-grained PAT": "github_pat_ABCDEFGHIJKLMNOPQRSTUV12",
        "OpenAI API key": "sk-abcdefghijklmnopqrstuvwxyz12345678",
        "Bearer token": "Bearer eyJhbGciOiJIUzI1NiJ9.test.signature",
        "PEM private key": "-----BEGIN PRIVATE KEY-----",
        "AWS Access Key ID": "AKIAIOSFODNN7EXAMPLE",
      };
      const value = testValues[label as string];
      if (value) {
        expect(() => scanForSecrets({ data: value })).toThrow(SecurityValidationError);
      }
    },
  );

  it("should scan arrays for secrets", () => {
    expect(() =>
      scanForSecrets({ items: ["clean", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"] }),
    ).toThrow(/GitHub PAT/);
  });

  it("should handle null and undefined gracefully", () => {
    expect(() => scanForSecrets(null)).not.toThrow();
    expect(() => scanForSecrets(undefined)).not.toThrow();
    expect(() => scanForSecrets({ a: null, b: undefined })).not.toThrow();
  });
});

// ─── validateStringLength ────────────────────────────────────────────────────

describe("validateStringLength", () => {
  it("should pass for strings within limit", () => {
    expect(() => validateStringLength("short", "field")).not.toThrow();
  });

  it("should throw for strings exceeding limit", () => {
    expect(() => validateStringLength("x".repeat(101), "field", 100)).toThrow(
      /exceeds maximum/,
    );
  });
});

// ─── validateArrayLength ─────────────────────────────────────────────────────

describe("validateArrayLength", () => {
  it("should pass for arrays within limit", () => {
    expect(() => validateArrayLength([1, 2, 3], "field", 10)).not.toThrow();
  });

  it("should throw for arrays exceeding limit", () => {
    expect(() => validateArrayLength(new Array(11), "field", 10)).toThrow(
      /exceeds maximum/,
    );
  });
});

// ─── validateSerializedSize ──────────────────────────────────────────────────

describe("validateSerializedSize", () => {
  it("should pass for small objects", () => {
    expect(() => validateSerializedSize({ a: 1 }, "field")).not.toThrow();
  });

  it("should throw for objects exceeding size limit", () => {
    const huge = { data: "x".repeat(MAX_STATE_SIZE_BYTES) };
    expect(() => validateSerializedSize(huge, "field", MAX_STATE_SIZE_BYTES)).toThrow(
      /exceeds maximum/,
    );
  });

  it("should throw for circular references (non-serializable)", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(() => validateSerializedSize(obj, "field")).toThrow(
      /not JSON-serializable/,
    );
  });
});

// ─── safeSerializeState ──────────────────────────────────────────────────────

describe("safeSerializeState", () => {
  it("should redact forbidden keys", () => {
    const result = safeSerializeState({ token: "secret123", name: "test" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("secret123");
  });

  it("should truncate long values", () => {
    const result = safeSerializeState({ data: "x".repeat(500) }, 100);
    expect(result).toContain("truncated");
  });

  it("should return fallback for circular references", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(safeSerializeState(obj)).toBe("[unserializable state]");
  });
});

// ─── SecurityValidationError ─────────────────────────────────────────────────

describe("SecurityValidationError", () => {
  it("should have correct name, field, and reason", () => {
    const err = new SecurityValidationError("myField", "bad value");
    expect(err.name).toBe("SecurityValidationError");
    expect(err.field).toBe("myField");
    expect(err.reason).toBe("bad value");
    expect(err.message).toContain("myField");
    expect(err.message).toContain("bad value");
  });

  it("should be an instance of Error", () => {
    const err = new SecurityValidationError("f", "r");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecurityValidationError);
  });
});
