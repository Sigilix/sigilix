// Detect @-mentions of the bot ("Sigilix") in Linear comment bodies.
// Ported from rema-portal/tools/openclaw/lib/mention-detection.mjs. The
// mechanics are identical (markdown-quote stripping, code-fence
// stripping, regex match against trigger handles) — Linear's comment
// body is markdown just like GitHub's.
//
// Default triggers include the new `sigilix` handles AND every legacy
// alias (`arc`, `arc-copilot`, `openclaw`) so:
//   1. users typing @sigilix trigger the bot
//   2. comments left over from the Arc / OpenClaw eras still reply if
//      mentioned (no orphaned threads after the rebrand)
// Override with OPENCLAW_MENTION_TRIGGERS env var when the bot's
// display handle differs (env var name is internal infra and stays
// OPENCLAW_* for zero-config impact on existing deployments).

const DEFAULT_TRIGGERS = [
  // Current brand
  "sigilix",
  "sigilix[bot]",
  "Sigilix[bot]",
  // Legacy: Arc (pre-Sigilix rebrand). Kept so existing PR threads that
  // @-mention the old name still trigger the bot after the rebrand.
  "arc",
  "arc[bot]",
  "Arc[bot]",
  "arc-copilot",
  "arc-copilot[bot]",
  // Legacy: OpenClaw (pre-Arc rebrand). Same back-compat rationale.
  "openclaw",
  "openclaw[bot]",
  "OpenClaw[bot]",
]

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
 * Strict bot-handle detector. Returns true when the display name is
 * either:
 *
 *   1. Any handle ending in `[bot]` (Linear's standard suffix on OAuth
 *      app actors, GitHub's standard suffix on App-installed bots), or
 *   2. An exact match for "sigilix", "openclaw", or "arc" (with
 *      optional `[bot]` suffix), so legacy display names without the
 *      suffix still register as self across both pre-Sigilix rebrands.
 *
 * Single shared predicate used by:
 *   - Linear webhook self-author guard (src/index.ts) — skip Comment
 *     events authored by Sigilix itself to prevent reply loops.
 *   - mention-reply pipeline (src/lib/mention-reply.ts) — same purpose
 *     but checked after the GraphQL fetch.
 *
 * Previously the mention-pipeline check used a loose `/openclaw/i`
 * substring that incorrectly matched human display names containing
 * "openclaw" or "arch". Tightened on PR #15 after CodeRabbit caught
 * the inconsistency between the two call sites. The strict pattern is
 * what every caller should use going forward.
 */
export function isBotHandle(displayName: string | null | undefined): boolean {
  if (!displayName) return false
  return (
    /\[bot\]$/i.test(displayName) ||
    /^(sigilix|openclaw|arc)(\[bot\])?$/i.test(displayName)
  )
}

/**
 * Legacy alias preserved for callers that already imported this name.
 * Deprecated — new code should call isBotHandle() directly.
 */
export function isLikelyBotAuthor(displayName: string | null | undefined): boolean {
  return isBotHandle(displayName)
}

/**
 * Detect a CodeRabbit-authored handle. Used by the GitHub webhook
 * router to filter the pr-review re-run to CR's `pull_request_review.
 * submitted` events specifically (we re-run pr-review after CR
 * finishes its own review so Arc has CR's findings to compare
 * against).
 *
 * Pattern matches `coderabbitai`, `coderabbitai[bot]`, and
 * `coderabbit-staging[bot]`. Case-insensitive.
 */
export function isCodeRabbitAuthor(login: string | null | undefined): boolean {
  if (!login) return false
  return /^coderabbit/i.test(login)
}

/**
 * Strict self-bot login detector for the GitHub side. Matches the
 * current brand `sigilix[bot]` plus every legacy alias from the rebrand
 * chain: `arc[bot]`, `arc-copilot[bot]`, `openclaw[bot]`, and the bare
 * variants without the `[bot]` suffix.
 *
 * Used to skip self-authored @-mentions on GitHub PR threads — when
 * Sigilix posts a review summary that contains a "@sigilix" string in a
 * code-fenced suggestion or quoted prior comment, the resulting
 * webhook should NOT re-fire the mention handler. Tighter than
 * isBotHandle() which also matches CodeRabbit and other bots.
 *
 * Function name kept (`isArcGithubLogin`) for back-compat with imports
 * across the codebase. The semantics now cover Sigilix and every
 * legacy alias.
 */
export function isArcGithubLogin(login: string | null | undefined): boolean {
  if (!login) return false
  return /^(sigilix|arc|arc-copilot|openclaw)(\[bot\])?$/i.test(login)
}

/**
 * True if any review comment in the thread above (or at) `sourceId`
 * was authored by Arc. Powers "implicit mention" — once Arc has spoken
 * in a thread, replies in that thread don't need an explicit @-mention
 * to trigger a response. Without this, users have to retype @arc on
 * every back-and-forth, which feels broken next to CR's behavior.
 *
 * Walks the `in_reply_to_id` chain from `sourceId` up to the thread
 * root, checking the author of each visited comment. Source itself is
 * excluded (it's the asker's reply — checking its author would just be
 * the author guard which is handled at the webhook layer).
 *
 * Scoped to PR review-comment threads (real reply chains). Top-level
 * `issue_comment` events have no chain structure on GitHub's side, so
 * implicit-mention there would mean "Arc commented at any point on the
 * PR" → too eager; mention-only is the right default.
 */
export function arcInThreadAbove<
  T extends { id: number; in_reply_to_id?: number; user: { login: string } | null },
>(comments: T[], sourceId: number): boolean {
  const byId = new Map<number, T>()
  for (const c of comments) byId.set(c.id, c)
  const start = byId.get(sourceId)
  if (!start) return false
  let curId: number | undefined = start.in_reply_to_id
  // Visited-set defends against self-referential / cyclic chains
  // without a fixed iteration cap (a legitimate long thread can
  // exceed any small constant — a hard cap there would silently
  // skip Arc when it's truly above the source).
  const seen = new Set<number>()
  while (typeof curId === "number" && !seen.has(curId)) {
    seen.add(curId)
    const cur = byId.get(curId)
    if (!cur) return false
    if (isArcGithubLogin(cur.user?.login ?? null)) return true
    curId = cur.in_reply_to_id
  }
  return false
}
