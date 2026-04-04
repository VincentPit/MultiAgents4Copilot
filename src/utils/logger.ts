/**
 * Structured logger — writes to the VS Code Output Channel so you can
 * see every routing decision, agent call, error, and timing in one place.
 *
 * View it: Cmd+Shift+P → "Output: Focus on Output View" → select "Multi-Agent Copilot"
 */

import * as vscode from "vscode";

let _channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("Multi-Agent Copilot");
  }
  return _channel;
}

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function write(level: LogLevel, source: string, message: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const prefix = `[${ts}] [${level}] [${source}]`;
  const line = data
    ? `${prefix} ${message} ${JSON.stringify(data)}`
    : `${prefix} ${message}`;
  getChannel().appendLine(line);
}

export const logger = {
  info:  (source: string, msg: string, data?: unknown) => write("INFO",  source, msg, data),
  warn:  (source: string, msg: string, data?: unknown) => write("WARN",  source, msg, data),
  error: (source: string, msg: string, data?: unknown) => write("ERROR", source, msg, data),
  debug: (source: string, msg: string, data?: unknown) => write("DEBUG", source, msg, data),

  /** Log an agent invocation start. */
  agentStart(agent: string): void {
    write("INFO", "graph", `▶ Agent "${agent}" started`);
  },

  /** Log an agent invocation end with timing. */
  agentEnd(agent: string, durationMs: number): void {
    write("INFO", "graph", `◼ Agent "${agent}" finished in ${durationMs}ms`);
  },

  /** Log a routing decision. */
  route(from: string, to: string): void {
    write("INFO", "router", `${from} → ${to}`);
  },

  /** Log fallback activation. */
  fallback(agent: string, error: string, fallbackModel: string): void {
    write("WARN", "fallback", `Agent "${agent}" failed: ${error}. Falling back to ${fallbackModel}`);
  },

  /** Log inter-agent message. */
  agentMessage(from: string, to: string, preview: string): void {
    write("DEBUG", "comms", `📨 ${from} → ${to}: "${preview.slice(0, 80)}…"`);
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
