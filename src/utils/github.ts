/**
 * GitHub Search utility — searches repositories via the GitHub REST API.
 *
 * Uses `vscode.authentication` to grab the user's existing GitHub session
 * (they already have one because of Copilot).  Falls back to unauthenticated
 * requests (lower rate-limit) if no session is available.
 */

import * as vscode from "vscode";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

export interface GitHubRepo {
  fullName: string;       // e.g. "vercel/next.js"
  description: string;
  url: string;            // HTML URL
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  updatedAt: string;
  license: string | null;
  openIssues: number;
}

export interface GitHubSearchResult {
  totalCount: number;
  repos: GitHubRepo[];
  query: string;
  rateRemaining: number | null;
}

// ── Token helper ─────────────────────────────────────────────────────

async function getGitHubToken(): Promise<string | null> {
  try {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: false,
      silent: true,
    });
    return session?.accessToken ?? null;
  } catch {
    logger.warn("github", "Could not get GitHub session — will use unauthenticated requests");
    return null;
  }
}

// ── Search ───────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";

/**
 * Search GitHub repositories.
 *
 * @param query     — natural-language or structured GitHub search query
 * @param maxResults — how many repos to return (max 30)
 */
export async function searchGitHubRepos(
  query: string,
  maxResults: number = 8,
): Promise<GitHubSearchResult> {
  const token = await getGitHubToken();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "MultiAgentCopilot-VSCode",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Sort by stars so the most established repos come first
  const params = new URLSearchParams({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: String(Math.min(maxResults, 30)),
  });

  const url = `${GITHUB_API}/search/repositories?${params}`;
  logger.info("github", `Searching: ${query}`);

  try {
    const res = await fetch(url, { headers });

    const rateRemaining = res.headers.get("x-ratelimit-remaining")
      ? Number(res.headers.get("x-ratelimit-remaining"))
      : null;

    if (!res.ok) {
      const body = await res.text();
      logger.error("github", `API error ${res.status}: ${body}`);
      return { totalCount: 0, repos: [], query, rateRemaining };
    }

    const data = (await res.json()) as any;

    const repos: GitHubRepo[] = (data.items ?? []).map((item: any) => ({
      fullName: item.full_name,
      description: item.description ?? "",
      url: item.html_url,
      stars: item.stargazers_count,
      forks: item.forks_count,
      language: item.language,
      topics: item.topics ?? [],
      updatedAt: item.updated_at,
      license: item.license?.spdx_id ?? null,
      openIssues: item.open_issues_count,
    }));

    logger.info("github", `Found ${data.total_count} repos (returning ${repos.length})`);

    return {
      totalCount: data.total_count ?? 0,
      repos,
      query,
      rateRemaining,
    };
  } catch (err: any) {
    logger.error("github", `Fetch failed: ${err.message}`);
    return { totalCount: 0, repos: [], query, rateRemaining: null };
  }
}

// ── Formatting helpers ───────────────────────────────────────────────

/** Format a number with K/M suffix. */
function formatCount(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(n);
}

/** Pretty-print search results as Markdown for the chat panel. */
export function formatRepoResults(result: GitHubSearchResult): string {
  if (result.repos.length === 0) {
    return `> 🔍 No GitHub repositories found for: _${result.query}_\n`;
  }

  const lines: string[] = [
    `\n#### 🐙 GitHub Repos — "${result.query}"`,
    `> Found **${formatCount(result.totalCount)}** repositories · showing top ${result.repos.length}\n`,
    `| # | Repository | ⭐ Stars | Language | Description |`,
    `|---|-----------|---------|----------|-------------|`,
  ];

  result.repos.forEach((repo, i) => {
    const desc = repo.description.length > 80
      ? repo.description.slice(0, 77) + "…"
      : repo.description;
    const lang = repo.language ?? "—";
    lines.push(
      `| ${i + 1} | [${repo.fullName}](${repo.url}) | ${formatCount(repo.stars)} | ${lang} | ${desc} |`
    );
  });

  // Add topics for the top 3 repos
  const topWithTopics = result.repos.slice(0, 3).filter(r => r.topics.length > 0);
  if (topWithTopics.length > 0) {
    lines.push("");
    lines.push(`**Key topics:**`);
    for (const repo of topWithTopics) {
      const tags = repo.topics.slice(0, 6).map(t => `\`${t}\``).join(" ");
      lines.push(`- **${repo.fullName}**: ${tags}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build a concise context string for the LLM summarising the repos found.
 * This gets injected into the researcher's system prompt so the model can
 * reference real projects in its analysis.
 */
export function repoContextForLLM(result: GitHubSearchResult): string {
  if (result.repos.length === 0) { return ""; }

  // Only include top 5 repos and cap description length to keep context small
  const entries = result.repos.slice(0, 5).map((r, i) => {
    const desc = r.description.length > 100 ? r.description.slice(0, 97) + "…" : r.description;
    return `${i + 1}. ${r.fullName} (⭐${formatCount(r.stars)}, ${r.language ?? "?"}) — ${desc}`;
  });

  return [
    `\n## GitHub repos matching the user's idea`,
    `Reference these in your analysis:\n`,
    ...entries,
  ].join("\n");
}
