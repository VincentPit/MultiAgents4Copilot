/**
 * Tests for src/utils/terminalRunner.ts — command-block parser.
 */

import { parseCommandBlocks, type ParsedCommand } from "../../utils/terminalRunner";

describe("parseCommandBlocks", () => {
  it("returns empty array when there are no code blocks", () => {
    expect(parseCommandBlocks("Just some plain text.")).toEqual([]);
  });

  it("returns empty array for non-shell code blocks", () => {
    const input = "```typescript\nconsole.log('hello');\n```";
    expect(parseCommandBlocks(input)).toEqual([]);
  });

  // ── Basic parsing ─────────────────────────────────────────────────

  it("parses a single bash command", () => {
    const input = "```bash\nnpm install express\n```";
    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm install express");
    expect(cmds[0].shell).toBe("bash");
  });

  it("parses a sh-tagged block", () => {
    const input = "```sh\necho hello\n```";
    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("echo hello");
    expect(cmds[0].shell).toBe("sh");
  });

  it("parses a shell-tagged block", () => {
    const input = "```shell\npython --version\n```";
    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("python --version");
  });

  it("parses a zsh-tagged block", () => {
    const input = "```zsh\nls -la\n```";
    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("ls -la");
  });

  // ── Multiple commands in one block ────────────────────────────────

  it("splits multiple lines into separate commands", () => {
    const input = [
      "```bash",
      "npm install express",
      "npm run build",
      "npm test",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toBe("npm install express");
    expect(cmds[1].command).toBe("npm run build");
    expect(cmds[2].command).toBe("npm test");
  });

  it("skips comment lines", () => {
    const input = [
      "```bash",
      "# Install dependencies",
      "npm install",
      "# Build the project",
      "npm run build",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe("npm install");
    expect(cmds[1].command).toBe("npm run build");
  });

  it("skips empty lines", () => {
    const input = [
      "```bash",
      "npm install",
      "",
      "npm run build",
      "",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(2);
  });

  // ── Line continuations ────────────────────────────────────────────

  it("joins lines ending with backslash", () => {
    const input = [
      "```bash",
      "docker run \\",
      "  -p 3000:3000 \\",
      "  --name myapp \\",
      "  myimage:latest",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("docker run  -p 3000:3000  --name myapp  myimage:latest");
  });

  // ── Multiple blocks in one output ─────────────────────────────────

  it("parses commands from multiple shell blocks", () => {
    const input = [
      "First, install:",
      "```bash",
      "npm install",
      "```",
      "",
      "Then run:",
      "```sh",
      "npm start",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe("npm install");
    expect(cmds[1].command).toBe("npm start");
  });

  // ── Ignores non-shell blocks ──────────────────────────────────────

  it("ignores typescript blocks mixed with bash blocks", () => {
    const input = [
      "### `src/app.ts`",
      "```typescript",
      "const x = 1;",
      "```",
      "",
      "```bash",
      "npm run build",
      "```",
    ].join("\n");

    const cmds = parseCommandBlocks(input);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe("npm run build");
  });
});
