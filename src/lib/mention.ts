// Detect @-mentions of OpenClaw in Linear comment bodies. Ported from
// rema-portal/tools/openclaw/lib/mention-detection.mjs. The mechanics
// are identical (markdown-quote stripping, code-fence stripping, regex
// match against trigger handles) — Linear's comment body is markdown
// just like GitHub's.
//
// Default triggers cover both the OAuth app slug and the [bot]-suffixed
// form, so users can @ either one. Override with OPENCLAW_MENTION_TRIGGERS
// env var when the bot's display handle changes.

const DEFAULT_TRIGGERS = ["openclaw", "openclaw[bot]", "OpenClaw[bot]"]

export function getMentionTriggers(envValue?: string): string[] {
  const raw = envValue?.trim()
  if (!raw) return DEFAULT_TRIGGERS
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : DEFAULT_TRIGGERS
}

/**
 * Strip markdown blockquotes, fenced code blocks, AND inline backtick
 * spans from a comment body so a quoted prior message OR an in-code
 * reference like `@openclaw` doesn't re-trigger us. Linear's "Quote"
 * action inserts `> @openclaw` lines verbatim — without this the bot
 * loops on its own quoted self-mention.
 */
export function stripQuotesAndCode(body: string): string {
  if (typeof body !== "string") return ""
  let out = body.replace(/```[\s\S]*?```/g, "")
  out = out.replace(/`[^`\n]*`/g, "")
  out = out
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
  return out
}

/**
 * True if the (cleaned) body contains a real mention of any trigger.
 * Avoids matching email-like suffixes (`openclaw@example.com`), inline
 * code, and quoted prior messages.
 */
export function bodyMentionsBot(body: string, triggers: string[]): boolean {
  const cleaned = stripQuotesAndCode(body)
  for (const handle of triggers) {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`(^|[^a-zA-Z0-9_/-])@${escaped}(?![a-zA-Z0-9._-])`, "i")
    if (re.test(cleaned)) return true
  }
  return false
}

/**
 * Strip the @-mention from the body so the prompt gets clean text.
 * Handles `@openclaw`, `@openclaw[bot]`, optional trailing comma.
 *
 * Triggers are sorted by length descending so longer handles (e.g.
 * `openclaw[bot]`) get matched before their prefixes (`openclaw`) —
 * otherwise stripping `@openclaw` from `@openclaw[bot]` leaves a
 * dangling `[bot]` in the question text.
 */
export function stripMentionFromBody(body: string, triggers: string[]): string {
  if (typeof body !== "string") return ""
  const sorted = [...triggers].sort((a, b) => b.length - a.length)
  let out = body
  for (const handle of sorted) {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`@${escaped}\\s*,?\\s*`, "gi")
    out = out.replace(re, "")
  }
  return out.trim()
}

/**
 * Heuristic for "is this comment authored by a bot." Linear identifies
 * the bot by the OAuth app actor having `[bot]` in the displayName.
 * Skip-self protection so the bot never replies to its own past replies.
 */
export function isLikelyBotAuthor(displayName: string | null | undefined): boolean {
  if (!displayName) return false
  return /\[bot\]$/i.test(displayName) || /openclaw/i.test(displayName)
}
