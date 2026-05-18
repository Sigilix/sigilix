// ARC-269 — gate the implicit "reply in Sigilix review thread" path.
//
// Today, `queueGithubMention` queues ANY inline review reply that
// carries `in_reply_to_id`, regardless of whether the human's
// comment looks like a real ask (see `isReviewCommentReply` at
// `src/index.ts`). That means a reviewer replying "fixed" or "👍"
// to a Sigilix finding still spends an LLM call. It also means
// replies on threads NOT originated by Sigilix get queued — those
// get dropped later in the consumer, but the queue burn is real.
//
// This module owns the BODY-SHAPE side of that gate (does this
// comment look like it deserves a reply?). The THREAD-ROOT-OWNER
// side (was the root authored by Sigilix?) lives in the consumer
// (`handleGithubMention`) where it already has the thread loaded.
//
// Body-shape policy (code-review M1 catch on this PR):
//
//   - `?` / length scoring runs against the RAW body (`raw.trim()`).
//     A reply like `` `foo()` breaks the null path `` has its inline
//     code span stripped by `stripQuotesAndCode`, leaving a stub
//     that wouldn't trip the trigger / length / `?` heuristics —
//     but the original IS a real claim, so we score against raw.
//   - Empty / single-token-ack detection runs against the CLEANED
//     body (`stripQuotesAndCode(raw)`). Blockquoted Sigilix output
//     that the user quoted back at us should NOT count as a real
//     ask; an ack token surrounded by quoted material should still
//     be an ack.
//
// Pure — no I/O, no env. Tests exercise every branch directly.

import { stripQuotesAndCode } from "./mention"
import { isArcGithubLogin } from "./mention"

/**
 * Reasons a `pull_request_review_comment.created` payload is NOT
 * worth queuing for a Sigilix reply. Surfaced in the structured
 * `review-reply-skipped-*` telemetry events so log analysis can
 * count each gate's hit rate separately.
 */
export type ReviewReplySkipReason =
  | "self"           // comment authored by Sigilix itself (loop guard)
  | "not-a-reply"    // no in_reply_to_id — first comment in a new thread
  | "empty"          // body is blank after stripping quotes + code
  | "ack-only"       // body is "fixed" / "done" / "thanks" / 👍 / +1 / …
  | "no-reply-signal" // body has no `?`, no trigger word, and is short

export type ReviewReplyGateResult =
  | { ok: true }
  | { ok: false; reason: ReviewReplySkipReason }

/** Short acknowledgements that don't deserve an LLM call. Matched
 *  case-insensitively against the WHOLE cleaned body (post-trim).
 *  Single-word forms only — longer messages that happen to contain
 *  "thanks" still get scored by the trigger-word path below. */
const ACK_TOKENS = new Set([
  "ack",
  "acknowledged",
  "addressed",
  "+1",
  "agree",
  "agreed",
  "approved",
  "done",
  "deployed",
  "fixed",
  "lgtm",
  "merged",
  "noted",
  "ok",
  "okay",
  "resolved",
  "shipped",
  "sgtm",
  "thanks",
  "thx",
  "ty",
  "wfm",
  "wilco",
  "yeah",
  "yep",
  "yes",
  "👍",
  "👎",
  "✅",
  "🙏",
  "🚀",
  "💯",
])

/** Word-boundary regexes for reply-trigger detection. Substring
 *  matching (the v1 shape) over-fired on common English — `"prod"`
 *  hit `"product"` / `"reproduction"`, `"how"` hit `"however"` /
 *  `"show"` / `"somehow"`. Compiled once at module load.
 *
 *  Multi-word phrases (`"false positive"`, `"dead code"`) need a
 *  word boundary on each side of the whole phrase, not each word. */
const REPLY_TRIGGER_REGEXES: readonly RegExp[] = [
  /\bignore\b/i,
  /\bfalse[- ]positive\b/i,
  /\bdead code\b/i,
  /\bintentional\b/i,
  /\bnot reachable\b/i,
  /\bunreachable\b/i,
  /\bprod\b/i,
  /\bproduction\b/i,
  /\bwhy\b/i,
  /\bhow\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bdoes this\b/i,
  /\bis this\b/i,
  /\bisn'?t\b/i,
  /\bdoesn'?t\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bactually\b/i,
  /\bexplain\b/i,
  /\bsafe\b/i,
  /\bconcerns?\b/i,
  /\bclarify\b/i,
  /\bunclear\b/i,
  /\bthoughts?\b/i,
  /\bcorrect me\b/i,
  /\?{2,}/, // "??" or more — explicit strong-signal even if the body doesn't end with the question mark
]

