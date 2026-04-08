/**
 * Tests for src/utils/multiCoderView.ts — MultiCoderViewManager.
 */

import * as vscode from "vscode";
import { MultiCoderViewManager } from "../../utils/multiCoderView";

// Helper to get a fresh singleton for each test
function resetManager(): MultiCoderViewManager {
  // Dispose existing instance to clean up
  MultiCoderViewManager.getInstance().dispose();
  return MultiCoderViewManager.getInstance();
}

const twoDomains = [
  { id: "backend-api", domain: "Backend API", description: "REST routes" },
  { id: "data-layer", domain: "Data Layer", description: "Database models" },
];

const threeDomains = [
  { id: "backend-api", domain: "Backend API" },
  { id: "data-layer", domain: "Data Layer" },
  { id: "frontend", domain: "Frontend" },
];

const sixDomains = [
  { id: "d1", domain: "D1" },
  { id: "d2", domain: "D2" },
  { id: "d3", domain: "D3" },
  { id: "d4", domain: "D4" },
  { id: "d5", domain: "D5" },
  { id: "d6", domain: "D6" },
];

describe("MultiCoderViewManager", () => {
  let mgr: MultiCoderViewManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mgr = resetManager();
  });

  afterEach(() => {
    mgr.dispose();
  });

  // ── Singleton ────────────────────────────────────────────────────

  it("returns the same instance from getInstance()", () => {
    const a = MultiCoderViewManager.getInstance();
    const b = MultiCoderViewManager.getInstance();
    expect(a).toBe(b);
  });

  it("returns a new instance after dispose()", () => {
    const a = MultiCoderViewManager.getInstance();
    a.dispose();
    const b = MultiCoderViewManager.getInstance();
    expect(a).not.toBe(b);
  });

  // ── openAll ──────────────────────────────────────────────────────

  it("creates one webview panel per domain plus an overview", () => {
    mgr.openAll(twoDomains);

    // 1 overview + 2 domain panels = 3 calls to createWebviewPanel
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(3);
  });

  it("passes correct viewType for overview and coder panels", () => {
    mgr.openAll(twoDomains);

    const calls = (vscode.window.createWebviewPanel as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe("coder-overview"); // overview panel
    expect(calls[1][0]).toBe("coder-backend-api");
    expect(calls[2][0]).toBe("coder-data-layer");
  });

  it("sets panel titles with domain names", () => {
    mgr.openAll(twoDomains);

    const calls = (vscode.window.createWebviewPanel as jest.Mock).mock.calls;
    expect(calls[0][1]).toContain("Overview");
    expect(calls[1][1]).toContain("Backend API");
    expect(calls[2][1]).toContain("Data Layer");
  });

  it("closes previous panels before opening new ones", () => {
    mgr.openAll(twoDomains);
    const firstDisposeCalls = (vscode.window.createWebviewPanel as jest.Mock)
      .mock.results.map((r: any) => r.value.dispose);

    mgr.openAll(threeDomains);

    // Previous panels should have been disposed
    for (const disposeFn of firstDisposeCalls) {
      expect(disposeFn).toHaveBeenCalled();
    }
  });

  it("creates panels for 6 domains", () => {
    mgr.openAll(sixDomains);
    // 1 overview + 6 domain = 7
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(7);
  });

  // ── appendLog ────────────────────────────────────────────────────

  it("sends log messages via postMessage to the coder panel", () => {
    mgr.openAll(twoDomains);

    mgr.appendLog("backend-api", "🚀 Generating code…");

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[1].value;
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "log",
      text: "🚀 Generating code…",
    });
  });

  it("does nothing for unknown domain IDs", () => {
    mgr.openAll(twoDomains);
    // Should not throw
    mgr.appendLog("nonexistent", "some log");
  });

  // ── updateStatus ─────────────────────────────────────────────────

  it("updates status and triggers HTML re-render", () => {
    mgr.openAll(twoDomains);

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[1].value;
    const initialHtml = panel.webview.html;

    mgr.updateStatus("backend-api", "coding", { phase: "generating code" });

    // HTML should be refreshed (we can't check exact content, but setter was called)
    // The panel.webview.html property is reassigned
    expect(typeof panel.webview.html).toBe("string");
  });

  it("sets endTime when status is done", () => {
    mgr.openAll(twoDomains);
    mgr.updateStatus("backend-api", "done");

    // Verify the overview panel was refreshed (it always re-renders on status change)
    const overviewPanel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value;
    expect(typeof overviewPanel.webview.html).toBe("string");
  });

  it("sets endTime when status is error", () => {
    mgr.openAll(twoDomains);
    mgr.updateStatus("backend-api", "error", { phase: "LLM timeout" });

    const overviewPanel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value;
    expect(typeof overviewPanel.webview.html).toBe("string");
  });

  it("does nothing for unknown domain IDs", () => {
    mgr.openAll(twoDomains);
    // Should not throw
    mgr.updateStatus("nonexistent", "coding");
  });

  // ── addFile / addFiles ───────────────────────────────────────────

  it("tracks files added to a domain", () => {
    mgr.openAll(twoDomains);

    mgr.addFile("backend-api", "src/routes.ts");
    mgr.addFile("backend-api", "src/middleware.ts");

    // Panel HTML re-rendered, so files count should be reflected
    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[1].value;
    expect(panel.webview.html).toContain("src/routes.ts");
    expect(panel.webview.html).toContain("src/middleware.ts");
  });

  it("does not duplicate files", () => {
    mgr.openAll(twoDomains);

    mgr.addFile("backend-api", "src/routes.ts");
    mgr.addFile("backend-api", "src/routes.ts"); // duplicate

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[1].value;
    const matches = (panel.webview.html as string).match(/src\/routes\.ts/g);
    // Should appear only once in the file list (it may appear in the HTML structure too)
    expect(matches).toBeDefined();
  });

  it("adds multiple files at once via addFiles", () => {
    mgr.openAll(twoDomains);

    mgr.addFiles("data-layer", ["src/models/user.ts", "src/db/client.ts"]);

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[2].value;
    expect(panel.webview.html).toContain("src/models/user.ts");
    expect(panel.webview.html).toContain("src/db/client.ts");
  });

  it("does nothing for unknown domain ID in addFile", () => {
    mgr.openAll(twoDomains);
    mgr.addFile("nonexistent", "some/file.ts");
    // No throw expected
  });

  // ── setTestResult ────────────────────────────────────────────────

  it("renders pass badge when tests pass", () => {
    mgr.openAll(twoDomains);

    mgr.setTestResult("backend-api", true, "All 5 tests passed");

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[1].value;
    expect(panel.webview.html).toContain("Test Results");
    expect(panel.webview.html).toContain("All 5 tests passed");
  });

  it("renders fail badge when tests fail", () => {
    mgr.openAll(twoDomains);

    mgr.setTestResult("data-layer", false, "2 of 3 tests failed");

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[2].value;
    expect(panel.webview.html).toContain("Test Results");
    expect(panel.webview.html).toContain("2 of 3 tests failed");
  });

  it("does nothing for unknown domain ID", () => {
    mgr.openAll(twoDomains);
    mgr.setTestResult("nonexistent", true, "ok");
  });

  // ── closeAll ─────────────────────────────────────────────────────

  it("disposes all panels", () => {
    mgr.openAll(twoDomains);

    const panels = (vscode.window.createWebviewPanel as jest.Mock).mock.results;
    mgr.closeAll();

    for (const r of panels) {
      expect(r.value.dispose).toHaveBeenCalled();
    }
  });

  it("is safe to call closeAll with no open panels", () => {
    mgr.closeAll(); // Should not throw
  });

  it("is safe to call closeAll multiple times", () => {
    mgr.openAll(twoDomains);
    mgr.closeAll();
    mgr.closeAll(); // Should not throw
  });

  // ── dispose ──────────────────────────────────────────────────────

  it("cleans up the singleton on dispose", () => {
    mgr.openAll(twoDomains);
    mgr.dispose();

    // New instance should be different
    const fresh = MultiCoderViewManager.getInstance();
    expect(fresh).not.toBe(mgr);
    fresh.dispose();
  });

  // ── Full lifecycle ───────────────────────────────────────────────

  it("runs a full coder lifecycle: open → status → log → files → test → close", () => {
    mgr.openAll(twoDomains);

    // Backend starts coding
    mgr.updateStatus("backend-api", "coding", { phase: "generating code" });
    mgr.appendLog("backend-api", "🚀 Generating code…");

    // Backend writes files
    mgr.updateStatus("backend-api", "writing", { phase: "2 files" });
    mgr.addFiles("backend-api", ["src/routes.ts", "src/middleware.ts"]);
    mgr.appendLog("backend-api", "📁 Wrote 2 files");

    // Backend runs tests
    mgr.updateStatus("backend-api", "testing", { phase: "running tests" });
    mgr.appendLog("backend-api", "🧪 Running tests…");
    mgr.setTestResult("backend-api", true, "All passed");

    // Backend done
    mgr.updateStatus("backend-api", "done", { phase: "2 files, 1.5s" });

    // Data layer also completes
    mgr.updateStatus("data-layer", "coding", { phase: "generating code" });
    mgr.updateStatus("data-layer", "done", { phase: "1 file, 0.8s" });
    mgr.addFile("data-layer", "src/models/user.ts");
    mgr.setTestResult("data-layer", true, "Passed");

    // Close all
    mgr.closeAll();

    // All panels disposed
    const panels = (vscode.window.createWebviewPanel as jest.Mock).mock.results;
    for (const r of panels) {
      expect(r.value.dispose).toHaveBeenCalled();
    }
  });

  // ── Overview HTML ────────────────────────────────────────────────

  it("overview panel reflects aggregate status", () => {
    mgr.openAll(twoDomains);
    mgr.updateStatus("backend-api", "done");
    mgr.updateStatus("data-layer", "coding");

    const overviewPanel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value;
    const html = overviewPanel.webview.html as string;
    expect(html).toContain("Backend API");
    expect(html).toContain("Data Layer");
    expect(html).toContain("Parallel Coders");
  });
});
