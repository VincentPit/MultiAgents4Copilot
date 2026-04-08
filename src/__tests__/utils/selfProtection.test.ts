/**
 * Tests for the self-protection module that prevents the extension
 * from modifying its own source files.
 */

import {
  registerExtensionRoot,
  getExtensionRootPath,
  isExtensionOwnFile,
  isWorkspaceTheExtension,
  filterSelfFromFileTree,
  selfProtectionBlockReason,
} from "../../utils/selfProtection";

// ── Setup ────────────────────────────────────────────────────────────

// Reset the module state before each test
beforeEach(() => {
  // Re-register with a known path for consistent tests
  registerExtensionRoot("/Users/dev/MultiAgentCopilt");
});

// ── registerExtensionRoot / getExtensionRootPath ─────────────────────

describe("registerExtensionRoot", () => {
  it("stores the extension root path", () => {
    registerExtensionRoot("/test/extension");
    expect(getExtensionRootPath()).toBe("/test/extension");
  });

  it("normalises the path", () => {
    registerExtensionRoot("/test/extension/");
    // path.resolve strips trailing slashes
    expect(getExtensionRootPath()).toBe("/test/extension");
  });
});

// ── isExtensionOwnFile ──────────────────────────────────────────────

describe("isExtensionOwnFile", () => {
  const extRoot = "/Users/dev/MultiAgentCopilt";

  beforeEach(() => {
    registerExtensionRoot(extRoot);
  });

  it("detects absolute paths inside the extension root", () => {
    expect(isExtensionOwnFile(`${extRoot}/src/agents/coder.ts`, "/some/workspace")).toBe(true);
    expect(isExtensionOwnFile(`${extRoot}/src/extension.ts`, "/some/workspace")).toBe(true);
    expect(isExtensionOwnFile(`${extRoot}/package.json`, "/some/workspace")).toBe(true);
  });

  it("does NOT flag files outside the extension root", () => {
    expect(isExtensionOwnFile("/other/project/src/index.ts", "/other/project")).toBe(false);
    expect(isExtensionOwnFile("/tmp/test.ts", "/tmp")).toBe(false);
  });

  it("detects relative paths when workspace IS the extension", () => {
    // When workspace root === extension root
    expect(isExtensionOwnFile("src/agents/coder.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/graph/builder.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/extension.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/utils/fileWriter.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/security/securityConfig.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/types/index.ts", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/go-worker/main.go", extRoot)).toBe(true);
    expect(isExtensionOwnFile("src/go-worker/worker.go", extRoot)).toBe(true);
    expect(isExtensionOwnFile("out/extension.js", extRoot)).toBe(true);
    expect(isExtensionOwnFile("package.json", extRoot)).toBe(true);
    expect(isExtensionOwnFile("tsconfig.json", extRoot)).toBe(true);
  });

  it("allows non-extension files even when workspace IS the extension", () => {
    // User might have a sub-project or something the agents should write to
    expect(isExtensionOwnFile("playground/test.ts", extRoot)).toBe(false);
    expect(isExtensionOwnFile("examples/demo.js", extRoot)).toBe(false);
  });

  it("detects files when workspace matches by directory name", () => {
    registerExtensionRoot("/completely/different/path");
    // Even though the registered root is different, the workspace dir name matches
    expect(isExtensionOwnFile("src/agents/coder.ts", "/Users/foo/MultiAgentCopilt")).toBe(true);
    expect(isExtensionOwnFile("src/extension.ts", "/Users/foo/MultiAgents4Copilot")).toBe(true);
  });
});

// ── isWorkspaceTheExtension ─────────────────────────────────────────

describe("isWorkspaceTheExtension", () => {
  it("matches when workspace root equals the registered extension root", () => {
    registerExtensionRoot("/Users/dev/MyExtension");
    expect(isWorkspaceTheExtension("/Users/dev/MyExtension")).toBe(true);
  });

  it("matches known directory names (case-insensitive)", () => {
    registerExtensionRoot("/irrelevant/path");
    expect(isWorkspaceTheExtension("/Users/foo/MultiAgentCopilt")).toBe(true);
    expect(isWorkspaceTheExtension("/Users/foo/multi-agent-copilot")).toBe(true);
    expect(isWorkspaceTheExtension("/Users/foo/MultiAgents4Copilot")).toBe(true);
  });

  it("returns false for unrelated workspace roots", () => {
    registerExtensionRoot("/Users/dev/MyExtension");
    expect(isWorkspaceTheExtension("/Users/dev/SomeOtherProject")).toBe(false);
    expect(isWorkspaceTheExtension("/tmp/workspace")).toBe(false);
  });
});

// ── filterSelfFromFileTree ──────────────────────────────────────────

describe("filterSelfFromFileTree", () => {
  it("leaves the tree unchanged for non-extension workspaces", () => {
    registerExtensionRoot("/Users/dev/MyExtension");
    const tree = "📁 src/\n  📄 index.ts\n  📄 app.ts";
    expect(filterSelfFromFileTree(tree, "/Users/dev/OtherProject")).toBe(tree);
  });

  it("filters extension source paths when workspace IS the extension", () => {
    registerExtensionRoot("/Users/dev/MultiAgentCopilt");
    const tree = [
      "📁 src/",
      "  📁 agents/",
      "  📁 graph/",
      "  📁 utils/",
      "  📁 go-worker/",
      "  📄 extension.ts",
      "📁 examples/",
      "  📄 demo.ts",
      "📄 package.json",
    ].join("\n");

    const filtered = filterSelfFromFileTree(tree, "/Users/dev/MultiAgentCopilt");
    // Extension source dirs/files should be removed
    expect(filtered).not.toContain("agents");
    expect(filtered).not.toContain("graph");
    expect(filtered).not.toContain("utils");
    expect(filtered).not.toContain("go-worker");
    expect(filtered).not.toContain("extension.ts");
    expect(filtered).not.toContain("package.json");
    // Non-extension items should remain
    expect(filtered).toContain("examples");
    expect(filtered).toContain("demo.ts");
  });
});

// ── selfProtectionBlockReason ───────────────────────────────────────

describe("selfProtectionBlockReason", () => {
  it("returns a human-readable block reason", () => {
    const reason = selfProtectionBlockReason("src/agents/coder.ts");
    expect(reason).toContain("BLOCKED");
    expect(reason).toContain("src/agents/coder.ts");
    expect(reason).toContain("Multi-Agent Copilot");
  });
});
