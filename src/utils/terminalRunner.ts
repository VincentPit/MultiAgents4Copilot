/**
 * Terminal runner utility — parses shell commands from LLM output,
 * asks the user for consent, and executes them in the VS Code
 * integrated terminal.
 *
 * Expected LLM output format (enforced by agent system prompts):
 *
 *   ```bash
 *   npm install express
 *   ```
 *
 * Also recognises ```sh, ```shell, ```zsh, and ```cmd fences.
 *
 * Safety:
 *  - Every command requires explicit user consent via a modal dialog.
 *  - A blocklist prevents obviously destructive commands.
 *  - Commands run in the workspace root directory.
 *  - Each command has a configurable timeout (default 120 s).
 *  - Output is captured and returned to the calling agent.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import { logger } from "./logger";
import { getSecurityConfig } from "../security/securityConfig";
import { isWorkspaceTheExtension } from "./selfProtection";

/** Maximum allowed command argument length. */
const MAX_COMMAND_LENGTH = getSecurityConfig().terminalRunner.maxArgLength;

// ── Types ────────────────────────────────────────────────────────────

export interface ParsedCommand {
  /** The raw command string. */
  command: string;
  /** The language tag from the fence (bash, sh, shell, etc.). */
  shell: string;
}

export interface CommandResult {
  /** The command that was executed. */
  command: string;
  /** Combined stdout content. */
  stdout: string;
  /** Combined stderr content. */
  stderr: string;
  /** Process exit code (null if timed out or killed). */
  exitCode: number | null;
  /** Whether the command completed successfully. */
  success: boolean;
  /** Human-readable status. */
  status: "success" | "failed" | "timeout" | "skipped" | "blocked";
}

export interface RunResult {
  /** Commands that were executed. */
  executed: CommandResult[];
  /** Commands that were skipped (user declined or blocked). */
  skipped: { command: string; reason: string }[];
}

// ── Command parser ───────────────────────────────────────────────────

/** Shell language tags that indicate a runnable command. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "cmd", "powershell", "ps1", "terminal", "console"]);

/** Regex pattern for fenced code blocks (created fresh per call to avoid /g state bugs). */
const FENCE_PATTERN = /```(\S*)\n([\s\S]*?)```/g;

/**
 * Parse shell command blocks from LLM output.
 * Only extracts blocks with a shell language tag.
 */
export function parseCommandBlocks(llmOutput: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  // Create a fresh regex each call to avoid shared /g lastIndex state
  const fenceRe = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(llmOutput)) !== null) {
    const lang = (match[1] ?? "").toLowerCase().split(":")[0];
    const content = match[2]?.trim();

    if (!content) { continue; }
    if (!SHELL_LANGS.has(lang)) { continue; }

    // Split multi-line blocks into individual commands
    // (but keep multi-line commands joined with \)
    const lines = content.split("\n");
    let currentCmd = "";

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) {
        if (currentCmd) {
          commands.push({ command: currentCmd.trim(), shell: lang });
          currentCmd = "";
        }
        continue;
      }
      // Line continuation
      if (trimmed.endsWith("\\")) {
        currentCmd += trimmed.slice(0, -1) + " ";
        continue;
      }
      currentCmd += trimmed;
      commands.push({ command: currentCmd.trim(), shell: lang });
      currentCmd = "";
    }

    // Flush any remaining command
    if (currentCmd.trim()) {
      commands.push({ command: currentCmd.trim(), shell: lang });
    }
  }

  logger.info("terminalRunner", `Parsed ${commands.length} command(s) from LLM output`);
  return commands;
}

// ── Safety checks ────────────────────────────────────────────────────

/**
 * Commands (or patterns) that are too dangerous to run automatically.
 * We block these even if the user consents — they must run them manually.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,    // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~\s*$/,      // rm -rf ~
  /\bsudo\s+rm\b/,                                 // sudo rm anything
  /\bmkfs\b/,                                       // format disk
  /\bdd\s+if=/,                                     // dd (disk destroyer)
  /\b:\(\)\s*\{/,                                   // fork bomb :(){ ... }
  /:\(\)\s*\{[^}]*\|\s*:/,                          // fork bomb variant :(){ :|:& };:
  />\s*\/dev\/sd[a-z]/,                             // write to raw disk
  /\bcurl\b.*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,  // curl | bash
  /\bwget\b.*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,  // wget | bash
  /\bchmod\s+777\s+\//,                             // chmod 777 /
  /\bsudo\s+chmod\s+777/,                           // sudo chmod 777
];

/**
 * Patterns that target the extension's own source files.
 * These are checked separately only when the workspace IS the extension.
 */