/** Comments shorter than this with no `?` and no trigger word are
 *  treated as low-signal and skipped. 80 chars roughly fits "ack +
 *  one short clarification" while excluding bare emoji bursts. */
const LOW_SIGNAL_LENGTH_THRESHOLD = 80

/**
 * Gate predicate for queuing an implicit review-thread reply.
 *
 * Returns `{ ok: true }` only when ALL of:
 *   - author is not Sigilix
 *   - `inReplyToId` is set (this comment IS a reply, not the first
 *     in a thread)
 *   - body has content after stripping quotes + code blocks
 *   - body has a STRONG signal (raw body ends with `?`, raw body
 *     is >= length threshold, or raw body matches a trigger regex)
 *   - OR (no strong signal) the cleaned body is NOT a single ack
 *     token
 *
 * Order rationale:
 *   1. `self` runs first — loop prevention is the most consequential
 *      property; defense-in-depth against future callers that might
 *      skip the outer self-guard. (Also enforced at the
 *      `queueGithubMention` call site at `src/index.ts`.)
 *   2. `not-a-reply` rejects top-level review comments with no
 *      `in_reply_to_id` (we only enter Sigilix-thread mode on replies).
 *   3. `empty` rejects blank-after-strip bodies (Sigilix's own quoted
 *      output stripped to nothing, fenced-code-only bodies, etc.).
 *   4. STRONG-SIGNAL short-circuit runs BEFORE the single-token ack
 *      check (code-review H1 catch). Without this, `"thanks?"` /
 *      `"done?"` / `"fixed?"` tokenize to a single ack token after
 *      the trailing `?` is split out, and would be skipped despite
 *      being literal questions.
 *   5. ack-only rejects single-token bodies after stripping.
 *   6. Anything else short and signal-less is `no-reply-signal`.
 */
export function shouldQueueReviewThreadReply(args: {
  body: string | null | undefined
  authorLogin: string | null | undefined
  inReplyToId: number | null | undefined
}): ReviewReplyGateResult {
  if (isArcGithubLogin(args.authorLogin ?? null)) {
    return { ok: false, reason: "self" }
  }
  if (typeof args.inReplyToId !== "number") {
    return { ok: false, reason: "not-a-reply" }
  }

  const raw = typeof args.body === "string" ? args.body : ""
  const rawTrimmed = raw.trim()
  const cleaned = stripQuotesAndCode(raw).trim()
  if (cleaned.length === 0) {
    return { ok: false, reason: "empty" }
  }

  // Strong-signal short-circuits, scored against the RAW body so
  // inline-code-rich asks (e.g. `` `foo()` breaks `` after
  // stripQuotesAndCode strips the backticks) aren't silently lost
  // (code-review M1 catch). Order H1: these run BEFORE the
  // ack-only check so single-token questions like `"thanks?"`
  // queue correctly.
  if (rawTrimmed.endsWith("?")) return { ok: true }
  if (rawTrimmed.length >= LOW_SIGNAL_LENGTH_THRESHOLD) return { ok: true }
  for (const regex of REPLY_TRIGGER_REGEXES) {
    if (regex.test(rawTrimmed)) return { ok: true }
  }

  // No strong signal. Single-token-ack check runs on the CLEANED
  // body so a quoted Sigilix finding wrapped around `"fixed"` is
  // still classified as ack-only.
  const lowerCleaned = cleaned.toLowerCase()
  const tokens = lowerCleaned.split(/[\s.,!?:;]+/).filter((t) => t.length > 0)
  if (tokens.length <= 1) {
    const only = tokens[0] ?? ""
    if (ACK_TOKENS.has(only)) {
      return { ok: false, reason: "ack-only" }
    }
  }

  return { ok: false, reason: "no-reply-signal" }
}
