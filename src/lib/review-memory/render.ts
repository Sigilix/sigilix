// ARC-189 — Render the [REVIEW MEMORY] block for the synth prompt.
//
// Empty input → empty string (omit-empty contract matching every
// other deterministic block: secret-scan / dep-vuln / AST / SARIF).
//
// Token budget per spec §4.6 (Kimi MINOR catch on v3 reconciled the
// math): the rendered block stays ≤ 200 tokens via a 4-chars-per-token
// coarse estimator. Header is ~55 tokens; per-record budget is ≤25
// tokens; with 5 records that's 55 + 5×25 + separators ≈ 184 tokens
// (~16 token slack for tokenizer variance).
//
// Whole-record inclusion: if including a 5th record would overflow
// the global cap, drop it entirely rather than truncate mid-record.
// Per-record overruns (e.g., a malformed long pathSha12) get
// ellipsis-truncated at a safe boundary.
//
// Privacy: rendered records carry pathSha12 only — NEVER raw
// repo-relative paths. The caller (lookup.ts) supplies only the
// truncated hash; this renderer trusts it but enforces non-existence
// of `/` characters via test.

import type { ReviewMemoryFinding } from "./types"

const GLOBAL_TOKEN_CAP = 200
const PER_RECORD_TOKEN_CAP = 25
const ELLIPSIS = "…"

const HEADER = [
  "[REVIEW MEMORY — historical dismissals on this repo]",
  "",
  "Reviewers have repeatedly dismissed these finding classes. The synth",
  "SHOULD soften matching findings (downgrade severity by one tier,",
  "shorten the body) and include them in `provenance.softened[]` with",
  "`reason: \"review-memory/<category>[/<pathSha12>]\"`.",
].join("\n")

/** Coarse tokenizer estimator matching the rest of the codebase. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/** Truncate a string to ≤ `tokenCap` tokens, appending an ellipsis. */
function truncateToTokenCap(s: string, tokenCap: number): string {
  if (estimateTokens(s) <= tokenCap) return s
  // Reserve 1 token for the ellipsis itself; back off character-by-
  // character until under budget. The 4-char-per-token approximation
  // means we cut at ((tokenCap - 1) * 4) chars.
  const charBudget = (tokenCap - 1) * 4
  return s.slice(0, Math.max(0, charBudget)) + ELLIPSIS
}

function renderRecord(memory: ReviewMemoryFinding): string {
  const datePrefix = memory.lastSignalTs.slice(0, 10) // YYYY-MM-DD
  const scopePart = memory.scope === "path-category" && memory.pathSha12
    ? `scope=path:${memory.pathSha12}`
    : "scope=repo"
  const raw = `- category=${memory.category}, ${scopePart}, signals=${memory.signalCount}, last=${datePrefix} → ${memory.suggestedAction}`
  return truncateToTokenCap(raw, PER_RECORD_TOKEN_CAP)
}

/**
 * Render the [REVIEW MEMORY] block for the synth prompt. Empty
 * string when memories is empty.
 */
export function renderReviewMemoryForPrompt(
  memories: readonly ReviewMemoryFinding[],
): string {
  if (memories.length === 0) return ""

  // Header always lands first; budget remaining tokens for records.
  let totalTokens = estimateTokens(HEADER)
  const recordLines: string[] = []
  for (const memory of memories) {
    const line = renderRecord(memory)
    // 1 token for the inter-line separator (newline)
    const cost = estimateTokens(line) + 1
    if (totalTokens + cost > GLOBAL_TOKEN_CAP) break
    recordLines.push(line)
    totalTokens += cost
  }
  if (recordLines.length === 0) {
    // Pathological: header alone overflows cap. Should never happen
    // with the constants above (header ~55 tokens), but if it does,
    // emit just the header.
    return HEADER
  }
  return [HEADER, "", ...recordLines].join("\n")
}