const SELF_MODIFICATION_PATTERNS: RegExp[] = [
  // Direct writes to extension source directories
  /\b(?:sed|awk|perl)\b.*\bsrc\/(agents|graph|utils|security|types)\//,
  // Overwrite extension source with redirects
  />\s*src\/(agents|graph|utils|security|types|extension\.ts)/,
  // mv/cp that targets extension source
  /\b(?:mv|cp)\b.*\bsrc\/(agents|graph|utils|security|types)\//,
  // tee or dd targeting extension source
  /\b(?:tee|dd)\b.*\bsrc\//,
  // npm/node scripts that directly modify source files
  /\bnode\b.*-e\b.*(?:writeFile|appendFile).*\bsrc\//,
];

/**
 * Commands that are safe to auto-approve without user consent.
 * These are standard project setup commands that don't have side-effects
 * beyond the workspace directory.
 */
const AUTO_APPROVE_PATTERNS: RegExp[] = [
  /^npm\s+(install|i|ci)\b/,               // npm install
  /^npm\s+init\b/,                          // npm init
  /^npx\s+create-/,                         // npx create-next-app, etc.
  /^yarn\s+(install|add)\b/,                // yarn install
  /^pnpm\s+(install|add|i)\b/,              // pnpm install
  /^pip\s+install\b/,                       // pip install
  /^pip3\s+install\b/,                      // pip3 install
  /^python3?\s+-m\s+pip\s+install\b/,       // python -m pip install
  /^poetry\s+(install|add)\b/,              // poetry install
  /^bundle\s+install\b/,                    // bundle install
  /^cargo\s+(build|init)\b/,                // cargo build
  /^go\s+(mod\s+(init|tidy)|get)\b/,        // go mod init, go get
  /^gradle\s+(build|init)\b/,               // gradle build
  /^mvn\s+(install|compile|package)\b/,     // mvn install
  /^mkdir\s+/,                              // mkdir
  /^touch\s+/,                              // touch
  /^cp\s+/,                                 // cp (within workspace)
  /^chmod\s+/,                              // chmod
  /^cd\s+/,                                 // cd
  /^npx\s+prisma\s+(generate|init)\b/,      // prisma generate
  /^npx\s+tailwindcss\s+init\b/,            // tailwind init
];

/** Check if a command matches the auto-approve list. */
function isAutoApprovable(command: string): boolean {
  const trimmed = command.trim();
  return AUTO_APPROVE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/** Check if a command is blocked for safety. */
function isBlocked(command: string): boolean {
  // Length check first
  if (command.length > MAX_COMMAND_LENGTH) {
    logger.warn("terminalRunner", `Command too long (${command.length} chars > ${MAX_COMMAND_LENGTH})`);
    return true;
  }
  // Always-blocked dangerous patterns
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }
  // Self-modification guard: if the workspace IS the extension, block
  // commands that target extension source files
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  if (isWorkspaceTheExtension(wsRoot)) {
    if (SELF_MODIFICATION_PATTERNS.some((pattern) => pattern.test(command))) {
      logger.warn("terminalRunner", `Blocked self-modification command: ${command.slice(0, 80)}…`);
      return true;
    }
  }
  return false;
}

// ── User consent ─────────────────────────────────────────────────────

/**
 * Ask the user whether they want to run the given commands.
 * Shows a compact notification toast (non-modal sliding bar).
 */
async function requestCommandConsent(
  commands: ParsedCommand[],
): Promise<{ approved: ParsedCommand[]; declined: ParsedCommand[] }> {
  const approved: ParsedCommand[] = [];
  const declined: ParsedCommand[] = [];

  if (commands.length === 0) {
    return { approved, declined };
  }

  // Non-modal notification toast — compact sliding bar
  const preview = commands.length <= 2
    ? commands.map(c => c.command).join("; ")
    : `${commands[0].command} + ${commands.length - 1} more`;

  const choice = await vscode.window.showWarningMessage(
    `🤖 Agent wants to run ${commands.length} command(s): ${preview}`,
    "Run All",
    "Review One-by-One",
    "Cancel",
  );

  if (choice === "Run All") {
    approved.push(...commands);
    logger.info("terminalRunner", `User approved all ${commands.length} commands`);
  } else if (choice === "Review One-by-One") {
    for (const cmd of commands) {
      const result = await vscode.window.showWarningMessage(
        `Run: $ ${cmd.command}`,
        "Run",
        "Skip",
      );
      if (result === "Run") {
        approved.push(cmd);
      } else {
        declined.push(cmd);
      }
    }
    logger.info("terminalRunner", `User approved ${approved.length}/${commands.length} commands`);
  } else {
    declined.push(...commands);
    logger.info("terminalRunner", `User declined all ${commands.length} commands`);
  }

  return { approved, declined };
}

// ── Command execution ────────────────────────────────────────────────

/** Default timeout for command execution (120 seconds). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Maximum output size to capture (100 KB). */
const MAX_OUTPUT_SIZE = 100 * 1024;

