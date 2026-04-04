/**
 * Base agent utilities — model selection, fallback, and calling helpers.
 *
 * Supports multiple models through vscode.lm:
 *   • Claude Opus 4.6 — default for most agents
 *   • Gemini 3 Pro    — used by the UI designer agent
 *
 * If the primary model fails, automatically falls back to another available model.
 */

import * as vscode from "vscode";
import { logger } from "../utils/logger";

// ── Model catalogue ──────────────────────────────────────────────────

export interface ModelSpec {
  vendor: string;
  family: string;
  label: string; // human-readable name for logs/UI
}

export const MODELS = {
  claudeOpus: { vendor: "copilot", family: "claude-opus-4.6", label: "Claude Opus 4.6" } as ModelSpec,
  gemini3Pro: { vendor: "copilot", family: "gemini-3-pro",   label: "Gemini 3 Pro" }   as ModelSpec,
};

/** Default fallback order when a model isn't available. */
const FALLBACK_ORDER: ModelSpec[] = [
  MODELS.claudeOpus,
  MODELS.gemini3Pro,
];

// ── Model selection with fallback ────────────────────────────────────

/**
 * Try to get a specific model. If it's not available, walk the fallback chain.
 */
export async function selectModel(
  preferred: ModelSpec
): Promise<{ model: vscode.LanguageModelChat; spec: ModelSpec } | null> {
  // Try the preferred model first
  const [primary] = await vscode.lm.selectChatModels({
    vendor: preferred.vendor,
    family: preferred.family,
  });

  if (primary) {
    logger.info("model", `Selected ${preferred.label}`);
    return { model: primary, spec: preferred };
  }

  logger.warn("model", `${preferred.label} not available, trying fallbacks…`);

  // Walk the fallback chain
  for (const fallback of FALLBACK_ORDER) {
    if (fallback.family === preferred.family) { continue; } // skip the one that already failed
    const [fb] = await vscode.lm.selectChatModels({
      vendor: fallback.vendor,
      family: fallback.family,
    });
    if (fb) {
      logger.fallback("model-select", `${preferred.label} unavailable`, fallback.label);
      return { model: fb, spec: fallback };
    }
  }

  // Last resort: ask for ANY copilot model
  const [any] = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (any) {
    logger.fallback("model-select", `All preferred models unavailable`, "any copilot model");
    return { model: any, spec: { vendor: "copilot", family: "unknown", label: any.name } };
  }

  logger.error("model", "No language models available at all");
  return null;
}

// ── Model calling with retry + fallback ──────────────────────────────

const MAX_RETRIES = 2;

/**
 * Compute a safe token budget for a model.
 * Uses model.maxInputTokens if available, otherwise defaults conservatively.
 */
export function safeBudget(model: vscode.LanguageModelChat): number {
  const reported = (model as any).maxInputTokens;
  if (typeof reported === "number" && reported > 0) {
    // Use 75% of reported to leave room for output tokens + safety margin
    return Math.floor(reported * 0.75);
  }
  return 16000; // conservative default
}

/**
 * Call a model with automatic retry and fallback.
 * Streams tokens to the chat panel in real-time.
 */
