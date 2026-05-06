// ARC-178: slash-command parser for `/sigilix <cmd> [args]` invocations
// in PR comments.
//
// v1 scope (ship now):
//   - `/sigilix review` → re-trigger the ensemble on the PR's current
//     head SHA. Useful when a reviewer wants a fresh review without
//     pushing a no-op commit (e.g., the bot's prior review missed
//     something obvious and they want it to retry).
//
// v2+ (deferred to follow-up issues):
//   - `/sigilix ask <question>` — Q&A using existing PR context + RAG
//   - `/sigilix improve` — emit GitHub suggested-change comments
//   - `/sigilix describe` — draft a PR description / changelog
//
// Recognition rules:
//   - Match must be at the start of a line (after leading whitespace),
//     so quoted/inline references don't trigger
//   - Case-insensitive on the command word
//   - Requires the `/sigilix ` literal — not just `@sigilix` (which
//     keeps Q&A-style mentions on the existing reply path)
//   - Stripping markdown blockquotes + fenced code blocks is the
//     caller's responsibility (mirrors `bodyMentionsBot`'s contract)

export type SlashCommand =
  | { cmd: "review" }
  // v2 reserved shapes (parser doesn't return these yet — adding the
  // type now keeps the dispatch table forward-compat once handlers
  // exist):
  // | { cmd: "ask"; query: string }
  // | { cmd: "improve" }
  // | { cmd: "describe" }

/**
 * Parse a comment body for a `/sigilix <cmd>` invocation. Returns
 * `null` when no recognized command is present at a line start.
 *
 * Caller should pass the cleaned body (quotes + fenced code stripped
 * via `stripQuotesAndCode`); this function does NOT do that itself.
 *
 * Recognition examples (all case-insensitive on the command):
 *   "/sigilix review"            → { cmd: "review" }
 *   "  /sigilix review  "        → { cmd: "review" } (leading ws ok)
 *   "/Sigilix REVIEW"            → { cmd: "review" }
 *   "/sigilix review please"     → { cmd: "review" } (extra args ignored in v1)
 *   "Hey /sigilix review"        → null (not at line start)
 *   "@sigilix review"            → null (mention != slash command)
 *   "/sigilix ask anything"      → null (v1 only handles review)
 */
export function parseSlashCommand(body: string): SlashCommand | null {
  if (typeof body !== "string" || body.length === 0) return null
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim()
    const lower = line.toLowerCase()
    if (!lower.startsWith("/sigilix ") && lower !== "/sigilix") continue
    const after = line.slice("/sigilix".length).trim()
    const head = after.split(/\s+/)[0]?.toLowerCase() ?? ""
    if (head === "review") {
      return { cmd: "review" }
    }
    // Recognized prefix (`/sigilix ...`) but unsupported subcommand.
    // Returning null here means the caller's ONLY fallback is the
    // existing @-mention pipeline — and that requires an explicit
    // `@sigilix` somewhere else in the body. A bare `/sigilix help`
    // (no @-mention) currently goes silently nowhere. When v2 adds
    // help/ask/improve, expose them here; until then, the README
    // documents the limitation rather than papering over it with a
    // synthetic ack.
    return null
  }
  return null
}

/**
 * Render the ack message Sigilix posts in response to a recognized
 * slash command. Kept terse — the actual review/answer comes
 * through the standard pipeline a moment later.
 *
 * Uses an exhaustive switch so adding a new SlashCommand variant
 * surfaces as a tsc error here (via the `never` assignment), rather
 * than silently routing to a generic "Acknowledged." fallback.
 */
export function renderSlashCommandAck(cmd: SlashCommand["cmd"]): string {
  switch (cmd) {
    case "review":
      return "Re-running ensemble review on the current head. Standard sticky comment will update when complete."
    default: {
      const _exhaustive: never = cmd
      return _exhaustive
    }
  }
}
