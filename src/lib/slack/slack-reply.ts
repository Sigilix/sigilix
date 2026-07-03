// SIG-196: Slack agent — pure intent detection + reply formatting.
// No I/O — all functions are pure / synchronous so they're trivially testable.

// ─── Intent ──────────────────────────────────────────────────────────────────

export type SlackIntent = { kind: "qa" } | { kind: "linear-triage" } | { kind: "implement" }

/** IMPERATIVE requests to IMPLEMENT something — create a ticket, self-assign, and
 *  dispatch the agent-runner to open a PR (SIG-545 B3b). Conservative ON PURPOSE:
 *  this is a side-effectful action, so a QUESTION ("how would you implement this?",
 *  "can you do this?") must NOT trigger it — those fall through to qa, where the
 *  offer/confirm flow (B3c) handles them conversationally. Checked first. */
const IMPLEMENT_PATTERNS: RegExp[] = [
  /\b(implement|build|ship) (this|it|that)\b/i,
  /\bopen a (pr|pull request) for (this|it|that)\b/i,
  /\b(make|do) (this|it|that) for (us|me)\b/i,
]

/** A question is never an implement directive — guards the side-effectful path.
 *  Wh-words at the start, an auxiliary + subject pronoun ("can you", "do you",
 *  "should we"), or a trailing "?" mark a question. The pronoun requirement keeps
 *  imperatives like "do this for us" / "make it" out of the interrogative class. */
const INTERROGATIVE =
  /(^\s*(how|what|why|when|which|who)\b)|(^\s*(can|could|would|should|do|does|did|will|is|are)\s+(you|we|i|they|he|she|it)\b)|\?\s*$/i

/** Keywords that indicate the user wants a Linear triage issue created.
 *  Matched case-insensitively against the normalised mention text. */
const TRIAGE_PATTERNS: RegExp[] = [/make a linear triage/i, /create a linear issue/i, /triage this/i, /linear triage/i]

/**
 * Detect the user's intent from the stripped mention text.
 *
 * Order matters: implement (most specific action) is checked first, then
 * linear-triage, then the `{ kind: "qa" }` fallback for everything else.
 */
export function detectSlackIntent(mentionText: string): SlackIntent {
  const text = mentionText.trim()
  // A question never triggers the side-effectful implement path — it falls to qa,
  // where Sigilix can answer and OFFER to open a PR (the B3c offer/confirm flow).
  if (!INTERROGATIVE.test(text)) {
    for (const pattern of IMPLEMENT_PATTERNS) {
      if (pattern.test(text)) {
        return { kind: "implement" }
      }
    }
  }
  for (const pattern of TRIAGE_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: "linear-triage" }
    }
  }
  return { kind: "qa" }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Wrap a model-generated body in the Sigilix Slack voice.
 * - Body is rendered verbatim (no branding footer).
 * - A `provenance` marker (e.g. "degraded") is appended as a subtle italic line
 *   when provided — a recall-safety signal so a degraded reply never reads as
 *   authoritative. Absent it, the body is returned as-is.
 * - Never says "slack bot" — voice matches the agent system prompt (senior
 *   teammate, direct, technical).
 */
export function formatSigilixReply(body: string, opts?: { provenance?: string }): string {
  const trimmedBody = body.trim()
  if (opts?.provenance) {
    return `${trimmedBody}\n\n_${opts.provenance}_`
  }
  return trimmedBody
}