export async function callModel(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  stream: vscode.ChatResponseStream | null,
  token: vscode.CancellationToken,
  agentName: string = "unknown"
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await model.sendRequest(messages, {}, token);
      const chunks: string[] = [];

      for await (const chunk of response.text) {
        chunks.push(chunk);
        if (stream) {
          stream.markdown(chunk);
        }
      }

      return chunks.join("");
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      const is400 = errMsg.includes("400") || errMsg.includes("Bad Request");
      logger.warn(agentName, `Attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);

      // If 400 = context too large, try truncating messages harder
      if (is400 && messages.length > 2) {
        logger.warn(agentName, "400 detected — halving message list for retry");
        const half = Math.max(2, Math.floor(messages.length / 2));
        messages = [messages[0], ...messages.slice(-half)];
      }

      if (attempt < MAX_RETRIES) {
        // Small backoff before retry
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // All retries exhausted — try a fallback model
  logger.error(agentName, `All ${MAX_RETRIES} attempts failed, trying fallback model`);

  for (const fallback of FALLBACK_ORDER) {
    const [fbModel] = await vscode.lm.selectChatModels({
      vendor: fallback.vendor,
      family: fallback.family,
    });
    if (fbModel && fbModel !== model) {
      try {
        logger.fallback(agentName, String(lastError), fallback.label);
        if (stream) {
          stream.markdown(`\n\n> ⚠️ Primary model failed — falling back to **${fallback.label}**\n\n`);
        }
        const response = await fbModel.sendRequest(messages, {}, token);
        const chunks: string[] = [];
        for await (const chunk of response.text) {
          chunks.push(chunk);
          if (stream) { stream.markdown(chunk); }
        }
        return chunks.join("");
      } catch {
        continue; // try next fallback
      }
    }
  }

  // Everything failed
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  logger.error(agentName, `All models failed: ${errMsg}`);
  throw new Error(`Agent "${agentName}" failed after ${MAX_RETRIES} retries and all fallbacks: ${errMsg}`);
}

// ── Message builders ─────────────────────────────────────────────────

export function sysMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.User(`[SYSTEM INSTRUCTIONS]\n${content}`);
}

export function userMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.User(content);
}

export function assistantMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.Assistant(content);
}

// ── Message truncation ───────────────────────────────────────────────

/**
 * Estimate token count (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract text from a LanguageModelChatMessage (handles different internal shapes). */
function messageText(msg: vscode.LanguageModelChatMessage): string {
  // The VS Code API stores parts as LanguageModelTextPart[]
  try {
    const parts = (msg as any).content ?? (msg as any)._parts ?? (msg as any).parts ?? [];
    if (Array.isArray(parts)) {
      return parts.map((p: any) => p?.value ?? p?.text ?? (typeof p === "string" ? p : "")).join("");
    }
    if (typeof parts === "string") { return parts; }
  } catch { /* fallback */ }
  return "";
}

/**
 * Hard-truncate a single string to fit a token budget.
 */
function truncateText(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) { return text; }
  return text.slice(0, maxChars) + "\n[… truncated to fit context window]";
}

/**
 * Truncate a message list to fit within a token budget.
 *
 * Strategy:
 * 1. If the system message (index 0) itself exceeds 40% of the budget, hard-truncate it.
 * 2. Always keep the system message + last user message.
 * 3. Fill remaining budget from the END of the conversation backwards.
 */
export function truncateMessages(
  messages: vscode.LanguageModelChatMessage[],
  maxTokens: number = 16000
): vscode.LanguageModelChatMessage[] {
  if (messages.length === 0) { return messages; }

  // Step 1: Read and measure all messages
  const texts = messages.map(m => messageText(m));
  let tokenCounts = texts.map(t => estimateTokens(t));
  let totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

  // Step 2: If system message (index 0) is over 40% of budget, hard-truncate it
  const sysMaxTokens = Math.floor(maxTokens * 0.4);
  if (tokenCounts[0] > sysMaxTokens) {
    logger.warn("truncation", `System message ~${tokenCounts[0]} tokens, capping to ~${sysMaxTokens}`);
    const truncatedSys = truncateText(texts[0], sysMaxTokens);
    messages[0] = sysMsg(truncatedSys.replace(/^\[SYSTEM INSTRUCTIONS\]\n/, ""));
    texts[0] = truncatedSys;
    totalTokens = totalTokens - tokenCounts[0] + estimateTokens(truncatedSys);
    tokenCounts[0] = estimateTokens(truncatedSys);
  }

  if (totalTokens <= maxTokens) { return messages; }

  logger.warn("truncation", `Total ~${totalTokens} tokens, trimming to ~${maxTokens}`);

  // Step 3: Keep system (0) + last message, fill backwards
  const keep = new Set([0, messages.length - 1]);
  let budget = maxTokens - tokenCounts[0] - tokenCounts[messages.length - 1];

  for (let i = messages.length - 2; i > 0; i--) {
    if (budget - tokenCounts[i] > 0) {
      keep.add(i);
      budget -= tokenCounts[i];
    }
    // Don't break — skip large messages and try smaller ones
  }

  const trimmed = messages.filter((_, i) => keep.has(i));

  if (trimmed.length < messages.length) {
    const dropped = messages.length - trimmed.length;
    trimmed.splice(1, 0, userMsg(`[Note: ${dropped} earlier messages were trimmed to fit context]`));
    logger.info("truncation", `Kept ${trimmed.length}/${messages.length} messages`);
  }

  return trimmed;
}
