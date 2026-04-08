/**
 * Tests for src/agents/tester.ts — exported constants.
 */

import { MAX_TEST_RESPONSE_CHARS } from "../../agents/tester";

describe("tester constants", () => {
  it("exports MAX_TEST_RESPONSE_CHARS as a positive integer", () => {
    expect(MAX_TEST_RESPONSE_CHARS).toBe(6000);
    expect(Number.isInteger(MAX_TEST_RESPONSE_CHARS)).toBe(true);
    expect(MAX_TEST_RESPONSE_CHARS).toBeGreaterThan(0);
  });

  it("ensures MAX_TEST_RESPONSE_CHARS is at least 1000", () => {
    expect(MAX_TEST_RESPONSE_CHARS).toBeGreaterThanOrEqual(1000);
  });

  it("truncation threshold respects the limit", () => {
    const shortResponse = "a".repeat(MAX_TEST_RESPONSE_CHARS - 1);
    expect(shortResponse.length).toBeLessThan(MAX_TEST_RESPONSE_CHARS);

    const longResponse = "b".repeat(MAX_TEST_RESPONSE_CHARS + 100);
    const capped = longResponse.length > MAX_TEST_RESPONSE_CHARS
      ? longResponse.slice(0, MAX_TEST_RESPONSE_CHARS)
      : longResponse;
    expect(capped.length).toBe(MAX_TEST_RESPONSE_CHARS);
  });
});
