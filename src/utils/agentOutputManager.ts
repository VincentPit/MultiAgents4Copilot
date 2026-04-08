/**
 * Agent Output Manager — creates and manages per-agent output channels
 * and a live webview dashboard for parallel domain coders.
 *
 * When domain coders run in parallel, a **webview panel** opens beside
 * the editor showing a grid of live-scrolling log cards — one per domain.
 * This is a real, visible window (not buried in a dropdown).
 *
 * Non-domain agents still use regular output channels.
 *
 * Usage:
 *   const mgr = AgentOutputManager.getInstance();
 *   mgr.createDomainChannels(domains); // opens the dashboard
 *   mgr.append("domain:backend-api", "📁 Wrote routes.ts");
 */

import * as vscode from "vscode";
import { logger } from "./logger";

/** Display metadata for each agent channel. */
export const AGENT_CHANNEL_CONFIG: Record<string, { icon: string; label: string }> = {
  supervisor:  { icon: "🧠", label: "Supervisor" },
  planner:     { icon: "📋", label: "Planner" },
  coder:       { icon: "💻", label: "Coder" },
  coder_pool:  { icon: "🏢", label: "Engineering Team" },
  reviewer:    { icon: "✅", label: "Reviewer" },
  integrator:  { icon: "🔗", label: "Integration Engineer" },
  ui_designer: { icon: "🎨", label: "UI Designer" },
  test_gen:    { icon: "🧪", label: "Test Generator" },
};

/** Escape HTML special characters for safe webview rendering. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Singleton manager that owns one output channel per agent (and per domain),
 * plus a live webview dashboard that shows all domain coders side-by-side.
 */
export class AgentOutputManager {
  private static _instance: AgentOutputManager | null = null;
  private channels: Map<string, vscode.OutputChannel> = new Map();
  /** Track domain channels so we can dispose them between runs. */
  private domainChannels: Set<string> = new Set();

  /** Webview dashboard for parallel domain coders. */
  private dashboardPanel: vscode.WebviewPanel | null = null;
  private dashboardDomains: Array<{ id: string; domain: string }> = [];
  private dashboardLogs: Map<string, string[]> = new Map();

  /** Max log lines retained per domain in the dashboard. */
  static readonly MAX_DASHBOARD_LOGS = 500;

  private constructor() {}

  static getInstance(): AgentOutputManager {
    if (!AgentOutputManager._instance) {
      AgentOutputManager._instance = new AgentOutputManager();
    }
    return AgentOutputManager._instance;
  }

  /** Get or create the output channel for an agent or domain. */
  private getChannel(agentName: string): vscode.OutputChannel {
    let ch = this.channels.get(agentName);
    if (!ch) {
      if (agentName.startsWith("domain:")) {
        const domainId = agentName.slice(7);
        const displayName = `🏗️ Domain: ${domainId}`;
        ch = vscode.window.createOutputChannel(displayName);
        this.domainChannels.add(agentName);
      } else {
        const config = AGENT_CHANNEL_CONFIG[agentName];
        const displayName = config
          ? `${config.icon} Agent: ${config.label}`
          : `⚙️ Agent: ${agentName}`;
        ch = vscode.window.createOutputChannel(displayName);
      }
      this.channels.set(agentName, ch);
    }
    return ch;
  }

  // ── Dashboard (webview) ────────────────────────────────────────────

  /**
   * Create per-domain output channels AND open a live webview dashboard
   * that shows all domains side-by-side in a grid.
   */
  createDomainChannels(domains: Array<{ id: string; domain: string }>): void {
    // 1. Create output channels (still useful for full logs / search)
    for (const d of domains) {
      const channelName = `domain:${d.id}`;
      const ch = this.getChannel(channelName);
      ch.clear();
      const now = new Date().toLocaleTimeString();
      ch.appendLine(`═══════════════════════════════════════════════════`);
      ch.appendLine(`  🏗️ Domain: ${d.domain} (${d.id}) — ${now}`);
      ch.appendLine(`═══════════════════════════════════════════════════\n`);
    }

    // 2. Create the visual dashboard webview
    this.createDashboard(domains);

    logger.info("output-manager", `Created ${domains.length} domain channels + dashboard`);
  }

