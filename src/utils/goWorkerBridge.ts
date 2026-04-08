/**
 * Go Worker Bridge — manages the Go child process for true parallel
 * domain coder execution.
 *
 * This module spawns the Go worker binary, handles bidirectional JSON-RPC
 * communication over stdin/stdout, and routes requests to the appropriate
 * VS Code APIs (LLM calls, file writes, test execution).
 *
 * Architecture:
 *   TS Extension ←→ Go Worker Process (goroutines)
 *   - stdin:  TS → Go (init config, LLM responses, test results)
 *   - stdout: Go → TS (LLM requests, file writes, logs, results)
 *   - stderr: Go → TS (crash logs, panics)
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { logger } from "./logger";
import { callModel, buildMessages, capContext } from "../agents/base";
import { applyCodeToWorkspace } from "./fileWriter";
import { runQualityGate, type QualityGateResult, formatQualityReportForLLM } from "./qualityGate";
import { showBatchDiffs } from "./diffViewer";
import { AgentOutputManager } from "./agentOutputManager";
import type { DomainAssignment, AgentState } from "../graph/state";

// ── Types mirroring the Go protocol ──────────────────────────────────

interface GoWorkerResult {
  domainId: string;
  domain: string;
  filesWritten: string[];
  testsPassed: boolean;
  testOutput: string;
  errors: string[];
  durationMs: number;
  fixAttempts: number;
  code: string;
}

interface GoMessage {
  type: string;
  id?: string;
  workerId?: string;
  [key: string]: any;
}

// ── Go binary resolution ─────────────────────────────────────────────

/** Find the Go worker binary — compiled binary or compile on-demand. */
export async function resolveGoWorkerBinary(extensionPath: string): Promise<string | null> {
  // Check for pre-compiled binary
  const binaryName = process.platform === "win32" ? "go-worker.exe" : "go-worker";
  const precompiled = path.join(extensionPath, "out", binaryName);
  if (fs.existsSync(precompiled)) {
    return precompiled;
  }

  // Try to compile on demand from source
  const goSrc = path.join(extensionPath, "src", "go-worker");
  if (!fs.existsSync(path.join(goSrc, "go.mod"))) {
    logger.warn("go-bridge", "Go source not found — falling back to JS coders");
    return null;
  }

  // Check if `go` command is available
  try {
    cp.execSync("go version", { stdio: "pipe", timeout: 5000 });
  } catch {
    logger.warn("go-bridge", "Go not installed — falling back to JS coders");
    return null;
  }

  // Compile the binary
  const outDir = path.join(extensionPath, "out");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, binaryName);
  logger.info("go-bridge", `Compiling Go worker: ${goSrc} → ${outPath}`);

  try {
    cp.execSync(`go build -o "${outPath}" .`, {
      cwd: goSrc,
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    logger.info("go-bridge", "Go worker compiled successfully");
    return outPath;
  } catch (err: any) {
    logger.error("go-bridge", `Go compilation failed: ${err?.stderr?.toString() ?? err}`);
    return null;
  }
}

// ── GoWorkerBridge class ─────────────────────────────────────────────

export class GoWorkerBridge {
  private proc: cp.ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private model: vscode.LanguageModelChat;
  private state: AgentState;
  private stream: vscode.ChatResponseStream;
  private token: vscode.CancellationToken;
  private outputMgr: AgentOutputManager;
  private extensionPath: string;

  // Event callbacks
  private onWorkerDone?: (result: GoWorkerResult) => void;
  private allDoneResolve?: (results: GoWorkerResult[]) => void;
  private allDoneReject?: (err: Error) => void;

  constructor(
    extensionPath: string,
    model: vscode.LanguageModelChat,
    state: AgentState,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) {
    this.extensionPath = extensionPath;
    this.model = model;
    this.state = state;
    this.stream = stream;
    this.token = token;
    this.outputMgr = AgentOutputManager.getInstance();
  }

  /**
   * Check if Go worker binary is available.
   * Returns true if the binary can be resolved (pre-compiled or compilable).
   */
  static async isAvailable(extensionPath: string): Promise<boolean> {
    const binary = await resolveGoWorkerBinary(extensionPath);
    return binary !== null;
  }

  /**
   * Launch the Go worker process and send domain assignments.
   * Returns a Promise that resolves with all worker results when done.
   */
  async run(
    domains: DomainAssignment[],
    task: string,
    plan: string[],
    maxRetries: number = 2,
    onWorkerDone?: (result: GoWorkerResult) => void,
    scaffoldFiles?: string[],
    scaffoldCode?: string,
  ): Promise<GoWorkerResult[]> {
    this.onWorkerDone = onWorkerDone;

    const binary = await resolveGoWorkerBinary(this.extensionPath);
    if (!binary) {
      throw new Error("Go worker binary not available");
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    return new Promise<GoWorkerResult[]>((resolve, reject) => {
      this.allDoneResolve = resolve;
      this.allDoneReject = reject;

      // Spawn the Go process
      this.proc = cp.spawn(binary, [], {
        cwd: wsRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GOMAXPROCS: String(require("os").cpus().length) },
      });

      // Handle stderr (Go panics, debug logs)
      let stderrBuf = "";
      this.proc.stderr?.on("data", (data: Buffer) => {
        stderrBuf += data.toString();
        logger.warn("go-worker-stderr", data.toString().trim());
      });

      // Handle process exit
      this.proc.on("exit", (code, signal) => {
        logger.info("go-bridge", `Go worker exited (code=${code}, signal=${signal})`);
        if (code !== 0 && this.allDoneReject) {
          this.allDoneReject(new Error(
            `Go worker crashed (code=${code}): ${stderrBuf.slice(-500)}`
          ));
        }
        this.cleanup();
      });

      this.proc.on("error", (err) => {
        logger.error("go-bridge", `Go worker spawn error: ${err.message}`);
        if (this.allDoneReject) {
          this.allDoneReject(err);
        }
        this.cleanup();
      });

      // Set up stdout JSON line reader
      this.rl = readline.createInterface({
        input: this.proc.stdout!,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line: string) => {
        this.handleMessage(line, domains, task, plan, maxRetries, wsRoot, scaffoldFiles, scaffoldCode);
      });

      // Handle cancellation
      if (this.token.isCancellationRequested) {
        this.kill();
        reject(new Error("Cancelled"));
        return;
      }

      this.token.onCancellationRequested(() => {
        this.kill();
        reject(new Error("Cancelled"));
      });
    });
  }

  /** Handle a JSON message from the Go worker's stdout. */
  private async handleMessage(
    line: string,
    domains: DomainAssignment[],
    task: string,
    plan: string[],
    maxRetries: number,
    wsRoot: string,
    scaffoldFiles?: string[],
    scaffoldCode?: string,
  ): Promise<void> {
    let msg: GoMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn("go-bridge", `Invalid JSON from Go worker: ${line.slice(0, 100)}`);
      return;
    }

    switch (msg.type) {
      case "ready":
        // Go worker is ready — send init message with scaffold context
        this.sendToWorker({
          type: "init",
          domains: domains,
          task: task,
          workspaceRoot: wsRoot,
          plan: plan,
          maxFixRetries: maxRetries,
          scaffoldFiles: scaffoldFiles ?? [],
          scaffoldCode: scaffoldCode ?? "",
        });
        break;

      case "llm_request":
        await this.handleLLMRequest(msg);
        break;

      case "file_write":
        await this.handleFileWrite(msg);
        break;

      case "test_request":
        await this.handleTestRequest(msg, wsRoot);
        break;

      case "log":
        this.handleLog(msg);
        break;

      case "worker_done":
        if (this.onWorkerDone && msg["result"]) {
          this.onWorkerDone(msg["result"] as GoWorkerResult);
        }
        break;

      case "all_done":
        if (this.allDoneResolve && msg["results"]) {
          this.allDoneResolve(msg["results"] as GoWorkerResult[]);
          this.allDoneResolve = undefined;
          this.allDoneReject = undefined;
        }
        break;

      default:
        logger.warn("go-bridge", `Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Handle LLM request from Go worker.
   * Builds the full prompt (adding workspace context), calls vscode.lm,
   * and sends the response back.
   */
  private async handleLLMRequest(msg: GoMessage): Promise<void> {
    const { id, workerId, systemPrompt, userMessage } = msg;

    this.outputMgr.append(`domain:${workerId}`, "🤖 Requesting code generation...");

    try {
      const messages = buildMessages({
        systemPrompt: systemPrompt,
        workspaceContext: this.state.workspaceContext,
        references: this.state.references,
        chatHistory: this.state.chatHistory,
        userQuestion: userMessage,
        maxSystemChars: 14_000,
        maxWorkspaceChars: 6_000,
        maxReferencesChars: 8_000,
      });

      const response = await callModel(
        this.model, messages, null, this.token, `go-worker:${workerId}`
      );

      this.sendToWorker({
        type: "llm_response",
        id: id,
        content: response,
      });
    } catch (err: any) {
      this.sendToWorker({
        type: "llm_response",
        id: id,
        content: "",
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Handle file write request from Go worker.
   * Uses the existing applyCodeToWorkspace infrastructure for safety guards.
   */
  private async handleFileWrite(msg: GoMessage): Promise<void> {
    const { id, workerId, filePath, content, language } = msg;

    try {
      // Reconstruct LLM-style output for the existing parser
      const fakeOutput = `### \`${filePath}\`\n\`\`\`${language || "typescript"}\n${content}\n\`\`\``;
      const result = await applyCodeToWorkspace(fakeOutput, this.stream);

      if (result.written.length > 0) {
        await showBatchDiffs(result.written, result.oldContents);
        this.outputMgr.append(`domain:${workerId}`, `📁 Wrote: ${filePath}`);
      }

      this.sendToWorker({
        type: "file_write_response",
        id: id,
        success: result.written.length > 0,
        error: result.skipped.length > 0 ? result.skipped[0].reason : undefined,
      });
    } catch (err: any) {
      this.sendToWorker({
        type: "file_write_response",
        id: id,
        success: false,
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Handle test request from Go worker.
   * Runs quality gate (build + lint + tests) scoped to the worker's files.
   */
  private async handleTestRequest(msg: GoMessage, wsRoot: string): Promise<void> {
    const { id, workerId, files } = msg;

    this.outputMgr.append(`domain:${workerId}`, `🧪 Running tests for: ${files?.join(", ") ?? "all"}`);

    try {
      const qaResult: QualityGateResult = await runQualityGate(wsRoot, files ?? []);

      const output = qaResult.passed
        ? `✅ All checks passed: ${qaResult.summary}`
        : `❌ Quality gate failed: ${qaResult.summary}\n${formatQualityReportForLLM(qaResult)}`;

      this.sendToWorker({
        type: "test_response",
        id: id,
        passed: qaResult.passed,
        output: output,
      });
    } catch (err: any) {
      this.sendToWorker({
        type: "test_response",
        id: id,
        passed: false,
        output: `Test execution error: ${err?.message ?? String(err)}`,
        error: err?.message ?? String(err),
      });
    }
  }

  /** Handle log message from Go worker — route to per-domain output channel. */
  private handleLog(msg: GoMessage): void {
    const { workerId, level, message } = msg;
    const channelName = workerId === "main" || workerId === "bridge"
      ? "coder_pool"
      : `domain:${workerId}`;

    this.outputMgr.append(channelName, `[${level?.toUpperCase() ?? "INFO"}] ${message}`);

    // Also show important logs in the chat stream
    if (level === "error") {
      this.stream.markdown(`> ⚠️ **${workerId}**: ${message}\n`);
    }
  }

  /** Send a JSON message to the Go worker's stdin. */
  private sendToWorker(msg: any): void {
    if (this.proc?.stdin?.writable) {
      const line = JSON.stringify(msg) + "\n";
      this.proc.stdin.write(line);
    }
  }

  /** Kill the Go worker process. */
  kill(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  /** Clean up resources. */
  private cleanup(): void {
    this.rl?.close();
    this.rl = null;
    this.proc = null;
  }
}
