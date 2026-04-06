/**
 * Agent Output Manager — creates and manages per-agent output channels.
 *
 * When agents run (especially in parallel), each gets its own VS Code
 * output channel so the user can see what each agent is doing in a
 * dedicated "window". The chat panel shows only high-level status
 * (no code), while detailed agent reasoning flows through these channels.
 *
 * Usage:
 *   const mgr = AgentOutputManager.getInstance();
 *   mgr.show("coder", "Writing src/api/routes.ts…");
 *   mgr.appendCode("coder", "typescript", "const x = 1;");
 *   mgr.revealParallel(["coder", "test_gen"]);
 */

import * as vscode from "vscode";
import { logger } from "./logger";

/** Display metadata for each agent channel. */
const AGENT_CHANNEL_CONFIG: Record<string, { icon: string; label: string }> = {
  supervisor:  { icon: "🧠", label: "Supervisor" },
  planner:     { icon: "📋", label: "Planner" },
  coder:       { icon: "💻", label: "Coder" },
  coder_pool:  { icon: "🏢", label: "Engineering Team" },
  reviewer:    { icon: "✅", label: "Reviewer" },
  integrator:  { icon: "🔗", label: "Integration Engineer" },
  ui_designer: { icon: "🎨", label: "UI Designer" },
  test_gen:    { icon: "🧪", label: "Test Generator" },
};

/**
 * Singleton manager that owns one output channel per agent.
 *
 * Channels are lazily created on first use and reused across
 * graph executions. They persist until the extension deactivates.
 */
export class AgentOutputManager {
  private static _instance: AgentOutputManager | null = null;
  private channels: Map<string, vscode.OutputChannel> = new Map();

  private constructor() {}

  static getInstance(): AgentOutputManager {
    if (!AgentOutputManager._instance) {
      AgentOutputManager._instance = new AgentOutputManager();
    }
    return AgentOutputManager._instance;
  }

  /** Get or create the output channel for an agent. */
  private getChannel(agentName: string): vscode.OutputChannel {
    let ch = this.channels.get(agentName);
    if (!ch) {
      const config = AGENT_CHANNEL_CONFIG[agentName];
      const displayName = config
        ? `${config.icon} Agent: ${config.label}`
        : `⚙️ Agent: ${agentName}`;
      ch = vscode.window.createOutputChannel(displayName);
      this.channels.set(agentName, ch);
    }
    return ch;
  }

  /** Clear a channel and write a fresh header for a new run. */
  startRun(agentName: string, task: string): void {
    const ch = this.getChannel(agentName);
    ch.clear();
    const config = AGENT_CHANNEL_CONFIG[agentName];
    const label = config?.label ?? agentName;
    const now = new Date().toLocaleTimeString();
    ch.appendLine(`═══════════════════════════════════════════════════`);
    ch.appendLine(`  ${config?.icon ?? "⚙️"} ${label} — started at ${now}`);
    ch.appendLine(`  Task: ${task.slice(0, 200)}`);
    ch.appendLine(`═══════════════════════════════════════════════════\n`);
  }

  /** Append a line of status/reasoning text. */
  append(agentName: string, text: string): void {
    const ch = this.getChannel(agentName);
    ch.appendLine(text);
  }

  /** Append a code block with language label. */
  appendCode(agentName: string, language: string, code: string): void {
    const ch = this.getChannel(agentName);
    ch.appendLine(`\n--- ${language} ---`);
    ch.appendLine(code);
    ch.appendLine(`--- end ---\n`);
  }

  /** Mark a run as complete in the channel. */
  endRun(agentName: string, durationMs: number, success: boolean): void {
    const ch = this.getChannel(agentName);
    const status = success ? "✅ Completed" : "❌ Failed";
    const elapsed = durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;
    ch.appendLine(`\n═══════════════════════════════════════════════════`);
    ch.appendLine(`  ${status} in ${elapsed}`);
    ch.appendLine(`═══════════════════════════════════════════════════`);
  }

  /**
   * Reveal a single agent's channel beside the editor.
   * Uses ViewColumn.Beside so it doesn't steal focus from the chat.
   */
  reveal(agentName: string): void {
    const ch = this.getChannel(agentName);
    ch.show(true); // preserveFocus = true
  }

  /**
   * Reveal multiple agent channels for parallel execution.
   * Each channel is shown so the user can see all agents working.
   */
  revealParallel(agentNames: string[]): void {
    for (const name of agentNames) {
      const ch = this.getChannel(name);
      ch.show(true); // preserveFocus = true
    }
    logger.info("output-manager", `Revealed ${agentNames.length} parallel channels: ${agentNames.join(", ")}`);
  }

  /** Dispose all channels (call on extension deactivation). */
  dispose(): void {
    for (const ch of this.channels.values()) {
      ch.dispose();
    }
    this.channels.clear();
    AgentOutputManager._instance = null;
  }
}
