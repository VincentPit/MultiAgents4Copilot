/**
 * Base agent utilities — model selection, fallback, and calling helpers.
 *
 * Supports multiple models through vscode.lm:
 *   • Claude Opus 4.6 — default for most agents
 *   • Gemini 3 Pro    — used by the UI designer agent
 *
 * If the primary model fails, automatically falls back to another available model.
 *
 * Upgraded: uses LanguageModelError for typed error handling,
 * improved token budget heuristics, and better retry backoff.
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

// ── Context budget ───────────────────────────────────────────────────

/**
 * Proportional token budget — mirrors how Copilot Chat manages context.
 * Instead of hardcoded limits, budgets are derived from model.maxInputTokens
 * and allocated proportionally to system prompt, workspace, references, etc.
 */
export interface ContextBudget {
  /** Total usable tokens for the request. */
  totalTokens: number;
  /** Char budget for the system/instruction prompt. */
  systemChars: number;
  /** Char budget for workspace context (file tree, project meta, active file). */
  workspaceChars: number;
  /** Char budget for user-attached references (#file, #selection). */
  referencesChars: number;
  /** Char budget for the user's actual question/prompt. */
  userMessageChars: number;
}

/**
 * Create a context budget based on the model's reported capacity.
 * Uses model.maxInputTokens to allocate proportionally — this is how
 * Copilot Chat handles large contexts instead of hardcoded limits.
 *
 * For Claude Opus 4.6 (200K tokens): ~360K chars total capacity.
 * For smaller models: graceful downscaling.
 */
export function createBudget(model: vscode.LanguageModelChat): ContextBudget {
  const maxInput = model.maxInputTokens ?? 30_000;
  // Use 75% of capacity — leave headroom for output tokens and overhead
  const usable = Math.min(Math.floor(maxInput * 0.75), 120_000);
  const toChars = (pct: number) => Math.floor(usable * pct * 4);

  return {
    totalTokens: usable,
    systemChars: toChars(0.20),       // 20% for system prompt
    workspaceChars: toChars(0.30),    // 30% for workspace snapshot
    referencesChars: toChars(0.30),   // 30% for attached references
    userMessageChars: toChars(0.20),  // 20% for user message + history
  };
}

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

const MAX_RETRIES = 3;

/** Maximum output characters — prevents a runaway model from flooding the state. */
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Compute a safe token budget for a model.
 * Uses model.maxInputTokens if available, otherwise defaults conservatively.
 */
export function safeBudget(model: vscode.LanguageModelChat): number {
  const reported = model.maxInputTokens;
  if (typeof reported === "number" && reported > 0) {
    // Use 80% of reported — modern Copilot models handle large context well
    return Math.min(Math.floor(reported * 0.80), 100_000);
  }
  return 30_000; // generous default for Copilot API models
}

/**
 * Count tokens accurately using the model's built-in tokenizer.
 * Falls back to chars/4 estimate if model.countTokens is unavailable.
 * This is the same approach Copilot Chat uses for budget validation.
 */
export async function countTokens(
  model: vscode.LanguageModelChat,
  text: string | vscode.LanguageModelChatMessage,
  token?: vscode.CancellationToken
): Promise<number> {
  try {
    return await model.countTokens(text, token);
  } catch {
    const str = typeof text === "string" ? text : "";
    return Math.ceil(str.length / 4);
  }
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
      // Log what we're sending so we can debug 400s
      const totalChars = messages.reduce((sum, m) => sum + messageText(m).length, 0);
      const estTokens = Math.ceil(totalChars / 4);
      logger.info(agentName, `Attempt ${attempt}: sending ${messages.length} msgs, ~${estTokens} tokens (~${totalChars} chars)`);

      const response = await model.sendRequest(messages, {}, token);
      const chunks: string[] = [];
      let outputChars = 0;

      for await (const chunk of response.text) {
        chunks.push(chunk);
        outputChars += chunk.length;
        if (stream) {
          stream.markdown(chunk);
        }
        // Safety: stop accumulating if output is absurdly large
        if (outputChars > MAX_OUTPUT_CHARS) {
          logger.warn(agentName, `Output exceeded ${MAX_OUTPUT_CHARS} chars — truncating`);
          break;
        }
      }

      return chunks.join("");
    } catch (err: unknown) {
      lastError = err;

      // Use LanguageModelError for typed error handling (VS Code 1.93+)
      if (err instanceof vscode.LanguageModelError) {
        const errDetails = `code=${err.code}, msg=${err.message}, cause=${String(err.cause ?? "").slice(0, 200)}`;
        logger.warn(agentName, `Attempt ${attempt}/${MAX_RETRIES} failed (LanguageModelError): ${errDetails}`);

        // NotFound = model not available, Blocked = content filter
        if (err.code === vscode.LanguageModelError.NotFound.name) {
          logger.error(agentName, "Model not found — skipping retries");
          break; // No point retrying if the model doesn't exist
        }
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        const is400 = errMsg.includes("400") || errMsg.includes("Bad Request");
        // Log comprehensive error details for debugging
        const errObj = err as any;
        const errDetails = [
          `msg=${errMsg}`,
          errObj?.code ? `code=${errObj.code}` : "",
          errObj?.cause ? `cause=${String(errObj.cause).slice(0, 200)}` : "",
          `type=${errObj?.constructor?.name ?? typeof err}`,
        ].filter(Boolean).join(", ");
        logger.warn(agentName, `Attempt ${attempt}/${MAX_RETRIES} failed: ${errDetails}`);

        // If 400 = context too large, aggressively truncate
        if (is400) {
          if (messages.length > 2) {
            logger.warn(agentName, `400 detected — stripping to system+last (was ${messages.length} msgs)`);
            const last = messages[messages.length - 1];
            const sys = messages[0];
            const sysText = messageText(sys);
            if (estimateTokens(sysText) > 2000) {
              messages = [sysMsg(truncateText(sysText, 2000).replace(/^\[SYSTEM INSTRUCTIONS\]\n/, "")), last];
            } else {
              messages = [sys, last];
            }
          } else if (messages.length === 1) {
            // Single consolidated message — hard-truncate its content
            const text = messageText(messages[0]);
            if (text.length > 6000) {
              logger.warn(agentName, `400 on single msg (${text.length} chars) — truncating to 6000`);
              messages = [userMsg(text.slice(0, 6000) + "\n[... truncated due to 400]")];
            }
          }
        }
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
        // Also apply truncation for the fallback attempt
        const fbBudget = safeBudget(fbModel);
        const fbMessages = truncateMessages([...messages], fbBudget);
        logger.info(agentName, `Fallback: sending ${fbMessages.length} msgs, budget ~${fbBudget} tokens`);
        const response = await fbModel.sendRequest(fbMessages, {}, token);
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

/** Cap a workspace context string to a safe size for injection into prompts. */
export function capContext(ctx: string, maxChars: number = 20_000): string {
  if (ctx.length <= maxChars) { return ctx; }
  return ctx.slice(0, maxChars) + "\n[… context truncated to fit]";
}

export function sysMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.User(`[SYSTEM INSTRUCTIONS]\n${content}`);
}

export function userMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.User(content);
}