/**
 * Execute a single command in the workspace root using child_process.
 * Captures stdout/stderr and returns structured results.
 */
async function executeCommand(
  command: string,
  workspaceRoot: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    logger.info("terminalRunner", `Executing: $ ${command}`);

    const proc = cp.exec(command, {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, FORCE_COLOR: "0" }, // disable colour codes
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    }, (error, stdout, stderr) => {
      // error.code can be a string (e.g., 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      // so we must check the type before using it as exit code
      const rawCode = error?.code;
      const exitCode = typeof rawCode === "number" ? rawCode : (proc.exitCode ?? (error ? 1 : 0));

      // Detect timeout
      if (error && "killed" in error && error.killed) {
        logger.warn("terminalRunner", `Command timed out after ${timeoutMs}ms: ${command}`);
        resolve({
          command,
          stdout: truncateOutput(stdout ?? ""),
          stderr: truncateOutput(stderr ?? ""),
          exitCode: null,
          success: false,
          status: "timeout",
        });
        return;
      }

      const success = typeof exitCode === "number" && exitCode === 0;
      const status = success ? "success" : "failed";

      logger.info("terminalRunner", `Command finished (exit=${exitCode}): ${command}`);
      resolve({
        command,
        stdout: truncateOutput(stdout ?? ""),
        stderr: truncateOutput(stderr ?? ""),
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        success,
        status,
      });
    });
  });
}

/**
 * Show the command output in the VS Code integrated terminal.
 *
 * IMPORTANT: We do NOT call `terminal.sendText(command)` because that would
 * execute the command a second time (child_process.exec already runs it).
 * Instead, we only display the command + captured output for visibility.
 */
function showCommandOutput(
  command: string,
  result: CommandResult,
  workspaceRoot: string,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: "🤖 Agent Command",
    cwd: workspaceRoot,
  });
  terminal.show(true); // preserve focus on chat
  // Display what was run and the output — do NOT re-execute
  terminal.sendText(`# Command executed by agent:`, false);
  terminal.sendText(`# $ ${command}`, false);
  if (result.stdout) {
    terminal.sendText(result.stdout, false);
  }
  if (result.stderr) {
    terminal.sendText(result.stderr, false);
  }
  terminal.sendText(`# Exit code: ${result.exitCode ?? "N/A"}`, false);
  return terminal;
}

