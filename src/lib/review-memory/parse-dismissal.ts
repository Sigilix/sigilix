// ARC-189 — Reviewer-reply dismissal-signal parser (Task 3).
//
// Walks a reply comment body looking for textual signals that the
// reviewer is dismissing the parent Sigilix comment. v1 detects ONLY
// dismissal — agreement / "good catch" replies are NOT positively
// recorded, only the absence of a dismiss signal.
//
// Keyword set:
//   - "not relevant"
//   - "false positive"
//   - "ignore"
//   - "noise"  /  "noisy"
//   - "dismiss"  (matches "dismissed", "dismissal", etc.)
//   - "won't fix"  /  "wontfix"
//   - "nit" — BARE ONLY (spec §13 risk #4): the entire trimmed reply
//     must be one of  "nit"  "nit."  "nit!"  (case-insensitive,
//     whitespace-trimmed). Prefix-style "nit: actually..." is NOT a
//     dismissal because reviewers commonly use it to flag THEIR OWN
//     non-blocking suggestion, not to dismiss Sigilix's comment.
//
// Code-block exclusion (Codex MAJOR-equivalent defensive measure):
// triple-backtick ` ``` ... ``` ` blocks are stripped before keyword
// matching so "// not relevant" or `dismiss = false` inside code
// samples doesn't trip false positives. Inline single-backtick
// `code` is left intact — prose around it is still scannable.

import type { ReviewMemorySignal } from "./types"

/** The result kind v1 emits. v2 may add more. */
type ParsedDismissal = Pick<ReviewMemorySignal, "kind">

const PREFIX_KEYWORDS = [
  "not relevant",
  "false positive",
  "ignore",
  "noise",
  "noisy",
  "dismiss",
  "won't fix",
  "wontfix",
] as const

const PREFIX_KEYWORD_REGEX = new RegExp(
  `(?:${PREFIX_KEYWORDS.map(escapeRegex).join("|")})`,
  "i",
)

/** Regex for bare-`nit` reply (entire trimmed body is exactly nit/nit./nit!). */
const BARE_NIT_REGEX = /^nit[.!]?$/i

/** Triple-backtick fenced code block. Multi-line, non-greedy. */
const CODE_FENCE_REGEX = /```[\s\S]*?```/g

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Parse a reply comment body for a dismissal signal. Returns the
 * parsed shape on hit, `null` on miss / non-string / empty.
 */
export function parseDismissalSignal(body: unknown): ParsedDismissal | null {
  if (typeof body !== "string") return null
  const trimmed = body.trim()
  if (trimmed.length === 0) return null

  // Bare-nit short-circuit: applies to the WHOLE trimmed body, before
  // code-fence stripping (a bare "nit" reply has no fences).
  if (BARE_NIT_REGEX.test(trimmed)) {
    return { kind: "dismissed-textual" }
  }

  // Strip fenced code blocks before keyword scan.
  const proseOnly = trimmed.replace(CODE_FENCE_REGEX, "")
  if (proseOnly.length === 0) return null

  if (PREFIX_KEYWORD_REGEX.test(proseOnly)) {
    return { kind: "dismissed-textual" }
  }
  return null
}
