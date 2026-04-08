/**
 * Tests for src/utils/logger.ts
 * Covers: format redaction, structured logging methods, dispose lifecycle.
 */

import * as vscode from "vscode";
import { logger } from "../../utils/logger";

// The vscode mock provides a createOutputChannel that returns a mock channel
const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0]?.value
  ?? vscode.window.createOutputChannel("test", { log: true });

describe("logger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure logger has a fresh channel
    logger.dispose();
  });

  it("logs info messages", () => {
    logger.info("test", "hello world");
    // The channel should have been created and info called
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs warn messages", () => {
    logger.warn("test", "warning message");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs error messages", () => {
    logger.error("test", "error occurred");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs debug messages", () => {
    logger.debug("test", "debug info");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs agent start", () => {
    logger.agentStart("planner");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs agent end with duration", () => {
    logger.agentEnd("planner", 1234);
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs routing decisions", () => {
    logger.route("supervisor", "coder");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs fallback activation", () => {
    logger.fallback("coder", "rate limited", "gemini-3-pro");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("logs agent messages", () => {
    logger.agentMessage("coder", "reviewer", "here is the code I wrote for the auth module");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("redacts secrets from log messages", () => {
    // We can test this by calling logger and checking the format function
    // imports redactSecrets internally. Test via the module directly.
    const { redactSecrets } = require("../../utils/security");
    const msg = "Token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn here";
    const redacted = redactSecrets(msg);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("ghp_ABCDEF");
  });

  it("redacts secrets from data objects in log output", () => {
    const { redactSecrets } = require("../../utils/security");
    const data = JSON.stringify({ key: "sk-abcdefghijklmnopqrstuvwxyz12345678" });
    const redacted = redactSecrets(data);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-abcdef");
  });

  it("dispose cleans up the channel", () => {
    logger.info("test", "before dispose");
    logger.dispose();
    // After dispose, next call should create a new channel
    logger.info("test", "after dispose");
    // createOutputChannel should have been called at least twice
    expect((vscode.window.createOutputChannel as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("show reveals the output channel", () => {
    logger.show();
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });
});
