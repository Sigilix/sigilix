// Slash-command parser for `/sigilix <cmd> [args]` invocations in PR
// comments.
//
// Live commands:
//   - `/sigilix review`              → re-trigger the ensemble (ARC-178)
//   - `/sigilix improve`             → suggested-change patches (ARC-179)
//   - `/sigilix describe [mode]`     → draft PR description / changelog (ARC-191)
//   - `/sigilix help`                → post a list of supported commands inline
//
// Deferred to follow-up issues:
//   - `/sigilix ask <q>`  — Q&A using PR context + RAG
//
// Recognition rules:
//   - Match must be at the start of a line (after leading whitespace),
//     so quoted/inline references don't trigger
//   - Case-insensitive on the command word
//   - Requires the `/sigilix ` literal — not just `@sigilix` (which
//     keeps Q&A-style mentions on the existing reply path)
//   - Stripping markdown blockquotes + fenced code blocks is the
//     caller's responsibility (mirrors `bodyMentionsBot`'s contract)

export type DescribeMode =
  | "pr-description"
  | "internal-changelog"
  | "external-changelog"

export type SlashCommand =
  | { cmd: "review" }
  | { cmd: "improve" }
  | { cmd: "help" }
  | { cmd: "describe"; mode: DescribeMode }
  | { cmd: "describe"; mode: "unknown"; rawArg: string }
  // Reserved shape (parser doesn't return this yet — adding the
  // type when handlers exist will surface missed dispatch cases via
  // the exhaustive switch in renderSlashCommandAck):
  // | { cmd: "ask"; query: string }

/**
 * Map the trailing arg of `/sigilix describe <arg>` to a canonical mode.
 * Short tokens (`pr` / `internal` / `external`) are the user-facing form;
 * canonical names are used in JSON schemas + telemetry + the apply
 * marker. Unknown args map to a sentinel so the handler can post a
 * usage comment instead of silently defaulting (Codex spec catch:
 * audience boundary between internal/external is too important to
 * swallow user typos).
 */
function parseDescribeMode(rawArg: string | undefined):
  | { mode: DescribeMode }
  | { mode: "unknown"; rawArg: string }
{
  if (rawArg === undefined || rawArg.length === 0) {
    return { mode: "pr-description" }
  }
  const lower = rawArg.toLowerCase()
  if (lower === "pr") return { mode: "pr-description" }
  if (lower === "internal") return { mode: "internal-changelog" }
  if (lower === "external") return { mode: "external-changelog" }
  return { mode: "unknown", rawArg }
}

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
 *   "/sigilix review please"     → { cmd: "review" } (extra args ignored)
 *   "Hey /sigilix review"        → null (not at line start)
 *   "@sigilix review"            → null (mention != slash command)
 *   "/sigilix ask anything"      → null (unsupported in this version)
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
    if (head === "improve") {
      return { cmd: "improve" }
    }
    if (head === "help") {
      return { cmd: "help" }
    }
    if (head === "describe") {
      const argRaw = after.slice(head.length).trim().split(/\s+/)[0]
      const mode = parseDescribeMode(argRaw)
      if (mode.mode === "unknown") {
        return { cmd: "describe", mode: "unknown", rawArg: mode.rawArg }
      }
      return { cmd: "describe", mode: mode.mode }
    }
    // Recognized prefix (`/sigilix ...`) but unsupported subcommand.
    // Continue scanning later lines — a comment that opens with an
    // unknown subcommand should still execute a valid one further
    // down (sigilix-bot self-review catch on PR #58: returning null
    // here would let an unsupported earlier line suppress a
    // supported later one).
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
 *
 * For `describe` the mode is part of the ack so the user knows
 * which artifact is coming. For unknown describe args we return
 * the usage comment (NOT silent fallback per Codex spec catch).
 */
export function renderSlashCommandAck(cmd: SlashCommand): string {
  switch (cmd.cmd) {
    case "review":
      return "Re-running ensemble review on the current head. Standard sticky comment will update when complete."
    case "improve":
      return "Generating suggested-change patches against the current head. Apply-able suggestions will appear inline shortly."
    case "help":
      // Help is its own answer — the queue handler posts the full
      // command list directly. No separate ack needed; the help body
      // doubles as the ack.
      return renderHelpBody()
    case "describe":
      if (cmd.mode === "unknown") {
        return `**Sigilix describe** — unknown mode \`${cmd.rawArg}\`. Try \`pr\`, \`internal\`, or \`external\`.`
      }
      return `Generating ${describeModeFriendlyName(cmd.mode)} draft via \`/sigilix describe\`. Output will appear inline shortly.`
    default: {
      const _exhaustive: never = cmd
      return _exhaustive
    }
  }
}

/**
 * Human-readable label for a describe mode. Used in ack + comment
 * headers + telemetry-friendly logs. Pure mapping; tested via the
 * snapshot tests downstream.
 */
export function describeModeFriendlyName(mode: DescribeMode): string {
  switch (mode) {
    case "pr-description":
      return "PR description"
    case "internal-changelog":
      return "internal changelog"
    case "external-changelog":
      return "external changelog"
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
    "| `/sigilix improve` | Generate apply-able GitHub suggested-change comments (single-shot, narrow scope). |",
    "| `/sigilix describe` | Draft a PR description or internal / external changelog. Posted as an inline comment with markers — body never auto-edited. |",
    "| `/sigilix help` | Show this list. |",
    "",
    "`/sigilix describe` accepts an optional mode arg: `pr` (default), `internal`, or `external`. Example: `/sigilix describe internal`.",
    "",
    "Slash commands are gated to `OWNER`, `MEMBER`, and `COLLABORATOR` authors. Match must be at the start of a line; commands inside fenced code blocks or markdown blockquotes are ignored.",
    "",
    "Coming soon: `/sigilix ask <question>` (PR-context Q&A).",
  ].join("\n")
}
