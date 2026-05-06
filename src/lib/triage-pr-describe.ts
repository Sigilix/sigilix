// ARC-191: `/sigilix describe` handler. Single-shot LLM pass that
// drafts a PR description / internal changelog / external changelog
// from the PR's diff + metadata. Output is a top-level PR comment
// with visible markers around the draft body and a hidden
// machine-parsable `sigilix-meta` line for a future apply verb
// to anchor against.
//
// Differences from `handlePrImprove`:
//   - `createIssueComment` (top-level) instead of `submitReview`
//     (inline-anchored). Describe doesn't anchor to diff lines.
//   - Mode-keyed coalesce + dedupe so `internal` and `external`
//     on the same head don't suppress each other.
//   - Sensitive-repo gate posts a denial comment (improve drops
//     silently). Rationale: describe is invoked by an explicit
//     `/sigilix describe ...` from a known author who saw the ack;
//     silent-drop after ack is bad UX.
//   - PR body is NEVER written by v1. A future `/sigilix
//     describe apply` verb is what writes the body, using the
//     marker contract this module establishes.

import type { DescribeMode } from "./slash-commands"
import { describeModeFriendlyName } from "./slash-commands"

/**
 * Visible draft + hidden metadata, ready for `createIssueComment`.
 * The hidden `sigilix-meta` line is a single-line JSON object inside
 * an HTML comment, designed so the future apply verb can locate
 * exactly which previous comment owned a given marker pair.
 *
 * Pure — no env / no GitHub call. Tests exercise the snapshot.
 */
export function renderDescribeComment(args: {
  mode: DescribeMode
  headSha: string
  summary: string
  body: string
}): string {
  const { mode, headSha, summary, body } = args
  const friendly = describeModeFriendlyName(mode)
  const sha7 = headSha.slice(0, 7)
  const meta = JSON.stringify({
    kind: "describe",
    mode,
    headSha,
    schema: 1,
    source: "comment-draft",
  })
  return [
    `**Sigilix describe** — \`${friendly}\` draft`,
    "",
    summary,
    "",
    `<!-- sigilix:describe:${mode}:start -->`,
    body,
    `<!-- sigilix:describe:${mode}:end -->`,
    "",
    `<sub>Run on \`${sha7}\`. Copy the section between markers into the PR description / changelog. \`/sigilix describe apply\` (auto-write) coming in a follow-up.</sub>`,
    "",
    `<!-- sigilix-meta: ${meta} -->`,
  ].join("\n")
}

/**
 * Disabled-config branch. Posted when the per-repo
 * `sigilix.json` has `describe.enabled: false`. Visible signal
 * (rather than silent drop) because the user explicitly typed the
 * command and would otherwise wonder where the output went.
 */
export function renderDisabledComment(): string {
  return [
    "**Sigilix describe** — disabled in `sigilix.json` for this repo.",
    "",
    "Remove `describe.enabled: false` (or set it to `true`) at the PR head ref to re-enable.",
  ].join("\n")
}

/**
 * Sensitive-repo branch. Posted when `OPENCLAW_SENSITIVE_REPOS`
 * matches this owner/repo. Tells the user where to escalate
 * without leaking which other repos are on the denylist.
 */
export function renderSensitiveDenialComment(): string {
  return [
    "**Sigilix describe** — repository is on the Sigilix sensitive denylist.",
    "",
    "No content is sent to language models for this repo. Contact your Sigilix operator if this gating is unexpected.",
  ].join("\n")
}

/**
 * Unknown-arg branch. Posted directly from the webhook handler
 * (BEFORE enqueue / ack) when the mode arg fails to parse. Lists
 * the valid short tokens so the user can self-correct.
 *
 * Codex spec catch: silent fallback to `pr-description` would
 * post the wrong artifact when the user typed `/sigilix describe
 * internel` (typo for "internal"). The audience boundary between
 * internal and external is too important to swallow user typos.
 */
export function renderUsageComment(rawArg: string): string {
  return `**Sigilix describe** — unknown mode \`${rawArg}\`. Try \`pr\`, \`internal\`, or \`external\`.`
}

/**
 * Generic failure branch. Posted when model output fails to
 * parse, fails schema validation, or produces too-short
 * summary/body. Tells the user how to re-run.
 *
 * Resolved per Codex spec catch: post-and-return (NOT post-and-
 * rethrow). Re-throwing would trigger Cloudflare Queues retry,
 * which would re-run the handler, which would post another
 * failure comment — PR spam. The user re-runs explicitly via
 * `/sigilix describe <mode>` if they want to retry.
 */
export function renderFailureComment(mode: DescribeMode): string {
  const shortToken: Record<DescribeMode, string> = {
    "pr-description": "pr",
    "internal-changelog": "internal",
    "external-changelog": "external",
  }
  return `**Sigilix describe** — could not generate \`${mode}\` draft. Error logged; re-run \`/sigilix describe ${shortToken[mode]}\` to retry.`
}

/**
 * No-diff branch. Posted when the PR is closed/merged with no
 * fetchable diff, or the diff fetch returned empty. Avoids an
 * LLM call on input the model can't usefully process.
 */
export function renderNoChangesComment(prNumber: number): string {
  return `**Sigilix describe** — no changes to describe on PR #${prNumber}.`
}
