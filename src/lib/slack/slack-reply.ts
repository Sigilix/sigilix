// SIG-196: Slack agent — pure intent detection + reply formatting.
// No I/O — all functions are pure / synchronous so they're trivially testable.

// ─── Intent ──────────────────────────────────────────────────────────────────

export type SlackIntent = { kind: "qa" } | { kind: "linear-triage" }

/** Keywords that indicate the user wants a Linear triage issue created.
 *  Matched case-insensitively against the normalised mention text. */
const TRIAGE_PATTERNS: RegExp[] = [/make a linear triage/i, /create a linear issue/i, /triage this/i, /linear triage/i]

/**
 * Detect the user's intent from the stripped mention text.
 *
 * Returns `{ kind: "linear-triage" }` when the text matches any known triage
 * phrase; falls back to `{ kind: "qa" }` for everything else.
 */
export function detectSlackIntent(mentionText: string): SlackIntent {
  for (const pattern of TRIAGE_PATTERNS) {
    if (pattern.test(mentionText)) {
      return { kind: "linear-triage" }
    }
  }
  return { kind: "qa" }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const FOOTER_DIVIDER = "\n\n---"
const FOOTER_TEXT = "_Sigilix · powered by your codebase_"

/**
 * Wrap a model-generated body in the Sigilix Slack voice.
 * - Body is rendered verbatim.
 * - A subtle footer is appended.
 * - Never says "slack bot" — voice matches the agent system prompt (senior
 *   teammate, direct, technical).
 */
export function formatSigilixReply(body: string, opts?: { provenance?: string }): string {
  const trimmedBody = body.trim()
  const provenance = opts?.provenance ? ` · ${opts.provenance}` : ""
  return `${trimmedBody}${FOOTER_DIVIDER}\n${FOOTER_TEXT}${provenance}`
}
