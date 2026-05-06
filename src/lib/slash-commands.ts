// Slash-command parser for `/sigilix <cmd> [args]` invocations in PR
// comments.
//
// Live commands:
//   - `/sigilix review`  → re-trigger the ensemble (ARC-178)
//   - `/sigilix help`    → post a list of supported commands inline
//
// Deferred to follow-up issues:
//   - `/sigilix improve`  — suggested-change patches (ARC-179, in flight)
//   - `/sigilix ask <q>`  — Q&A using PR context + RAG
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
  | { cmd: "help" }
  // Reserved shapes (parser doesn't return these yet — adding the
  // type when handlers exist will surface missed dispatch cases via
  // the exhaustive switch in renderSlashCommandAck):
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
    if (head === "help") {
      return { cmd: "help" }
    }
    // Recognized prefix (`/sigilix ...`) but unsupported subcommand.
    // Continue scanning later lines — a comment that opens with
    // `/sigilix help` followed by `/sigilix review` should still
    // execute the review (sigilix-bot self-review catch on PR #58:
    // returning null here would let an unsupported earlier line
    // suppress a supported later one). When v2 adds the missing
    // subcommands they get recognized in the branches above; until
    // then, the README documents the limitation rather than papering
    // over it with a synthetic ack.
    continue
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
    case "help":
      // Help is its own answer — the queue handler posts the full
      // command list directly. No separate ack needed; the help body
      // doubles as the ack.
      return renderHelpBody()
    default: {
      const _exhaustive: never = cmd
      return _exhaustive
    }
  }
}

/**
 * Static help-comment body listing the slash commands Sigilix
 * currently understands. Added to the public surface so callers
 * (the help handler itself, future docs scrapers, tests) all share
 * one source of truth — keep this in sync with the README's
 * "Slash commands" section when adding a command.
 */
export function renderHelpBody(): string {
  return [
    "**Sigilix slash commands**",
    "",
    "| Command | Effect |",
    "|---|---|",
    "| `/sigilix review` | Re-run the ensemble review against the PR's current head SHA. |",
    "| `/sigilix help` | Show this list. |",
    "",
    "Slash commands are gated to `OWNER`, `MEMBER`, and `COLLABORATOR` authors. Match must be at the start of a line; commands inside fenced code blocks or markdown blockquotes are ignored.",
    "",
    "Coming soon: `/sigilix improve` (apply-able patches), `/sigilix ask <question>` (PR-context Q&A), `/sigilix describe` (PR description draft).",
  ].join("\n")
}