export function assistantMsg(content: string): vscode.LanguageModelChatMessage {
  return vscode.LanguageModelChatMessage.Assistant(content);
}

/**
 * Build a properly-formatted message array that alternates User/Assistant.
 *
 * The VS Code LM API (Copilot backend) can reject requests with consecutive
 * same-role messages (400 Bad Request). This helper:
 *  1. Merges the system prompt + workspace context + user question into ONE User message
 *  2. Ensures strict User/Assistant alternation
 *  3. Hard-caps each piece to keep total size small
 */
export function buildMessages(opts: {
  systemPrompt: string;
  workspaceContext?: string;
  references?: string;
  chatHistory?: string;
  userQuestion: string;
  maxSystemChars?: number;
  maxWorkspaceChars?: number;
  maxReferencesChars?: number;
  maxTotalChars?: number;
}): vscode.LanguageModelChatMessage[] {
  const maxSys = opts.maxSystemChars ?? 8_000;
  const maxWs = opts.maxWorkspaceChars ?? 12_000;
  const maxRefs = opts.maxReferencesChars ?? 10_000;
  const maxTotal = opts.maxTotalChars ?? 60_000;

  // Sanitize inputs — strip known LLM instruction markers that could
  // be injected via file contents or chat history
  const sanitize = (s: string): string =>
    s.replace(/<\|im_start\|>|<\|im_end\|>|<<SYS>>|<<\/SYS>>|\[INST\]|\[\/INST\]/gi, "[filtered]");

  let combined = capContext(opts.systemPrompt, maxSys);
  if (opts.references) {
    combined += `\n\n---\n[REFERENCES]\n${capContext(sanitize(opts.references), maxRefs)}`;
  }
  if (opts.workspaceContext) {
    combined += `\n\n---\n[WORKSPACE]\n${capContext(sanitize(opts.workspaceContext), maxWs)}`;
  }
  if (opts.chatHistory) {
    combined += `\n\n---\n[CHAT HISTORY]\n${capContext(sanitize(opts.chatHistory), 4_000)}`;
  }
  combined += `\n\n---\n[USER REQUEST]\n${sanitize(opts.userQuestion)}`;

  // Hard-cap the entire combined message
  if (combined.length > maxTotal) {
    combined = combined.slice(0, maxTotal) + "\n[… truncated]";
  }

  return [userMsg(combined)];
}

// ── Message truncation ───────────────────────────────────────────────

/**
 * Estimate token count (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract text from a LanguageModelChatMessage using the VS Code API. */
function messageText(msg: vscode.LanguageModelChatMessage): string {
  try {
    // VS Code API: msg.content is Array<LanguageModelTextPart | ...>
    // LanguageModelTextPart has a .value string property
    const content = (msg as any).content;
    if (typeof content === "string") { return content; }
    if (Array.isArray(content)) {
      return content
        .map((p: any) => {
          if (typeof p === "string") { return p; }
          // LanguageModelTextPart: has .value
          if (p && typeof p.value === "string") { return p.value; }
          // Fallback: try .text
          if (p && typeof p.text === "string") { return p.text; }
          return "";
        })
        .join("");
    }
  } catch { /* fallback */ }
  // Last resort: stringify the message — guarantees we NEVER return empty
  // for a message that has real content.
  try { return JSON.stringify(msg).slice(0, 1000); } catch { return "[unreadable]"; }
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
  maxTokens: number = 30_000
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
