// SIG-173 — Reason labels for `@sigilix dismiss <reason>`.
//
// A reviewer who runs `@sigilix dismiss` may tag WHY they're dismissing the
// blocking review with one of five labels. The reason persists into the
// `WithdrawalRecord` (audit), counts into the `/metrics/dismissals` endpoint
// (per-reason rollup), and seeds the review-memory softening weights so
// "this is too minor to flag" pushes the threshold differently than
// "this isn't a real bug" (see `review-memory/dismissal-weights.ts`).
//
// Locked label set — DO NOT add new labels without bumping
// `DISMISS_REASONS_VERSION` + the metrics consumer schema. Bare
// `@sigilix dismiss` (no label) and any invalid/typo'd label both map to
// `"unlabeled"` — forgiving parse so a typo never silently fails the
// dismiss itself.

/** Stable wire identifier for the reason label set. Bump on label add/remove. */
export const DISMISS_REASONS_VERSION = 1

/** Locked label set. New entries require a `DISMISS_REASONS_VERSION` bump. */
export const ALL_DISMISS_REASONS = [
  "not-a-bug",
  "bad-anchor",
  "already-covered",
  "too-minor",
  "wrong-context",
  "unlabeled",
] as const

export type DismissReason = (typeof ALL_DISMISS_REASONS)[number]

/**
 * Map of label aliases → canonical reason. Each canonical reason is its own
 * key (identity match); aliases here are hyphen/underscore/space tolerant
 * variants the parser accepts. Lowercased keys; the parser lowercases input
 * before lookup.
 */
const REASON_ALIASES: Readonly<Record<string, DismissReason>> = {
  "not-a-bug": "not-a-bug",
  "not a bug": "not-a-bug",
  not_a_bug: "not-a-bug",
  notabug: "not-a-bug",

  "bad-anchor": "bad-anchor",
  "bad anchor": "bad-anchor",
  bad_anchor: "bad-anchor",
  badanchor: "bad-anchor",

  "already-covered": "already-covered",
  "already covered": "already-covered",
  already_covered: "already-covered",
  alreadycovered: "already-covered",

  "too-minor": "too-minor",
  "too minor": "too-minor",
  too_minor: "too-minor",
  toominor: "too-minor",

  "wrong-context": "wrong-context",
  "wrong context": "wrong-context",
  wrong_context: "wrong-context",
  wrongcontext: "wrong-context",
}

/**
 * Parse a free-text reason fragment into a canonical `DismissReason`. Empty
 * input → `null` (caller decides whether that means "no label given" or
 * "invalid"). Unknown / typo'd input → `null` (caller falls back to
 * `"unlabeled"` so the dismiss still goes through). Case + whitespace are
 * normalized before lookup.
 *
 * Pure — exported for tests.
 */
export function parseDismissReason(raw: string): DismissReason | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === "") return null
  // Collapse internal whitespace so `"  too   minor  "` matches `"too minor"`.
  const collapsed = trimmed.replace(/\s+/g, " ")
  return REASON_ALIASES[collapsed] ?? null
}

/** Type-guard: is `value` one of the canonical `DismissReason` strings? */
export function isDismissReason(value: unknown): value is DismissReason {
  return typeof value === "string" && (ALL_DISMISS_REASONS as readonly string[]).includes(value)
}
