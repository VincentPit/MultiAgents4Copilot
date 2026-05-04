/**
 * Multi-Coder View — opens separate webview panels for each parallel domain coder.
 *
 * Instead of a single grid dashboard, each coder gets its own dedicated
 * panel arranged across VS Code's editor columns. A compact overview panel
 * shows aggregate status at a glance.
 *
 * Usage:
 *   const view = MultiCoderViewManager.getInstance();
 *   view.openAll(domains);
 *   view.appendLog("backend-api", "📁 Wrote routes.ts");
 *   view.updateStatus("backend-api", "running", { phase: "coding" });
 *   view.addFile("backend-api", "src/routes.ts");
 *   view.setTestResult("backend-api", true, "All 5 tests passed");
 *   view.closeAll();
 */

import * as vscode from "vscode";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

interface CoderDomain {
  id: string;
  domain: string;
  description?: string;
  filePatterns?: string[];
}

export type CoderStatus = "queued" | "coding" | "writing" | "testing" | "done" | "error";

interface CoderPanelState {
  domain: CoderDomain;
  panel: vscode.WebviewPanel;
  status: CoderStatus;
  logs: string[];
  files: string[];
  testPassed: boolean | null;
  testOutput: string;
  startTime: number;
  endTime: number | null;
  phase: string;
}

// ── HTML helpers ─────────────────────────────────────────────────────

/** Maximum log lines retained per coder panel. */
export const MAX_LOGS_PER_CODER = 500;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_DISPLAY: Record<CoderStatus, { icon: string; label: string; color: string }> = {
  queued:  { icon: "⏳", label: "Queued",   color: "var(--vscode-descriptionForeground)" },
  coding:  { icon: "🚀", label: "Coding",   color: "var(--vscode-terminal-ansiBlue, #569cd6)" },
  writing: { icon: "📁", label: "Writing",  color: "var(--vscode-terminal-ansiYellow, #dcdcaa)" },
  testing: { icon: "🧪", label: "Testing",  color: "var(--vscode-terminal-ansiMagenta, #c586c0)" },
  done:    { icon: "✅", label: "Done",     color: "var(--vscode-terminal-ansiGreen, #4ec9b0)" },
  error:   { icon: "❌", label: "Error",    color: "var(--vscode-terminal-ansiRed, #f44747)" },
};

// ── Overview Panel ───────────────────────────────────────────────────

