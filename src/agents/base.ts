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
      logger.warn(agentName, `Attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);

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
 * Real tokenisers vary, but this keeps us safely under limits.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate a message list to fit within a token budget.
 * Always keeps the system message (index 0) and the last user message.
 * Trims from the middle of the conversation.
 */
export function truncateMessages(
  messages: vscode.LanguageModelChatMessage[],
  maxTokens: number = 28000
): vscode.LanguageModelChatMessage[] {
  // Estimate total tokens
  let totalTokens = 0;
  const tokenCounts = messages.map(m => {
    // Access the text content — LanguageModelChatMessage stores parts
    const text = (m as any).content?.[0]?.value ?? (m as any).content ?? "";
    const count = estimateTokens(typeof text === "string" ? text : JSON.stringify(text));
    totalTokens += count;
    return count;
  });

  if (totalTokens <= maxTokens) { return messages; }

  logger.warn("truncation", `Messages ~${totalTokens} tokens, trimming to ~${maxTokens}`);

  // Always keep: first (system) + last (latest user prompt)
  const keep = new Set([0, messages.length - 1]);
  let budget = maxTokens - tokenCounts[0] - tokenCounts[messages.length - 1];

  // Fill from the end backwards (recent context is most valuable)
  for (let i = messages.length - 2; i > 0; i--) {
    if (budget - tokenCounts[i] > 0) {
      keep.add(i);
      budget -= tokenCounts[i];
    } else {
      break;
    }
  }

  const trimmed = messages.filter((_, i) => keep.has(i));

  // Insert a notice so the model knows context was trimmed
  if (trimmed.length < messages.length) {
    const dropped = messages.length - trimmed.length;
    trimmed.splice(1, 0, userMsg(`[Note: ${dropped} earlier messages were trimmed to fit context window]`));
  }

  logger.info("truncation", `Kept ${trimmed.length}/${messages.length} messages`);
  return trimmed;
}
