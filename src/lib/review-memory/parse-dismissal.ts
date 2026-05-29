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
import { type DismissReason, parseDismissReason } from "../dismiss-reasons"

/**
 * The parsed result. `dismissReason` (SIG-114 PR 4) is attached ONLY when the
 * reply carries a recognized canonical reason (via the strict `parseDismissReason`
 * alias table) — opt-in, no fuzzy classification of freeform prose. Absent
 * otherwise (the signal stays `unlabeled`, prior behavior).
 */
type ParsedDismissal = Pick<ReviewMemorySignal, "kind" | "dismissReason">

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
 * Leading "@mention" + a dismiss keyword + separators, stripped so the
 * RESIDUAL can be parsed as a canonical reason. E.g. "@sigilix dismiss
 * not-a-bug" → "not-a-bug"; "dismiss: too minor" → "too minor".
 */
// Longest keyword first as cheap future-proofing for a TRUE prefix pair — a
// keyword that is a literal prefix of another (e.g. a hypothetical
// "dismiss"/"dismissal"), where the unbounded alternation would let the
// shorter one match first and strip too little. The CURRENT set has no such
// pair (the closest, "noise"/"noisy", are equal-length and the alternation
// already disambiguates them by fall-through), so this is a NO-OP today —
// kept only so adding a prefix-pair keyword later can't silently regress.
const DISMISS_REASON_PREFIX_REGEX = new RegExp(
  `^(?:@[a-z0-9-]+\\s+)?(?:${[...PREFIX_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|")})[\\s:;,.\\-—]*`,
  "i",
)

/**
 * Best-effort extraction of a CANONICAL reason from a dismissal reply.
 * Returns a `DismissReason` only when the reply text maps to one via the
 * strict alias table — either the whole reply is a reason ("not a bug") or
 * the residual after a dismiss prefix is ("@sigilix dismiss not-a-bug").
 * Freeform prose → undefined (no fuzzy guessing). Pure.
 */
function extractDismissReason(trimmed: string): DismissReason | undefined {
  const whole = parseDismissReason(trimmed)
  if (whole) return whole
  const residual = trimmed.replace(DISMISS_REASON_PREFIX_REGEX, "").trim()
  // Only parse the residual when a prefix was actually consumed (residual !==
  // trimmed); otherwise it's the same lookup we already did above.
  if (residual && residual !== trimmed) {
    const fromResidual = parseDismissReason(residual)
    if (fromResidual) return fromResidual
  }
  return undefined
}

function attachReason(trimmed: string): ParsedDismissal {
  const dismissReason = extractDismissReason(trimmed)
  return dismissReason
    ? { kind: "dismissed-textual", dismissReason }
    : { kind: "dismissed-textual" }
}

/**
 * Parse a reply comment body for a dismissal signal. Returns the
 * parsed shape on hit (with an optional canonical `dismissReason` when the
 * reply carries one), `null` on miss / non-string / empty.
 */
export function parseDismissalSignal(body: unknown): ParsedDismissal | null {
  if (typeof body !== "string") return null
  const trimmed = body.trim()
  if (trimmed.length === 0) return null

  // Bare-nit short-circuit: applies to the WHOLE trimmed body, before
  // code-fence stripping (a bare "nit" reply has no fences).
  if (BARE_NIT_REGEX.test(trimmed)) {
    return attachReason(trimmed)
  }

  // Strip fenced code blocks before keyword scan.
  const proseOnly = trimmed.replace(CODE_FENCE_REGEX, "")
  if (proseOnly.length === 0) return null

  if (PREFIX_KEYWORD_REGEX.test(proseOnly)) {
    return attachReason(proseOnly.trim())
  }
  return null
}