function buildOverviewHtml(coders: CoderPanelState[]): string {
  const cards = coders.map(c => {
    const sd = STATUS_DISPLAY[c.status];
    const elapsed = c.endTime
      ? formatMs(c.endTime - c.startTime)
      : formatMs(Date.now() - c.startTime);
    const fileCount = c.files.length;
    const testBadge = c.testPassed === null
      ? ""
      : c.testPassed
        ? '<span class="badge pass">PASS</span>'
        : '<span class="badge fail">FAIL</span>';

    return `
      <div class="coder-card status-${escapeHtml(c.status)}">
        <div class="card-header">
          <span class="card-icon">${sd.icon}</span>
          <span class="card-title">${escapeHtml(c.domain.domain)}</span>
          ${testBadge}
        </div>
        <div class="card-meta">
          <span class="card-status" style="color:${sd.color}">${sd.label}</span>
          <span class="card-elapsed">${elapsed}</span>
        </div>
        <div class="card-details">
          <span>${fileCount} file${fileCount !== 1 ? "s" : ""}</span>
          <span class="card-phase">${escapeHtml(c.phase)}</span>
        </div>
        <div class="progress-bar"><div class="progress-fill status-${escapeHtml(c.status)}"></div></div>
      </div>`;
  }).join("");

  const doneCount = coders.filter(c => c.status === "done").length;
  const errorCount = coders.filter(c => c.status === "error").length;
  const totalFiles = coders.reduce((s, c) => s + c.files.length, 0);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px;
    padding: 12px;
  }
  .overview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  .overview-title { font-size: 15px; font-weight: 600; }
  .overview-stats { font-size: 12px; opacity: 0.8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .coder-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 8px;
    padding: 10px 12px;
    transition: border-color 0.3s;
  }
  .coder-card.status-coding { border-color: var(--vscode-terminal-ansiBlue, #569cd6); }
  .coder-card.status-done   { border-color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  .coder-card.status-error  { border-color: var(--vscode-terminal-ansiRed, #f44747); }
  .card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .card-icon { font-size: 16px; }
  .card-title { font-weight: 600; font-size: 13px; flex: 1; }
  .badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .badge.pass { background: #2d4a2d; color: #4ec9b0; }
  .badge.fail { background: #4a2d2d; color: #f44747; }
  .card-meta {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .card-elapsed { opacity: 0.7; }
  .card-details {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    opacity: 0.7;
    margin-bottom: 6px;
  }
  .progress-bar {
    height: 3px;
    background: var(--vscode-panel-border, #333);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.4s ease;
  }
  .progress-fill.status-queued  { width: 10%; background: var(--vscode-descriptionForeground); }
  .progress-fill.status-coding  { width: 40%; background: var(--vscode-terminal-ansiBlue, #569cd6); }
  .progress-fill.status-writing { width: 65%; background: var(--vscode-terminal-ansiYellow, #dcdcaa); }
  .progress-fill.status-testing { width: 85%; background: var(--vscode-terminal-ansiMagenta, #c586c0); }
  .progress-fill.status-done    { width: 100%; background: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  .progress-fill.status-error   { width: 100%; background: var(--vscode-terminal-ansiRed, #f44747); }
</style>
</head>
<body>
  <div class="overview-header">
    <span class="overview-title">🏢 Parallel Coders</span>
    <span class="overview-stats">${doneCount + errorCount}/${coders.length} complete · ${totalFiles} files</span>
  </div>
  <div class="grid">${cards}</div>
  <script>
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'refresh') {
        document.body.innerHTML = msg.html;
      }
    });
  </script>
</body>
</html>`;
}

// ── Individual Coder Panel ───────────────────────────────────────────

function buildCoderPanelHtml(state: CoderPanelState): string {
  const sd = STATUS_DISPLAY[state.status];
  const elapsed = state.endTime
    ? formatMs(state.endTime - state.startTime)
    : formatMs(Date.now() - state.startTime);

  const logHtml = state.logs
    .map(l => {
      let cls = "log-line";
      if (l.includes("✅") || l.includes("📁")) { cls += " highlight"; }
      if (l.includes("❌") || l.includes("⚠️")) { cls += " error"; }
      if (l.startsWith("---") && l.endsWith("---")) { cls += " separator"; }
      return `<div class="${cls}">${escapeHtml(l)}</div>`;
    })
    .join("");

  const fileListHtml = state.files.length > 0
    ? state.files.map(f => `<div class="file-entry">📄 ${escapeHtml(f)}</div>`).join("")
    : '<div class="empty-note">No files written yet</div>';

  const testSection = state.testPassed !== null
    ? `<div class="section">
        <div class="section-header">${state.testPassed ? "✅" : "❌"} Test Results</div>
        <div class="test-output ${state.testPassed ? "pass" : "fail"}">${escapeHtml(state.testOutput || (state.testPassed ? "All tests passed" : "Tests failed"))}</div>
       </div>`
    : "";

  return /* html */ `<!DOCTYPE html>
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
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .header {
    padding: 8px 12px;
    background: var(--vscode-sideBarSectionHeader-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .header-left { display: flex; align-items: center; gap: 8px; }
  .header-title { font-weight: 700; font-size: 14px; }
  .header-status {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
  }
  .header-elapsed { font-size: 11px; opacity: 0.7; }
  .progress-bar {
    height: 3px;
    background: var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .progress-fill {
    height: 100%;
    transition: width 0.4s ease;
  }
  .content { flex: 1; overflow-y: auto; padding: 0; min-height: 0; }
  .section {
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  .section-header {
    padding: 6px 12px;
    font-weight: 600;
    font-size: 12px;
    background: var(--vscode-sideBarSectionHeader-background, #252526);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .files-section {
    padding: 4px 12px;
    max-height: 120px;
    overflow-y: auto;
  }
  .file-entry {
    font-size: 12px;
    padding: 2px 0;
    opacity: 0.9;
  }
  .empty-note { font-size: 11px; opacity: 0.5; padding: 4px 0; font-style: italic; }
  .log-section {
    flex: 1;
    overflow-y: auto;
    padding: 6px 12px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log-line { padding: 1px 0; }
  .log-line.highlight { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  .log-line.error { color: var(--vscode-terminal-ansiRed, #f44747); }
  .log-line.separator {
    color: var(--vscode-descriptionForeground);
    opacity: 0.5;
    font-size: 11px;
  }
  .test-output {
    padding: 6px 12px;
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 150px;
    overflow-y: auto;
  }
  .test-output.pass { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  .test-output.fail { color: var(--vscode-terminal-ansiRed, #f44747); }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <span class="header-title">${sd.icon} ${escapeHtml(state.domain.domain)}</span>
      <span class="header-status" style="color:${sd.color};border:1px solid ${sd.color}">${sd.label}</span>
    </div>
    <span class="header-elapsed">${elapsed}</span>
  </div>
  <div class="progress-bar">
    <div class="progress-fill" id="progress"
         style="width:${progressPercent(state.status)}%;background:${sd.color}"></div>
  </div>
  <div class="content">
    <div class="section">
      <div class="section-header">📂 Files (${state.files.length})</div>
      <div class="files-section">${fileListHtml}</div>
    </div>
    ${testSection}
    <div class="section" style="flex:1;display:flex;flex-direction:column;border-bottom:none;">
      <div class="section-header">📋 Output</div>
      <div class="log-section" id="log-scroll">${logHtml}</div>
    </div>
  </div>
  <script>
    const logEl = document.getElementById('log-scroll');
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'log') {
        const line = document.createElement('div');
        line.className = 'log-line';
        if (msg.text.includes('✅') || msg.text.includes('📁')) line.className += ' highlight';
        if (msg.text.includes('❌') || msg.text.includes('⚠️')) line.className += ' error';
        line.textContent = msg.text;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (msg.type === 'refresh') {
        document.body.innerHTML = msg.html;
      }
    });
    // Auto-scroll on load
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  </script>
</body>
</html>`;
}

export function progressPercent(status: CoderStatus): number {
  switch (status) {
    case "queued":  return 10;
    case "coding":  return 40;
    case "writing": return 65;
    case "testing": return 85;
    case "done":    return 100;
    case "error":   return 100;
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── View Column distribution ─────────────────────────────────────────

/**
 * Distribute N panels across available editor columns.
 * Uses columns Two and Three for coder panels, One for overview.
 */
export function viewColumnForIndex(index: number, total: number): vscode.ViewColumn {
  if (total <= 2) {
    // 1-2 coders: stack in column Two
    return vscode.ViewColumn.Two;
  }
  if (total <= 4) {
    // 3-4 coders: split across Two and Three
    return index < Math.ceil(total / 2) ? vscode.ViewColumn.Two : vscode.ViewColumn.Three;
  }
  // 5-6 coders: distribute across Three columns
  const col = index % 3;
  if (col === 0) { return vscode.ViewColumn.Two; }
  if (col === 1) { return vscode.ViewColumn.Three; }
  return vscode.ViewColumn.Four;
}

// ── Manager ──────────────────────────────────────────────────────────

export class MultiCoderViewManager {
  private static _instance: MultiCoderViewManager | null = null;

  private coders: Map<string, CoderPanelState> = new Map();
  private overviewPanel: vscode.WebviewPanel | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): MultiCoderViewManager {
    if (!MultiCoderViewManager._instance) {
      MultiCoderViewManager._instance = new MultiCoderViewManager();
    }
    return MultiCoderViewManager._instance;
  }

  /**
   * Open individual webview panels for each domain coder plus an overview.
   * Call this when parallel coding begins.
   */
  openAll(domains: CoderDomain[]): void {
    this.closeAll();

    const now = Date.now();

    // Open overview panel first (Column One — beside active editor)
    this.overviewPanel = vscode.window.createWebviewPanel(
      "coder-overview",
      "🏢 Parallel Coders — Overview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.overviewPanel.onDidDispose(() => { this.overviewPanel = null; });

    // Open individual coder panels
    for (let i = 0; i < domains.length; i++) {
      const d = domains[i];
      const viewColumn = viewColumnForIndex(i, domains.length);

      const panel = vscode.window.createWebviewPanel(
        `coder-${d.id}`,
        `🏗️ ${d.domain}`,
        { viewColumn, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );

      const state: CoderPanelState = {
        domain: d,
        panel,
        status: "queued",
        logs: [`⏳ ${d.domain} — queued for execution`],
        files: [],
        testPassed: null,
        testOutput: "",
        startTime: now,
        endTime: null,
        phase: "waiting",
      };

      panel.onDidDispose(() => {
        this.coders.delete(d.id);
        this.refreshOverview();
      });

      this.coders.set(d.id, state);
      this.renderCoderPanel(state);
    }

    this.refreshOverview();

    // Periodically refresh overview to update elapsed times
    this.refreshTimer = setInterval(() => this.refreshOverview(), 2000);

    logger.info("multi-coder-view", `Opened ${domains.length} coder panels + overview`);
  }

  /** Append a log line to a coder's panel. */
  appendLog(domainId: string, text: string): void {
    const state = this.coders.get(domainId);
    if (!state) { return; }

    state.logs.push(text);
    // Evict oldest log lines when cap is exceeded
    while (state.logs.length > MAX_LOGS_PER_CODER) {
      state.logs.shift();
    }
    // Send incremental log to the panel (avoids full re-render)
    state.panel.webview.postMessage({ type: "log", text });
  }

  /** Update a coder's status and phase. */
  updateStatus(domainId: string, status: CoderStatus, opts?: { phase?: string }): void {
    const state = this.coders.get(domainId);
    if (!state) { return; }

    state.status = status;
    if (opts?.phase) { state.phase = opts.phase; }
    if (status === "done" || status === "error") {
      state.endTime = Date.now();
    }

    // Full re-render for status changes (updates header + progress bar)
    this.renderCoderPanel(state);
    this.refreshOverview();
  }

  /** Record a file written by this coder. */
  addFile(domainId: string, filePath: string): void {
    const state = this.coders.get(domainId);
    if (!state) { return; }

    if (!state.files.includes(filePath)) {
      state.files.push(filePath);
      this.renderCoderPanel(state);
      this.refreshOverview();
    }
  }

  /** Record multiple files at once. */
  addFiles(domainId: string, filePaths: string[]): void {
    const state = this.coders.get(domainId);
    if (!state) { return; }

    let changed = false;
    for (const fp of filePaths) {
      if (!state.files.includes(fp)) {
        state.files.push(fp);
        changed = true;
      }
    }
    if (changed) {
      this.renderCoderPanel(state);
      this.refreshOverview();
    }
  }

  /** Record test results for a coder. */
  setTestResult(domainId: string, passed: boolean, output: string): void {
    const state = this.coders.get(domainId);
    if (!state) { return; }

    state.testPassed = passed;
    state.testOutput = output;
    this.renderCoderPanel(state);
    this.refreshOverview();
  }

  /** Close all panels and clean up. */
  closeAll(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const state of this.coders.values()) {
      state.panel.dispose();
    }
    this.coders.clear();
    if (this.overviewPanel) {
      this.overviewPanel.dispose();
      this.overviewPanel = null;
    }
  }

  /** Dispose singleton (call on extension deactivation). */
  dispose(): void {
    this.closeAll();
    MultiCoderViewManager._instance = null;
  }

  /**
   * Build an OutputSink that streams chunks into a coder's panel log,
   * line by line. Use this when calling the LLM so the user sees what
   * the model is generating in real time.
   */
  liveSink(domainId: string): LiveCoderSink {
    return new LiveCoderSink(domainId, this);
  }

  // ── Private rendering ──────────────────────────────────────────────

  private renderCoderPanel(state: CoderPanelState): void {
    if (state.panel.visible || true) {
      state.panel.webview.html = buildCoderPanelHtml(state);
    }
  }

  private refreshOverview(): void {
    if (!this.overviewPanel) { return; }

    const allStates = Array.from(this.coders.values());
    this.overviewPanel.webview.html = buildOverviewHtml(allStates);
  }
}

/**
 * Buffered OutputSink — accumulates streaming LLM chunks and pushes
 * complete lines into the per-coder panel's log feed. Implements the
 * `OutputSink` shape consumed by `callModel` in agents/base.ts.
 */
export class LiveCoderSink {
  private buffer = "";
  constructor(
    private readonly domainId: string,
    private readonly view: MultiCoderViewManager,
  ) {}

  append(chunk: string): void {
    this.buffer += chunk;
    if (!this.buffer.includes("\n")) { return; }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) { continue; }
      // Cap individual line length to prevent the panel from rendering
      // a single 5000-char line that breaks the layout.
      const safe = trimmed.length > 240 ? trimmed.slice(0, 237) + "…" : trimmed;
      this.view.appendLog(this.domainId, safe);
    }
  }

  /** Flush any unterminated final line. Call after the LLM call ends. */
  flush(): void {
    const tail = this.buffer.trimEnd();
    this.buffer = "";
    if (tail.length === 0) { return; }
    const safe = tail.length > 240 ? tail.slice(0, 237) + "…" : tail;
    this.view.appendLog(this.domainId, safe);
  }
}