  /** Create (or re-create) the webview dashboard panel. */
  private createDashboard(domains: Array<{ id: string; domain: string }>): void {
    // Dispose old dashboard
    if (this.dashboardPanel) {
      this.dashboardPanel.dispose();
      this.dashboardPanel = null;
    }

    this.dashboardDomains = domains;
    this.dashboardLogs.clear();
    for (const d of domains) {
      this.dashboardLogs.set(d.id, []);
    }

    this.dashboardPanel = vscode.window.createWebviewPanel(
      "domain-dashboard",
      `🏗️ Domain Coders (${domains.length})`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.dashboardPanel.onDidDispose(() => {
      this.dashboardPanel = null;
    });

    this.updateDashboardHtml();
  }

  /** Build the full dashboard HTML with current logs. */
  private updateDashboardHtml(): void {
    if (!this.dashboardPanel) { return; }

    const domainCards = this.dashboardDomains.map(d => {
      const logs = this.dashboardLogs.get(d.id) ?? [];
      const logHtml = logs
        .map(l => `<div class="log-line">${escapeHtml(l)}</div>`)
        .join("");
      return `
        <div class="domain-card" id="card-${escapeHtml(d.id)}">
          <div class="domain-header">
            <span class="domain-title">🏗️ ${escapeHtml(d.domain)}</span>
            <span class="domain-status" id="status-${escapeHtml(d.id)}">⏳ waiting</span>
          </div>
          <div class="domain-log" id="log-${escapeHtml(d.id)}">${logHtml}</div>
        </div>`;
    }).join("");

    this.dashboardPanel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    padding: 6px;
    height: 100vh;
    overflow: hidden;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 6px;
    height: 100%;
  }
  .domain-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .domain-header {
    padding: 6px 10px;
    background: var(--vscode-sideBarSectionHeader-background, #252526);
    font-weight: bold;
    font-size: 13px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .domain-status {
    font-weight: normal;
    font-size: 11px;
    opacity: 0.8;
  }
  .domain-log {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 0;
  }
  .log-line { padding: 1px 0; }
  .log-line.highlight {
    color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    font-weight: bold;
  }
  .log-line.error {
    color: var(--vscode-terminal-ansiRed, #f44747);
  }
</style>
</head>
<body>
  <div class="grid">${domainCards}</div>
  <script>
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'log') {
        const logEl = document.getElementById('log-' + msg.domainId);
        if (logEl) {
          const line = document.createElement('div');
          line.className = 'log-line';
          if (msg.text.includes('✅') || msg.text.includes('📁')) line.className += ' highlight';
          if (msg.text.includes('❌') || msg.text.includes('⚠️')) line.className += ' error';
          line.textContent = msg.text;
          logEl.appendChild(line);
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      if (msg.type === 'status') {
        const el = document.getElementById('status-' + msg.domainId);
        if (el) el.textContent = msg.status;
      }
    });
  </script>
</body>
</html>`;
  }

  /** Send a log line to the dashboard webview for a domain. */
  private appendToDashboard(domainId: string, text: string): void {
    if (!this.dashboardPanel) { return; }
    const logs = this.dashboardLogs.get(domainId);
    if (logs) {
      logs.push(text);
      // Evict oldest log lines when cap is exceeded
      while (logs.length > AgentOutputManager.MAX_DASHBOARD_LOGS) {
        logs.shift();
      }
    }
    this.dashboardPanel.webview.postMessage({ type: "log", domainId, text });
  }

  /** Update a domain's status badge in the dashboard header. */
  updateDomainStatus(domainId: string, status: string): void {
    if (!this.dashboardPanel) { return; }
    this.dashboardPanel.webview.postMessage({ type: "status", domainId, status });
  }

  /** Dispose the dashboard panel. */
  disposeDashboard(): void {
    if (this.dashboardPanel) {
      this.dashboardPanel.dispose();
      this.dashboardPanel = null;
    }
    this.dashboardDomains = [];
    this.dashboardLogs.clear();
  }

  // ── Output channel methods ─────────────────────────────────────────

  /** Dispose all domain-specific channels (call between runs). */
  disposeDomainChannels(): void {
    for (const name of this.domainChannels) {
      const ch = this.channels.get(name);
      if (ch) {
        ch.dispose();
        this.channels.delete(name);
      }
    }
    this.domainChannels.clear();
    this.disposeDashboard();
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

  /** Append a line of status/reasoning text. Also sends to dashboard if domain. */
  append(agentName: string, text: string): void {
    const ch = this.getChannel(agentName);
    ch.appendLine(text);

    // Also push to the live dashboard
    if (agentName.startsWith("domain:")) {
      this.appendToDashboard(agentName.slice(7), text);
    }
  }

  /** Append a code block with language label. */
  appendCode(agentName: string, language: string, code: string): void {
    const ch = this.getChannel(agentName);
    ch.appendLine(`\n--- ${language} ---`);
    ch.appendLine(code);
    ch.appendLine(`--- end ---\n`);

    if (agentName.startsWith("domain:")) {
      this.appendToDashboard(agentName.slice(7), `--- ${language} ---\n${code}\n--- end ---`);
    }
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

    if (agentName.startsWith("domain:")) {
      const domainId = agentName.slice(7);
      this.updateDomainStatus(domainId, `${status} ${elapsed}`);
    }
  }

  /** Reveal a single agent's channel. */
  reveal(agentName: string): void {
    const ch = this.getChannel(agentName);
    ch.show(true);
  }

  /** Reveal multiple agent channels for parallel execution. */
  revealParallel(agentNames: string[]): void {
    for (const name of agentNames) {
      const ch = this.getChannel(name);
      ch.show(true);
    }
    logger.info("output-manager", `Revealed ${agentNames.length} parallel channels: ${agentNames.join(", ")}`);
  }

  /** Dispose all channels + dashboard (call on extension deactivation). */
  dispose(): void {
    for (const ch of this.channels.values()) {
      ch.dispose();
    }
    this.channels.clear();
    this.domainChannels.clear();
    this.disposeDashboard();
    AgentOutputManager._instance = null;
  }
}
