/**
 * Secret-scan — a fast regex pass for obvious credentials in agent-written
 * file content. Runs *before* the file is written so leaked keys never hit
 * disk. This is a baseline check, not a replacement for full SAST.
 *
 * Skipped paths: tests, mocks, fixtures (where placeholder keys are common).
 * Per-line escape hatch: append `secret-scan: allow` in a comment on the
 * matching line to silence a known-safe match.
 */

export interface SecretMatch {
  /** Short label for the kind of secret detected (e.g. "AWS access key"). */
  kind: string;
  /** 1-based line number where the match starts. */
  line: number;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { kind: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { kind: "Stripe live secret", re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "private key", re: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    kind: "hardcoded credential",
    re: /\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
  },
];

/**
 * Path patterns that are skipped — placeholder credentials in tests and
 * fixtures are expected and shouldn't trigger blocks.
 */
const SCAN_SKIP_PATH_PATTERNS: RegExp[] = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)__mocks__(\/|$)/,
  /(^|\/)fixtures(\/|$)/,
  /(^|\/)tests?(\/|$)/,
  /\.test\.[a-zA-Z0-9]+$/,
  /\.spec\.[a-zA-Z0-9]+$/,
];

/** Per-line allow marker — overrides a match on the same line. */
const ALLOW_MARKER = /secret-scan:\s*allow/i;

/**
 * Values that look like documentation placeholders, not real credentials.
 * Used to suppress the noisy hardcoded-credential pattern.
 */
const PLACEHOLDER_INDICATORS =
  /(^|[^a-z])(example|placeholder|your[_-]?(?:key|token|secret|password|api)|xxx+|\*\*\*+|changeme|todo|fake|dummy|sample|<.*>)/i;

export function shouldSkipScan(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, "/");
  return SCAN_SKIP_PATH_PATTERNS.some(p => p.test(normalised));
}

/**
 * Scan content for secret matches. Honours the `secret-scan: allow` per-line
 * marker. Deduplicates by (kind, line).
 */
export function scanContentForSecrets(content: string): SecretMatch[] {
  const lines = content.split("\n");
  const found: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      // Guard against zero-width matches that would loop forever
      if (m.index === re.lastIndex) { re.lastIndex++; continue; }

      const upToMatch = content.slice(0, m.index);
      const lineNo = upToMatch.split("\n").length;
      const lineText = lines[lineNo - 1] ?? "";

      if (ALLOW_MARKER.test(lineText)) { continue; }

      // For the hardcoded-credential pattern, the captured value is in m[2].
      // Filter out obvious placeholders to keep false positives low.
      if (kind === "hardcoded credential") {
        const value = m[2] ?? "";
        if (PLACEHOLDER_INDICATORS.test(value)) { continue; }
      }

      const key = `${kind}:${lineNo}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      found.push({ kind, line: lineNo });
    }
  }

  return found;
}

/**
 * Scan a file (by path + content). Returns [] for skipped paths.
 */
export function scanFileForSecrets(
  filePath: string,
  content: string,
): SecretMatch[] {
  if (shouldSkipScan(filePath)) { return []; }
  return scanContentForSecrets(content);
}

/**
 * Format matches for a single-line log/UI message.
 *   "AWS access key (line 12), private key (line 30)"
 */
export function formatSecretMatches(matches: SecretMatch[], cap = 3): string {
  const parts = matches.slice(0, cap).map(m => `${m.kind} (line ${m.line})`);
  if (matches.length > cap) {
    parts.push(`+${matches.length - cap} more`);
  }
  return parts.join(", ");
}
