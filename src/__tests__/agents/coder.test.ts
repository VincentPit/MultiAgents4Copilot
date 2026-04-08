/**
 * Tests for src/agents/coder.ts — exported constants and coder agent.
 */

import { CODER_MAX_FIX_RETRIES, MAX_CODER_RESPONSE_CHARS } from "../../agents/coder";

describe("coder constants", () => {
  it("exports CODER_MAX_FIX_RETRIES as a positive integer", () => {
    expect(CODER_MAX_FIX_RETRIES).toBe(2);
    expect(Number.isInteger(CODER_MAX_FIX_RETRIES)).toBe(true);
    expect(CODER_MAX_FIX_RETRIES).toBeGreaterThan(0);
  });

  it("exports MAX_CODER_RESPONSE_CHARS as a positive integer", () => {
    expect(MAX_CODER_RESPONSE_CHARS).toBe(6000);
    expect(Number.isInteger(MAX_CODER_RESPONSE_CHARS)).toBe(true);
    expect(MAX_CODER_RESPONSE_CHARS).toBeGreaterThan(0);
  });

  it("ensures MAX_FIX_RETRIES is sensibly bounded", () => {
    expect(CODER_MAX_FIX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("ensures MAX_CODER_RESPONSE_CHARS is at least 1000", () => {
    expect(MAX_CODER_RESPONSE_CHARS).toBeGreaterThanOrEqual(1000);
  });
});
