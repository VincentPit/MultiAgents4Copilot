/**
 * Researcher agent — gathers information, explains concepts,
 * and searches GitHub for professional reference repositories.
 */

import * as vscode from "vscode";
import { AgentState, AgentMessage, postAgentMessage } from "../graph/state";
import { callModel, sysMsg, userMsg, assistantMsg, truncateMessages } from "./base";
import { logger } from "../utils/logger";
import {
  searchGitHubRepos,
  formatRepoResults,
  repoContextForLLM,
  GitHubSearchResult,
} from "../utils/github";

// ── Prompts ──────────────────────────────────────────────────────────

/** Tiny prompt used to extract GitHub search keywords from the conversation. */
const KEYWORD_PROMPT = `You are a search-query generator.
Given the user's request, produce 1-3 concise GitHub search queries that would
find high-quality, professional open-source repositories similar to what the
user wants to build.

Rules:
- Return ONLY the queries, one per line.
- Each query should be ≤ 8 words.
- Use terms GitHub's search understands (language filters like "language:python", topic keywords, etc.).
- Do NOT include any explanation — just the raw queries.`;

const SYSTEM_PROMPT = `You are the Researcher agent on a multi-agent coding team.

Your job is to find and synthesise relevant information the team needs.
This includes API docs, library usage, best practices, architecture patterns,
and answers to technical questions.

When GitHub repository search results are provided, you MUST:
1. Highlight the top 2-3 most relevant repos and explain WHY they're good references.
2. Describe the architecture or patterns used by these projects.
3. Suggest which parts / files the user should study.
4. Note the tech stack, testing approaches, and deployment strategies used.

General rules:
1. Provide clear, concise summaries.
2. Use bullet points and tables for scannability.
3. If you don't know something, say so — don't fabricate.
4. When applicable, include code snippets demonstrating usage.
5. End with a "Recommended next steps" section.`;

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
    const keywordMessages = [
      sysMsg(KEYWORD_PROMPT),
      userMsg(lastUserMsg),
    ];
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
  if (state.workspaceContext) {
    fullSystemPrompt += `\n\n${state.workspaceContext}`;
  }

  const messages: vscode.LanguageModelChatMessage[] = [sysMsg(fullSystemPrompt)];
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messages.push(userMsg(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(assistantMsg(msg.content));
    }
  }

  stream.markdown(`#### 📝 Analysis\n\n`);
  const response = await callModel(model, truncateMessages(messages), stream, token, "researcher");

  const newMessage: AgentMessage = {
    role: "assistant",
    name: "researcher",
    content: response,
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

