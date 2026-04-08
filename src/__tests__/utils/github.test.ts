/**
 * Tests for src/utils/github.ts — formatting helpers (no network calls).
 */

import {
  formatRepoResults,
  repoContextForLLM,
  type GitHubSearchResult,
  type GitHubRepo,
} from "../../utils/github";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    fullName: "owner/repo",
    description: "A test repo",
    url: "https://github.com/owner/repo",
    stars: 1234,
    forks: 56,
    language: "TypeScript",
    topics: ["typescript", "vscode"],
    updatedAt: "2024-01-01T00:00:00Z",
    license: "MIT",
    openIssues: 10,
    ...overrides,
  };
}

function makeResult(overrides: Partial<GitHubSearchResult> = {}): GitHubSearchResult {
  return {
    totalCount: 1,
    repos: [makeRepo()],
    query: "test query",
    rateRemaining: 29,
    ...overrides,
  };
}

// ── formatRepoResults ────────────────────────────────────────────────

describe("formatRepoResults", () => {
  it("returns a no-results message when repos is empty", () => {
    const result = formatRepoResults(makeResult({ repos: [], totalCount: 0 }));
    expect(result).toContain("No GitHub repositories found");
    expect(result).toContain("test query");
  });

  it("includes the query in the heading", () => {
    const result = formatRepoResults(makeResult({ query: "react hooks" }));
    expect(result).toContain("react hooks");
  });

  it("renders a Markdown table with repo rows", () => {
    const result = formatRepoResults(makeResult());
    expect(result).toContain("| # | Repository |");
    expect(result).toContain("[owner/repo]");
    expect(result).toContain("TypeScript");
  });

  it("formats star counts with K suffix for thousands", () => {
    const repo = makeRepo({ stars: 45_200 });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    expect(result).toContain("45.2K");
  });

  it("formats star counts with M suffix for millions", () => {
    const repo = makeRepo({ stars: 1_500_000 });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    expect(result).toContain("1.5M");
  });

  it("truncates long descriptions at 80 chars", () => {
    const longDesc = "A".repeat(100);
    const repo = makeRepo({ description: longDesc });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    // Should be truncated to 77 chars + "…"
    expect(result).not.toContain("A".repeat(100));
    expect(result).toContain("…");
  });

  it("shows — for repos without a language", () => {
    const repo = makeRepo({ language: null });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    expect(result).toContain("—");
  });

  it("includes key topics for top repos", () => {
    const repo = makeRepo({ topics: ["react", "hooks", "frontend"] });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    expect(result).toContain("**Key topics:**");
    expect(result).toContain("`react`");
    expect(result).toContain("`hooks`");
  });

  it("skips topics section when no repos have topics", () => {
    const repo = makeRepo({ topics: [] });
    const result = formatRepoResults(makeResult({ repos: [repo] }));
    expect(result).not.toContain("**Key topics:**");
  });

  it("shows correct total count in header", () => {
    const result = formatRepoResults(makeResult({ totalCount: 9876 }));
    expect(result).toContain("9.9K");
  });
});

// ── repoContextForLLM ────────────────────────────────────────────────

describe("repoContextForLLM", () => {
  it("returns empty string for no results", () => {
    const result = repoContextForLLM(makeResult({ repos: [] }));
    expect(result).toBe("");
  });

  it("includes repo name and star count", () => {
    const result = repoContextForLLM(makeResult());
    expect(result).toContain("owner/repo");
    expect(result).toContain("1.2K");
  });

  it("caps at 5 repos even if more are provided", () => {
    const repos = Array.from({ length: 8 }, (_, i) =>
      makeRepo({ fullName: `owner/repo${i}` })
    );
    const result = repoContextForLLM(makeResult({ repos }));
    expect(result).toContain("owner/repo4");
    expect(result).not.toContain("owner/repo5");
  });

  it("shows ? for repos without a language", () => {
    const repo = makeRepo({ language: null });
    const result = repoContextForLLM(makeResult({ repos: [repo] }));
    expect(result).toContain("?");
  });

  it("truncates long descriptions", () => {
    const repo = makeRepo({ description: "B".repeat(120) });
    const result = repoContextForLLM(makeResult({ repos: [repo] }));
    expect(result).not.toContain("B".repeat(120));
    expect(result).toContain("…");
  });

  it("numbers repos sequentially", () => {
    const repos = [makeRepo({ fullName: "a/x" }), makeRepo({ fullName: "b/y" })];
    const result = repoContextForLLM(makeResult({ repos }));
    expect(result).toContain("1. a/x");
    expect(result).toContain("2. b/y");
  });
});
