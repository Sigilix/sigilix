// Slash-command parser for `/sigilix <cmd> [args]` invocations in PR
// comments.
//
// Live commands:
//   - `/sigilix review`                     → re-trigger the ensemble (ARC-178)
//   - `/sigilix improve`                    → suggested-change patches (ARC-179)
//   - `/sigilix describe [mode]`            → draft PR description / changelog
//                                             posted as a comment (ARC-191)
//   - `/sigilix describe apply [mode]`      → same draft, but written back to
//                                             the PR body between markers
//                                             (ARC-264). Preserves user-
//                                             authored content outside the
//                                             marker fences across re-runs.
//   - `/sigilix help`                       → post a list of supported commands inline
//   - `/sigilix pause`                      → pause auto-review on this PR for 24h (SIG-98)
//   - `/sigilix resume`                     → clear pause/ignore flags (SIG-98)
//   - `/sigilix ignore`                     → permanently opt this PR out of auto-review (SIG-98)
//   - `/sigilix full review`                → re-review bypassing cumulative-diff dedup (SIG-98)
//   - `/sigilix resolve`                    → mark every Sigilix-rooted review thread as resolved (SIG-98)
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

export type DescribeMode = "pr-description" | "internal-changelog" | "external-changelog"

export type SlashCommand =
  | { cmd: "review" }
  | { cmd: "improve" }
  | { cmd: "help" }
  // ARC-191 + ARC-264: `apply` controls where the draft lands.
  // `apply: false` → post as a top-level comment (default; describe v1
  //                 behavior). `apply: true` → write back into the PR
  //                 body between marker fences, preserving content
  //                 outside the fences.
  | { cmd: "describe"; mode: DescribeMode; apply: boolean }
  | { cmd: "describe"; mode: "unknown"; rawArg: string; apply: boolean }
  // SIG-98 — competitive parity with CodeRabbit + PR-Agent. The five
  // tokens below all flip a per-PR review-lifecycle flag or kick a
  // dedup-bypassing review; each is its own ack + its own queue job
  // so the existing ACL gate + coalesce window apply uniformly.
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "ignore" }
  | { cmd: "full-review" } // parsed from the literal two-word "full review"
  | { cmd: "resolve" }
  // SIG-329 — operator abort for a stuck in-flight review. Unlike
  // pause/ignore (which gate FUTURE pushes), cancel terminates the
  // CURRENT run in the DO and closes its check without waiting on the
  // watchdog.
  | { cmd: "cancel" }
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
function parseDescribeMode(rawArg: string | undefined): { mode: DescribeMode } | { mode: "unknown"; rawArg: string } {
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
    // SIG-98: pause/resume/ignore/resolve are single-token; `full` is
    // a two-token command (`full review`). Anything else after the
    // single-token commands is ignored, matching the long-standing
    // "extra args after the command word are ignored" rule for
    // `/sigilix review` etc.
    if (head === "pause") {
      return { cmd: "pause" }
    }
    if (head === "resume") {
      return { cmd: "resume" }
    }
    if (head === "ignore") {
      return { cmd: "ignore" }
    }
    if (head === "resolve") {
      return { cmd: "resolve" }
    }
    if (head === "cancel") {
      // SIG-329 — single-token; extra args ignored like the others.
      return { cmd: "cancel" }
    }
    if (head === "full") {
      // SIG-98 — second token MUST be "review". Without it, `/sigilix
      // full` is meaningless; fall through to the "unsupported earlier
      // line" branch so a valid command on a later line still wins.
      const second = after.split(/\s+/)[1]?.toLowerCase() ?? ""
      if (second === "review") {
        return { cmd: "full-review" }
      }
      continue
    }
    if (head === "describe") {
      // ARC-264: `apply` is the first positional after `describe`.
      // Forms accepted:
      //   /sigilix describe                  → mode default, apply=false
      //   /sigilix describe <mode>           → mode parsed, apply=false
      //   /sigilix describe apply            → mode default, apply=true
      //   /sigilix describe apply <mode>     → mode parsed, apply=true
      //   /sigilix describe apply <bad-mode> → apply=true, mode=unknown
      //
      // `apply` itself is NOT a describe mode, so the mode parser
      // never sees the literal word "apply".
      //
      // Typo guard (code-review M4 catch): `/sigilix describe <mode>
      // apply` (apply after the mode) used to silently demote to
      // `apply=false`, giving the user a comment-mode draft when
      // they wanted apply-mode. Now treated as `mode=unknown` so
      // the usage comment surfaces the intended `apply <mode>`
      // shape instead of silently doing the wrong thing.
      const tokens = after
        .slice(head.length)
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
      let apply = false
      let modeRaw: string | undefined = tokens[0]
      if (modeRaw !== undefined && modeRaw.toLowerCase() === "apply") {
        apply = true
        modeRaw = tokens[1]
      } else if (tokens[1]?.toLowerCase() === "apply") {
        // Operator likely meant `apply <mode>` but typed `<mode>
        // apply`. Surface the usage error instead of silently
        // demoting to comment-mode.
        return {
          cmd: "describe",
          mode: "unknown",
          rawArg: `${tokens[0]} apply`,
          apply: false,
        }
      }
      const mode = parseDescribeMode(modeRaw)
      if (mode.mode === "unknown") {
        return { cmd: "describe", mode: "unknown", rawArg: mode.rawArg, apply }
      }
      return { cmd: "describe", mode: mode.mode, apply }
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
      // ARC-264: `apply: true` writes back to the PR body in place.
      // Copy chosen so it reads correctly on both first run (no
      // pre-existing markers) and re-runs (code-review L9 catch).
      if (cmd.apply) {
        return `Generating ${describeModeFriendlyName(cmd.mode)} draft via \`/sigilix describe apply\` and writing it to the PR body between marker fences. Existing PR-body content outside the marker fences will be preserved across re-runs.`
      }
      return `Generating ${describeModeFriendlyName(cmd.mode)} draft via \`/sigilix describe\`. Output will appear inline shortly.`
    case "pause":
      return "Sigilix auto-review paused on this PR for 24h. Comment `/sigilix resume` to re-enable sooner."
    case "resume":
      return "Sigilix auto-review re-enabled on this PR."
    case "ignore":
      return "Sigilix auto-review permanently disabled on this PR. Comment `/sigilix resume` to re-enable."
    case "full-review":
      return "Re-running ensemble review with cumulative-diff dedup bypass on the current head. Standard sticky comment will update when complete."
    case "resolve":
      return "Marking every Sigilix-authored review thread on this PR as resolved."
    case "cancel":
      return "Cancelling the in-progress Sigilix review on this PR. The check will be closed shortly. Push a new commit or comment `/sigilix review` to start a fresh run."
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
    "| `/sigilix full review` | Re-run the ensemble review and bypass the cumulative-diff dedup gate (use when a re-run is suppressed because the diff hasn't changed). |",
    "| `/sigilix improve` | Generate apply-able GitHub suggested-change comments (single-shot, narrow scope). |",
    "| `/sigilix describe` | Draft a PR description or internal / external changelog. Posted as an inline comment with markers — body is not edited. |",
    "| `/sigilix describe apply` | Same draft, but written back to the PR body in place between marker fences. Content outside the markers is preserved across re-runs. |",
    "| `/sigilix pause` | Pause auto-review on this PR for 24 hours. New pushes skip the ensemble until the window expires or `/sigilix resume` runs. |",
    "| `/sigilix resume` | Re-enable auto-review on this PR (clears both pause and ignore flags). |",
    "| `/sigilix ignore` | Permanently opt this PR out of auto-review. Reversible via `/sigilix resume`. |",
    "| `/sigilix resolve` | Mark every Sigilix-authored review thread on this PR as resolved. |",
    "| `/sigilix cancel` | Abort the in-progress review on this PR and close its check immediately (without waiting for the watchdog). |",
    "| `/sigilix help` | Show this list. |",
    "",
    "`/sigilix describe` accepts an optional mode arg: `pr` (default), `internal`, or `external`. Example: `/sigilix describe internal`.",
    "",
    "`/sigilix describe apply` accepts the same mode arg after `apply`. Example: `/sigilix describe apply external`. The first run writes a new marker-fenced block at the end of the PR body; subsequent runs replace only the content between the matching markers, leaving anything you've written outside untouched.",
    "",
    "Slash commands are gated to `OWNER`, `MEMBER`, and `COLLABORATOR` authors. Match must be at the start of a line; commands inside fenced code blocks or markdown blockquotes are ignored.",
    "",
    "Coming soon: `/sigilix ask <question>` (PR-context Q&A).",
  ].join("\n")
}

/**
 * ACL gate predicate for slash commands. Only `OWNER`, `MEMBER`, and
 * `COLLABORATOR` author associations are trusted — they have explicit
 * write or maintainer relationships with the repo. `CONTRIBUTOR` is
 * intentionally excluded: anyone whose PR has ever merged becomes
 * `CONTRIBUTOR` forever, which is too broad a circle for a privileged
 * channel that triggers LLM calls and posts comments.
 *
 * Pure — extracted from src/index.ts so the gate has direct unit
 * coverage (Kimi spec catch on ARC-191). The webhook handler still
 * owns the response (403 + telemetry log) but delegates the
 * decision to this helper.
 */
const ALLOWED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

export function isAuthorAllowedForSlashCommand(association: string | null | undefined): boolean {
  if (typeof association !== "string" || association.length === 0) return false
  return ALLOWED_AUTHOR_ASSOCIATIONS.has(association.toUpperCase())
}
