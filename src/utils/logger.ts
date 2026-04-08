/**
 * Structured logger — uses VS Code's `LogOutputChannel` API (available
 * since VS Code 1.74+) for proper log levels, timestamps, and filtering.
 *
 * View it: Cmd+Shift+P → "Output: Focus on Output View" → select "Multi-Agent Copilot"
 */

import * as vscode from "vscode";
import { redactSecrets } from "./security";

let _channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("Multi-Agent Copilot", { log: true });
  }
  return _channel;
}

function format(source: string, message: string, data?: unknown): string {
  const safeMsg = redactSecrets(message);
  const line = data
    ? `[${source}] ${safeMsg} ${redactSecrets(JSON.stringify(data))}`
    : `[${source}] ${safeMsg}`;
  return line;
}

export const logger = {
  info:  (source: string, msg: string, data?: unknown) => getChannel().info(format(source, msg, data)),
  warn:  (source: string, msg: string, data?: unknown) => getChannel().warn(format(source, msg, data)),
  error: (source: string, msg: string, data?: unknown) => getChannel().error(format(source, msg, data)),
  debug: (source: string, msg: string, data?: unknown) => getChannel().debug(format(source, msg, data)),

  /** Log an agent invocation start. */
  agentStart(agent: string): void {
    getChannel().info(format("graph", `▶ Agent "${agent}" started`));
  },

  /** Log an agent invocation end with timing. */
  agentEnd(agent: string, durationMs: number): void {
    getChannel().info(format("graph", `◼ Agent "${agent}" finished in ${durationMs}ms`));
  },

  /** Log a routing decision. */
  route(from: string, to: string): void {
    getChannel().info(format("router", `${from} → ${to}`));
  },

  /** Log fallback activation. */
  fallback(agent: string, error: string, fallbackModel: string): void {
    getChannel().warn(format("fallback", `Agent "${agent}" failed: ${error}. Falling back to ${fallbackModel}`));
  },

  /** Log inter-agent message. */
  agentMessage(from: string, to: string, preview: string): void {
    getChannel().debug(format("comms", `📨 ${from} → ${to}: "${preview.slice(0, 80)}…"`));
  },

  /** Show the output channel to the user. */
  show(): void {
    getChannel().show(true);
  },

  dispose(): void {
    _channel?.dispose();
    _channel = undefined;
  },
};
