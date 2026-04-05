/**
 * Tests for the module integrity checker.
 */

import { verifyModuleIntegrity, type IntegrityReport } from "../../utils/integrity";

describe("verifyModuleIntegrity", () => {
  it("should pass when all required exports exist with correct types", () => {
    const module = {
      foo: () => {},
      bar: { baz: 1 },
      qux: "hello",
    };

    const report = verifyModuleIntegrity([
      {
        label: "test-module",
        module,
        requiredExports: [
          { name: "foo", expectedType: "function" },
          { name: "bar", expectedType: "object" },
          { name: "qux", expectedType: "string" },
        ],
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.passed).toContain("test-module");
  });

  it("should fail when a required export is missing", () => {
    const module = { foo: () => {} };

    const report = verifyModuleIntegrity([
      {
        label: "incomplete-module",
        module,
        requiredExports: [
          { name: "foo", expectedType: "function" },
          { name: "bar", expectedType: "function" },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toEqual({
      module: "incomplete-module",
      export: "bar",
      expected: "function",
      actual: "missing",
    });
    expect(report.passed).not.toContain("incomplete-module");
  });

  it("should fail when an export has the wrong type", () => {
    const module = { callModel: "not a function" };

    const report = verifyModuleIntegrity([
      {
        label: "wrong-type-module",
        module,
        requiredExports: [
          { name: "callModel", expectedType: "function" },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures[0]).toEqual({
      module: "wrong-type-module",
      export: "callModel",
      expected: "function",
      actual: "string",
    });
  });

  it("should detect truncated module (empty object)", () => {
    const report = verifyModuleIntegrity([
      {
        label: "truncated-module",
        module: {},
        requiredExports: [
          { name: "buildMessages", expectedType: "function" },
          { name: "callModel", expectedType: "function" },
          { name: "MODELS", expectedType: "object" },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(3);
    expect(report.failures.every(f => f.actual === "missing")).toBe(true);
  });

  it("should check multiple modules independently", () => {
    const goodModule = { fn: () => {} };
    const badModule = {};

    const report = verifyModuleIntegrity([
      {
        label: "good-module",
        module: goodModule,
        requiredExports: [{ name: "fn", expectedType: "function" }],
      },
      {
        label: "bad-module",
        module: badModule,
        requiredExports: [{ name: "fn", expectedType: "function" }],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.passed).toContain("good-module");
    expect(report.passed).not.toContain("bad-module");
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].module).toBe("bad-module");
  });

  it("should treat null exports as missing", () => {
    const module = { fn: null };

    const report = verifyModuleIntegrity([
      {
        label: "null-module",
        module: module as any,
        requiredExports: [{ name: "fn", expectedType: "function" }],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures[0].actual).toBe("missing");
  });

  it("should pass with zero contracts", () => {
    const report = verifyModuleIntegrity([]);
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
  });
});
