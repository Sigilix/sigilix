// SIG-437: pure body-merge helper for `@sigilix summary`.
//
// `@sigilix summary` is a one-liner an author drops in the PR BODY. Sigilix
// replaces it with a detailed, generated PR description wrapped in a MANAGED
// BLOCK between stable HTML-comment sentinels:
//
//   <!-- sigilix:summary:start -->
//   <generated content>
//   <!-- sigilix:summary:end -->
//
// Two write modes, in priority order:
//
//   1. Managed block already present (correct order, single start before the
//      matching end) → replace ONLY the content between the fences. Everything
//      outside is bit-for-bit preserved. This is the re-edit path: a re-run
//      REPLACES the block, never double-appends.
//   2. No managed block, but a `@sigilix summary` trigger line is present →
//      replace exactly that trigger line with the fenced block in place. The
//      author's surrounding prose is preserved.
//   3. Neither present → return the body UNCHANGED (no-op). The handler already
//      gated on marker/block presence; this is the defensive fall-through so a
//      stale enqueue can't append a block to a body the author has since
//      cleaned up.
//
// Contrast with `describe-apply.ts` (ARC-264): describe *appends* a fenced
// block at the end of the body. Summary *replaces the trigger line* on first
// apply (and the block thereafter), so it deliberately does NOT reuse that
// helper.
//
// Idempotent: re-applying the same content twice in a row produces a body equal
// to the first application's result (byte-for-byte) — the block-replace path is
// the steady state after the first run.
//
// Pure — no I/O, no env. `triage-pr-summary.ts` wraps this with the GitHub
// PATCH call.

import { getMentionTriggers } from "./mention"

/** The managed-block sentinels `applySummaryToBody` writes/replaces. Public so
 *  tests + the handler reference them by name rather than hand-rolling the
 *  literal strings. */
export const SUMMARY_MARKERS = {
  start: "<!-- sigilix:summary:start -->",
  end: "<!-- sigilix:summary:end -->",
} as const

/**
 * Build the case-insensitive matcher for a `@sigilix summary` trigger line. The
 * accepted triggers (the `@`-handles) come from the same source as the mention
 * reply path (`OPENCLAW_MENTION_TRIGGERS`, default sigilix), so a custom-named
 * deployment still works. A trigger line is: optional leading whitespace, `@`,
 * one of the trigger handles, whitespace, the literal `summary`, optional
 * trailing whitespace — the WHOLE line (anchored) so a `@sigilix summary` quoted
 * mid-sentence doesn't count.
 *
 * Exported for tests.
 */
export function summaryTriggerRegex(triggers: string[]): RegExp {
  // Longest-first so a handle that is a prefix of another (e.g. "sigilix" vs
  // "sigilix[bot]") matches the most specific. Escape regex metachars in each
  // handle (handles may contain `[` `]`).
  const alternation = [...triggers]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  // `m` so `^`/`$` anchor per line; `i` for case-insensitivity on the handle +
  // the literal `summary`.
  return new RegExp(`^[ \\t]*@(?:${alternation})[ \\t]+summary[ \\t]*$`, "im")
}

/** True when `body` contains a managed summary block in the correct order
 *  (a single start before its matching end). */
export function hasSummaryBlock(body: string): boolean {
  const startIdx = body.indexOf(SUMMARY_MARKERS.start)
  const endIdx = body.indexOf(SUMMARY_MARKERS.end)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false
  // Guard the malformed `start … start … end` shape (a second start before the
  // first end) — treated as no usable block so the replace path doesn't orphan
  // the second start. Mirrors describe-apply's L8 guard.
  const secondStartIdx = body.indexOf(SUMMARY_MARKERS.start, startIdx + SUMMARY_MARKERS.start.length)
  return secondStartIdx === -1 || secondStartIdx > endIdx
}

/**
 * Remove the managed summary block (sentinels + interior) from a body so a
 * `@sigilix summary` token the model echoed INSIDE the generated block can't
 * re-trigger the parser after our own PATCH (Codex MUST-FIX #4). Only strips a
 * well-formed block (the same shape `hasSummaryBlock` accepts); a malformed
 * fence pair is left in place (no usable block to strip). Pure — exported for
 * the parser + tests.
 */
export function stripSummaryBlock(body: string): string {
  if (!hasSummaryBlock(body)) return body
  const startIdx = body.indexOf(SUMMARY_MARKERS.start)
  const endIdx = body.indexOf(SUMMARY_MARKERS.end)
  return body.slice(0, startIdx) + body.slice(endIdx + SUMMARY_MARKERS.end.length)
}

/** True when `body` contains a `@sigilix summary` trigger line. */
export function hasSummaryTrigger(body: string, envTriggers?: string): boolean {
  if (typeof body !== "string" || body.length === 0) return false
  return summaryTriggerRegex(getMentionTriggers(envTriggers)).test(body)
}

export interface ApplySummaryArgs {
  /** Current PR body (may be empty, null, or undefined — all map to ""). */
  currentBody: string | null | undefined
  /** The content to write between the managed-block sentinels. Caller owns any
   *  size truncation (LLM output cap, GitHub PR-body cap). Leading whitespace is
   *  preserved (a model may use an intentional leading heading); trailing
   *  whitespace is trimmed so a trailing newline doesn't accumulate blank lines
   *  on re-apply and break byte-for-byte idempotency. */
  sectionContent: string
  /** Raw `OPENCLAW_MENTION_TRIGGERS` (optional) — selects which `@`-handles
   *  count as a trigger. Defaults to the standard sigilix triggers. */
  envTriggers?: string
}

/**
 * Returns the new PR body. Caller PATCHes it via
 * `client.updatePullRequestBody`. See the module header for the three modes.
 */
export function applySummaryToBody(args: ApplySummaryArgs): string {
  const { sectionContent } = args
  const body = typeof args.currentBody === "string" ? args.currentBody : ""
  const { start, end } = SUMMARY_MARKERS

  // Trim trailing whitespace on the inner content for byte-idempotency.
  const block = `${start}\n${sectionContent.replace(/\s+$/, "")}\n${end}`

  // Mode 1 — managed block already present: replace the whole fenced range
  // (markers inclusive) with the fresh block. This is the steady state.
  if (hasSummaryBlock(body)) {
    const startIdx = body.indexOf(start)
    const endIdx = body.indexOf(end)
    const before = body.slice(0, startIdx)
    const after = body.slice(endIdx + end.length)
    return before + block + after
  }

  // Mode 2 — no block, but a `@sigilix summary` trigger line is present:
  // replace exactly that line (the whole anchored line) with the block,
  // preserving the author's surrounding prose. Only the FIRST trigger line is
  // replaced (a body with two trigger lines is degenerate; the next re-run hits
  // Mode 1 on the block we just wrote and the remaining trigger line is left
  // visible for the author).
  //
  // Splice via index/slice (NOT String.replace) so `block` is inserted
  // LITERALLY: the model-generated description routinely contains `$` runs
  // (shell / sed / regex / prices), which `String.replace`'s replacement string
  // would interpret as `$&` / `` $` `` / `$'` / `$n` patterns and mangle. Mirrors
  // the describe sibling's index/slice merge.
  const triggerRe = summaryTriggerRegex(getMentionTriggers(args.envTriggers))
  const m = triggerRe.exec(body)
  if (m) {
    return body.slice(0, m.index) + block + body.slice(m.index + m[0].length)
  }

  // Mode 3 — neither present: no-op. Return the original body unchanged.
  return body
}
