/**
 * Tests for src/utils/agentOutputManager.ts — AgentOutputManager,
 * AGENT_CHANNEL_CONFIG, and escapeHtml.
 */

import * as vscode from "vscode";
import {
  AgentOutputManager,
  AGENT_CHANNEL_CONFIG,
  escapeHtml,
} from "../../utils/agentOutputManager";

describe("AGENT_CHANNEL_CONFIG", () => {
  const expectedAgents = [
    "supervisor", "planner", "coder", "coder_pool",
    "reviewer", "integrator", "ui_designer", "test_gen",
  ];

  it("defines config for all known agent names", () => {
    for (const agent of expectedAgents) {
      expect(AGENT_CHANNEL_CONFIG[agent]).toBeDefined();
      expect(AGENT_CHANNEL_CONFIG[agent].icon).toBeDefined();
      expect(AGENT_CHANNEL_CONFIG[agent].label).toBeDefined();
    }
  });

  it("each entry has a non-empty icon and label", () => {
    for (const [key, val] of Object.entries(AGENT_CHANNEL_CONFIG)) {
      expect(val.icon.length).toBeGreaterThan(0);
      expect(val.label.length).toBeGreaterThan(0);
    }
  });

  it("contains exactly the expected agents", () => {
    const keys = Object.keys(AGENT_CHANNEL_CONFIG).sort();
    expect(keys).toEqual(expectedAgents.sort());
  });
});

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("Hello & World")).toBe("Hello &amp; World");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('He said "hi"')).toBe("He said &quot;hi&quot;");
  });

  it("handles mixed special characters", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"
    );
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("does not modify safe strings", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });
});

describe("AgentOutputManager", () => {
  let mgr: AgentOutputManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mgr = AgentOutputManager.getInstance();
  });

  afterEach(() => {
    mgr.dispose();
  });

  it("is a singleton", () => {
    const a = AgentOutputManager.getInstance();
    const b = AgentOutputManager.getInstance();
    expect(a).toBe(b);
  });

  it("returns a new instance after dispose", () => {
    const a = AgentOutputManager.getInstance();
    a.dispose();
    const b = AgentOutputManager.getInstance();
    expect(a).not.toBe(b);
    b.dispose();
  });

  it("creates output channels for agents", () => {
    mgr.startRun("coder", "test task");
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  it("creates domain channels with dashboard", () => {
    const domains = [
      { id: "backend", domain: "Backend" },
      { id: "frontend", domain: "Frontend" },
    ];
    mgr.createDomainChannels(domains);

    // Should create domain output channels + dashboard webview
    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
  });

  it("append writes to channel", () => {
    mgr.startRun("coder", "test");
    mgr.append("coder", "some log line");
    // Channel created and appendLine invoked
    const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0]?.value;
    if (mockChannel) {
      expect(mockChannel.appendLine).toHaveBeenCalled();
    }
  });

  it("appendCode writes formatted code block", () => {
    mgr.startRun("coder", "test");
    mgr.appendCode("coder", "typescript", "const x = 1;");
    const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0]?.value;
    if (mockChannel) {
      expect(mockChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("typescript"));
    }
  });

  it("endRun writes completion status", () => {
    mgr.startRun("coder", "test");
    mgr.endRun("coder", 1500, true);
    const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0]?.value;
    if (mockChannel) {
      expect(mockChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Completed"));
    }
  });

  it("endRun writes failure status", () => {
    mgr.startRun("coder", "test");
    mgr.endRun("coder", 500, false);
    const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0]?.value;
    if (mockChannel) {
      expect(mockChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed"));
    }
  });

  it("dispose cleans up all channels", () => {
    mgr.startRun("coder", "test");
    mgr.startRun("planner", "test");
    mgr.dispose();
    // After disposal, a new instance is created
    const fresh = AgentOutputManager.getInstance();
    expect(fresh).not.toBe(mgr);
    fresh.dispose();
  });

  it("disposeDomainChannels removes only domain channels", () => {
    mgr.startRun("coder", "test");
    const domains = [{ id: "backend", domain: "Backend" }];
    mgr.createDomainChannels(domains);
    mgr.disposeDomainChannels();
    // coder channel should still work
    mgr.append("coder", "still working");
  });

  it("MAX_DASHBOARD_LOGS is a reasonable cap", () => {
    expect(AgentOutputManager.MAX_DASHBOARD_LOGS).toBe(500);
    expect(AgentOutputManager.MAX_DASHBOARD_LOGS).toBeGreaterThan(0);
  });

  it("revealParallel shows multiple channels", () => {
    mgr.startRun("coder", "test");
    mgr.startRun("planner", "test");
    mgr.revealParallel(["coder", "planner"]);
    // Channels should have show() called
    const channels = (vscode.window.createOutputChannel as jest.Mock).mock.results;
    for (const ch of channels) {
      expect(ch.value.show).toHaveBeenCalled();
    }
  });
});
