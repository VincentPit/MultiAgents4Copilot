/**
 * Tests for src/security/securityConfig.ts
 */

import {
  DEFAULT_SECURITY_CONFIG,
  getSecurityConfig,
  type SecurityConfig,
} from "../../security/securityConfig";

describe("DEFAULT_SECURITY_CONFIG", () => {
  it("is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG.input)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG.fileWriter)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG.fileWriter.blockedExtensions)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG.terminalRunner)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SECURITY_CONFIG.circuitBreaker)).toBe(true);
  });

  it("has sensible input limits", () => {
    const { input } = DEFAULT_SECURITY_CONFIG;
    expect(input.maxInputLength).toBeGreaterThan(0);
    expect(input.maxOutputLength).toBeGreaterThanOrEqual(input.maxInputLength);
    expect(input.maxChatHistoryLength).toBeGreaterThan(0);
    expect(input.maxChatMessageLength).toBeGreaterThan(0);
  });

  it("blocks dangerous executable extensions", () => {
    const blocked = DEFAULT_SECURITY_CONFIG.fileWriter.blockedExtensions;
    expect(blocked).toContain(".exe");
    expect(blocked).toContain(".dll");
    expect(blocked).toContain(".so");
    // .sh is intentionally NOT in the blocked list
    expect(blocked).not.toContain(".sh");
    // Ensure common code extensions are NOT blocked
    expect(blocked).not.toContain(".ts");
    expect(blocked).not.toContain(".js");
    expect(blocked).not.toContain(".py");
    expect(blocked).not.toContain(".go");
  });

  it("has positive terminal timeout", () => {
    expect(DEFAULT_SECURITY_CONFIG.terminalRunner.commandTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_SECURITY_CONFIG.terminalRunner.maxArgLength).toBeGreaterThan(0);
  });

  it("has circuit breaker with reasonable limits", () => {
    const cb = DEFAULT_SECURITY_CONFIG.circuitBreaker;
    expect(cb.maxIterations).toBeGreaterThan(cb.maxErrors);
    expect(cb.cooldownMs).toBeGreaterThan(0);
  });

  it("has prompt guard and audit logging enabled by default", () => {
    expect(DEFAULT_SECURITY_CONFIG.promptGuardEnabled).toBe(true);
    expect(DEFAULT_SECURITY_CONFIG.auditLoggingEnabled).toBe(true);
  });

  it("cannot be mutated", () => {
    expect(() => {
      (DEFAULT_SECURITY_CONFIG as any).promptGuardEnabled = false;
    }).toThrow();
    expect(() => {
      (DEFAULT_SECURITY_CONFIG.input as any).maxInputLength = 999;
    }).toThrow();
  });
});

describe("getSecurityConfig", () => {
  it("returns the default config", () => {
    const config = getSecurityConfig();
    expect(config).toBe(DEFAULT_SECURITY_CONFIG);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(getSecurityConfig())).toBe(true);
  });

  it("satisfies the SecurityConfig interface shape", () => {
    const config: SecurityConfig = getSecurityConfig();
    expect(config.input).toBeDefined();
    expect(config.fileWriter).toBeDefined();
    expect(config.terminalRunner).toBeDefined();
    expect(config.github).toBeDefined();
    expect(config.circuitBreaker).toBeDefined();
    expect(typeof config.promptGuardEnabled).toBe("boolean");
    expect(typeof config.auditLoggingEnabled).toBe("boolean");
  });
});
