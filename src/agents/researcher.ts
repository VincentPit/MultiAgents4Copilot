/**
 * Researcher agent — gathers information, explains concepts,
 * and searches GitHub for professional reference repositories.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage } from "../graph/state";
import { callModel, buildMessages, capContext } from "./base";
import { logger } from "../utils/logger";
import {
  searchGitHubRepos,
  formatRepoResults,
  repoContextForLLM,
  GitHubSearchResult,
} from "../utils/github";

// ── Prompts ──────────────────────────────────────────────────────────

const KEYWORD_PROMPT = `You are a search-query generator.
Given the user's request, produce 1-3 concise GitHub search queries.
Return ONLY the queries, one per line. Each query 8 words or less.
Do NOT include any explanation.`;

const SYSTEM_PROMPT = `You are the Researcher agent on a multi-agent coding team.

Find and synthesize relevant information. When GitHub results are provided:
1. Highlight the top 2-3 most relevant repos and why.
2. Describe patterns and architecture used.
3. Suggest files to study.

Rules: Be concise. Use bullets. Don't fabricate. End with next steps.`;

// ── Agent function ───────────────────────────────────────────────────

export async function researcherNode(
  state: AgentState,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Partial<AgentState>> {
  stream.markdown(
    `---\n\n` +
    `#### 🔍 Researcher — Gathering information\n\n`
  );

  // ── Step 1: Extract search keywords via LLM (silent — no stream) ──
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === "user")?.content ?? "";

  stream.progress("🐙 Extracting GitHub search queries…");
  let searchQueries: string[] = [];
  try {
    const keywordMessages = buildMessages({
      systemPrompt: KEYWORD_PROMPT,
      userQuestion: lastUserMsg,
      maxSystemChars: 400,
      maxWorkspaceChars: 0,
    });
    const raw = await callModel(model, keywordMessages, null, token, "researcher-keywords");
    searchQueries = raw
      .split("\n")
      .map(l => l.replace(/^[-•\d.]\s*/, "").trim())
      .filter(l => l.length > 0 && l.length < 100)
      .slice(0, 3);
    logger.info("researcher", `Generated ${searchQueries.length} search queries: ${searchQueries.join(" | ")}`);
  } catch (err: any) {
    logger.warn("researcher", `Keyword extraction failed: ${err.message}`);
  }

  // ── Step 2: Search GitHub for each query ──────────────────────────
  let allResults: GitHubSearchResult | null = null;

  if (searchQueries.length > 0) {
    stream.progress("🐙 Searching GitHub repositories…");
    stream.markdown(`> 🐙 Searching GitHub for professional reference repos…\n\n`);

    // Run all queries and merge results (deduplicate by fullName)
    const seen = new Set<string>();
    const mergedRepos: GitHubSearchResult["repos"] = [];
    let totalCount = 0;

    for (const q of searchQueries) {
      if (token.isCancellationRequested) { break; }
      const result = await searchGitHubRepos(q, 6);
      totalCount += result.totalCount;
      for (const repo of result.repos) {
        if (!seen.has(repo.fullName)) {
          seen.add(repo.fullName);
          mergedRepos.push(repo);
        }
      }
    }

    // Sort merged results by stars descending
    mergedRepos.sort((a, b) => b.stars - a.stars);
    const topRepos = mergedRepos.slice(0, 8);

    allResults = {
      totalCount,
      repos: topRepos,
      query: searchQueries.join(" + "),
      rateRemaining: null,
    };

    // Render the repo table to the user
    stream.markdown(formatRepoResults(allResults));
    stream.markdown(`\n---\n\n`);
  }

  // ── Step 3: Run the main research with GitHub context ─────────────
  stream.progress("🔍 Analysing and synthesising…");

  let fullSystemPrompt = SYSTEM_PROMPT;
  if (allResults && allResults.repos.length > 0) {
    fullSystemPrompt += repoContextForLLM(allResults);
  }
  // Cap workspace context injected into system prompt to avoid 400s
  if (state.workspaceContext) {
    const wsCtx = state.workspaceContext.length > 8000
      ? state.workspaceContext.slice(0, 8000) + "\n[… workspace context truncated]"
      : state.workspaceContext;
    fullSystemPrompt += `\n\n${wsCtx}`;
  }

  // Hard-cap the entire system prompt to ~10000 tokens (~40000 chars)
  if (fullSystemPrompt.length > 40_000) {
    fullSystemPrompt = fullSystemPrompt.slice(0, 40_000) + "\n[… system prompt truncated to fit context window]";
  }

  const messages = buildMessages({
    systemPrompt: fullSystemPrompt,
    chatHistory: state.chatHistory,
    userQuestion: lastUserMsg || "Analyze the research topic",
    maxSystemChars: 20_000,
    maxWorkspaceChars: 0, // workspace context already embedded above
  });

  stream.markdown(`#### \u{1F4DD} Analysis\n\n`);
  const response = await callModel(model, messages, stream, token, "researcher");

  // Cap what we store in state.messages to avoid bloating context for downstream agents
  const cappedResponse = response.length > 6000
    ? response.slice(0, 6000) + "\n[… research truncated in state]"
    : response;

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "researcher",
    content: cappedResponse,
  };

  // Post research (including repo context) to the message bus
  const repoSummary = allResults?.repos.slice(0, 3)
    .map(r => `• ${r.fullName} (⭐${r.stars}) — ${r.description}`)
    .join("\n") ?? "";
  const busContent = repoSummary
    ? `GitHub repos found:\n${repoSummary}\n\nResearch:\n${response}`
    : response;
  postAgentMessage(state, "researcher", "*", "info", busContent);

  return {
    messages: [newMessage],
    artifacts: {
      research: response,
      ...(allResults ? { github_repos: JSON.stringify(allResults.repos.slice(0, 5)) } : {}),
    },
  };
}