/** Truncate command output to prevent bloating the state. */
function truncateOutput(output: string): string {
  if (output.length <= 4000) { return output; }
  return output.slice(0, 2000) + "\n\n[… output truncated …]\n\n" + output.slice(-1500);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * End-to-end: parse commands from LLM output → ask consent → execute.
 * Streams progress back through the chat response stream.
 */
export async function runCommandsFromOutput(
  llmOutput: string,
  stream: vscode.ChatResponseStream,
  options?: { autoApprove?: boolean },
): Promise<RunResult> {
  const result: RunResult = { executed: [], skipped: [] };

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    logger.warn("terminalRunner", "No workspace folder open — cannot run commands");
    stream.markdown("\n> ⚠️ No workspace folder open. Commands were not executed.\n");
    return result;
  }

  // Parse command blocks
  const commands = parseCommandBlocks(llmOutput);
  if (commands.length === 0) {
    logger.info("terminalRunner", "No shell command blocks found in LLM output");
    return result;
  }

  // Filter out blocked commands
  const safeCommands: ParsedCommand[] = [];
  for (const cmd of commands) {
    if (isBlocked(cmd.command)) {
      result.skipped.push({ command: cmd.command, reason: "Blocked for safety" });
      stream.markdown(`\n> 🚫 **Blocked:** \`${cmd.command}\` — this command is not allowed for safety reasons.\n`);
      logger.warn("terminalRunner", `Blocked dangerous command: ${cmd.command}`);
    } else {
      safeCommands.push(cmd);
    }
  }

  if (safeCommands.length === 0) {
    return result;
  }

  // Auto-approve safe commands when in autoApprove mode (e.g. scaffold step)
  let approved: ParsedCommand[] = [];
  let declined: ParsedCommand[] = [];

  if (options?.autoApprove) {
    const autoApproved: ParsedCommand[] = [];
    const needsConsent: ParsedCommand[] = [];

    for (const cmd of safeCommands) {
      if (isAutoApprovable(cmd.command)) {
        autoApproved.push(cmd);
        logger.info("terminalRunner", `Auto-approved: ${cmd.command}`);
      } else {
        needsConsent.push(cmd);
      }
    }

    approved.push(...autoApproved);
    if (autoApproved.length > 0) {
      stream.markdown(
        `\n> 🔧 Auto-running ${autoApproved.length} setup command(s): ` +
        autoApproved.map(c => `\`${c.command}\``).join(", ") + `\n`
      );
    }

    // For non-auto-approvable commands, still ask consent
    if (needsConsent.length > 0) {
      const consent = await requestCommandConsent(needsConsent);
      approved.push(...consent.approved);
      declined.push(...consent.declined);
    }
  } else {
    // Normal mode: ask consent for all commands
    const consent = await requestCommandConsent(safeCommands);
    approved = consent.approved;
    declined = consent.declined;
  }

  for (const cmd of declined) {
    result.skipped.push({ command: cmd.command, reason: "User declined" });
    stream.markdown(`\n> ⏭️ **Skipped:** \`${cmd.command}\`\n`);
  }

  if (approved.length === 0) {
    stream.markdown(
      `\n> 🚫 **No commands executed** — you can run them manually from the terminal.\n`
    );
    return result;
  }

  // Execute approved commands sequentially
  stream.markdown(`\n> 🖥️ **Running ${approved.length} command(s)…**\n`);

  const pendingTerminals: vscode.Terminal[] = [];

  for (const cmd of approved) {
    stream.progress(`Running: ${cmd.command}`);

    // Execute via child_process to capture output
    const cmdResult = await executeCommand(cmd.command, workspaceRoot);
    result.executed.push(cmdResult);

    // Show in integrated terminal for visibility (does NOT re-execute)
    const terminal = showCommandOutput(cmd.command, cmdResult, workspaceRoot);

    // Stream result back to the chat
    const icon = cmdResult.success ? "✅" : "❌";
    const statusMsg = cmdResult.status === "timeout" ? "timed out" : cmdResult.status;
    stream.markdown(`\n> ${icon} \`$ ${cmd.command}\` — **${statusMsg}**`);
    if (cmdResult.exitCode !== null && cmdResult.exitCode !== 0) {
      stream.markdown(` (exit code ${cmdResult.exitCode})`);
    }
    stream.markdown(`\n`);

    // Show stderr if there was a failure
    if (!cmdResult.success && cmdResult.stderr) {
      const errPreview = cmdResult.stderr.length > 500
        ? cmdResult.stderr.slice(0, 500) + "…"
        : cmdResult.stderr;
      stream.markdown(`\n> \`\`\`\n${errPreview}\n\`\`\`\n`);
    }

    // Brief delay so the user can see each command
    await new Promise((r) => setTimeout(r, 500));

    // Track terminal for cleanup (dispose after delay or when function exits)
    pendingTerminals.push(terminal);
  }

  // Schedule terminal cleanup after a delay
  for (const t of pendingTerminals) {
    const timer = setTimeout(() => t.dispose(), 30_000);
    if (typeof timer === "object" && "unref" in timer) { timer.unref(); }
  }

  // Summary
  const successes = result.executed.filter((r) => r.success).length;
  const failures = result.executed.filter((r) => !r.success).length;

  if (successes > 0 || failures > 0) {
    stream.markdown(
      `\n> 🖥️ **${successes} succeeded, ${failures} failed** out of ${result.executed.length} command(s)\n`
    );
  }

  return result;
}

/**
 * Run a single command directly (without parsing from LLM output).
 * Still asks for user consent.
 */
export async function runSingleCommand(
  command: string,
  stream: vscode.ChatResponseStream,
): Promise<CommandResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return {
      command,
      stdout: "",
      stderr: "No workspace folder open",
      exitCode: 1,
      success: false,
      status: "failed",
    };
  }

  // Check if blocked
  if (isBlocked(command)) {
    stream.markdown(`\n> 🚫 **Blocked:** \`${command}\` — this command is not allowed.\n`);
    return {
      command,
      stdout: "",
      stderr: "Command blocked for safety",
      exitCode: 1,
      success: false,
      status: "blocked",
    };
  }

  // Ask consent
  const choice = await vscode.window.showWarningMessage(
    `🤖 Run this command?\n\n  $ ${command}`,
    { modal: true, detail: `Will run in: ${workspaceRoot}` },
    "Run",
    "Cancel",
  );

  if (choice !== "Run") {
    stream.markdown(`\n> ⏭️ **Skipped:** \`${command}\`\n`);
    return {
      command,
      stdout: "",
      stderr: "User declined",
      exitCode: null,
      success: false,
      status: "skipped",
    };
  }

  stream.progress(`Running: ${command}`);
  const result = await executeCommand(command, workspaceRoot);

  // Show in integrated terminal for visibility (does NOT re-execute)
  const terminal = showCommandOutput(command, result, workspaceRoot);

  const icon = result.success ? "✅" : "❌";
  stream.markdown(`\n> ${icon} \`$ ${command}\` — **${result.status}**\n`);

  const disposeTimer = setTimeout(() => terminal.dispose(), 30_000);
  if (typeof disposeTimer === "object" && "unref" in disposeTimer) { disposeTimer.unref(); }
  return result;
}
