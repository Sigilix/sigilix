// ARC-183: repository sensitivity controls.
//
// Some repos shouldn't have their code shipped to external LLM
// providers — compliance / customer data / secrets-heavy work where
// even sending a diff to Ollama Turbo violates policy. Graphite ships
// `withgraphite/exclude-sensitive-repos` for this exact concern;
// Sigilix's equivalent is a denylist env var that gates the
// orchestrator at entry, BEFORE any GitHub diff fetch.
//
// Policy:
//   - `OPENCLAW_SENSITIVE_REPOS` = comma-separated `owner/repo` list
//   - Match is case-insensitive on the canonical `owner/repo` form
//   - Empty / unset = no sensitive repos (current behavior preserved)
//   - When matched: skip the review entirely, log the reason, and
//     emit telemetry. NEVER fetch the PR diff or call any model.
//
// Sensitive denylist is the ONLY repo-level gate on the ensemble.
// ARC-232 (2026-05-16): the prior `OPENCLAW_ENSEMBLE_REVIEW_ALLOWED_REPOS`
// allowlist was deleted — silent fallback to slower Phase 3 on a
// missing env-var entry burned us on 2026-05-12 (rubberfit downgrade);
// the secret has been removed from prod and the code-level cleanup
// landed too.

/**
 * Parse the env var into a normalized set of `owner/repo` strings.
 * Empty / unset returns an empty set so callers can safely
 * `set.has(target)` without null checks.
 */
export function parseSensitiveRepos(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toLowerCase()
    if (trimmed.length > 0) out.add(trimmed)
  }
  return out
}

/**
 * `true` iff the repo is on the sensitive denylist. Match is
 * case-insensitive on the canonical `owner/repo` shape (matches the
 * env var's normalization). Always returns `false` when the env var
 * is empty / unset.
 */
export function isRepoSensitive(
  envValue: string | undefined,
  owner: string,
  repo: string,
): boolean {
  const sensitive = parseSensitiveRepos(envValue)
  if (sensitive.size === 0) return false
  return sensitive.has(`${owner}/${repo}`.toLowerCase())
}
