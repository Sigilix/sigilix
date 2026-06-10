// SIG-376 (SIG-318 Tier-1 6/8): the pure markdown/render cluster lifted
// out of `triage-pr-overview.ts` so that file stays under the 1,000-line
// budget. These functions are pure relocations — bodies are byte-identical
// to their prior in-file definitions; only the surrounding `export`
// keywords + the import paths differ.
//
// Pure module: no IO, no async, no env reads. Imports the `OVERVIEW_MARKER`
// constant from the sibling scan leaf (leaf → leaf, one-directional — the
// scan leaf never imports this one, so the dependency stays acyclic) and the
// verdict/context TYPES type-only from the core (erased at runtime, so no
// value cycle with the core). Pulls `WARMUP_CALLOUT_MARKER` from `./warmup`
// and the pre-merge-gates renderer + `GateResult` type from the shared
// domain module.
//
// `truncate` takes its byte budget (`max`) as an explicit parameter, so the
// core's `LIMITS` constant stays defined in the core and is passed in at the
// `buildPrompt` call sites — no LIMITS plumbing or duplication is required.

import { WARMUP_CALLOUT_MARKER } from "./warmup"
import {
  renderPreMergeGatesSection,
  type GateResult,
} from "@/src/shared/domain/pre-merge-gates"
import { OVERVIEW_MARKER } from "./triage-pr-overview-scan"
import type { PrOverviewReviewContext, PrOverviewVerdict } from "./triage-pr-overview"

/**
 * SIG-216: render the review-time context for the prompt. Compact —
 * one line per dimension so the model can scan it without spending
 * tokens. Severity / category orderings are deterministic so prompt
 * diffs stay stable.
 */
export function renderReviewContextBlock(ctx: PrOverviewReviewContext): string {
  const sevEntries = Object.entries(ctx.severityBreakdown)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const catEntries = Object.entries(ctx.categoryBreakdown)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const sevLine = sevEntries.length > 0
    ? sevEntries.map(([k, n]) => `${k}=${n}`).join(", ")
    : "(none)"
  const catLine = catEntries.length > 0
    ? catEntries.map(([k, n]) => `${k}=${n}`).join(", ")
    : "(none)"
  return [
    `Verdict: ${ctx.verdict}`,
    `Findings: ${ctx.findingsCount}`,
    `By severity: ${sevLine}`,
    `By category: ${catLine}`,
  ].join("\n")
}

export function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

interface FormatArgs {
  verdict: PrOverviewVerdict
  isFirstRun: boolean
  /** ARC-258 follow-up: `"pending"` renders a "warming up" callout
   *  block at the top of the overview when the indexer hasn't
   *  produced a manifest yet. `"none"` (default) omits the callout. */
  warmup?: "pending" | "none"
  /**
   * SIG-100: deterministic pre-merge gate results. Rendered as a
   * "Quality gates" checklist near the top of the body (just after
   * the effort badge). Empty array / missing → no section.
   */
  gateResults?: readonly GateResult[]
}

/**
 * Render the verdict into the markdown body posted on GitHub. The marker
 * on line 1 is what `findExistingOverviewComment` greps for to decide
 * between POST-new and PATCH-in-place.
 */
export function formatOverviewComment({
  verdict,
  isFirstRun,
  warmup = "none",
  gateResults = [],
}: FormatArgs): string {
  const lines: string[] = [OVERVIEW_MARKER, ""]
  lines.push("## Sigilix Overview")
  lines.push("")

  // ARC-258 follow-up + founder pivot (2026-05-17): warmup state is
  // tracked in the overview body but NOT rendered as customer-visible
  // text. Originally we surfaced a "> [!NOTE]" callout explaining the
  // diff-only first review, but the founder pulled the message — it
  // wasn't worth the visual noise on every cold-install PR. The
  // marker stays so `enqueueWarmupRerunsForIndex` can still grep PRs
  // that need the post-indexing rerun; the rerun itself is what
  // delivers the upgraded review, which is signal enough on its own.
  if (warmup === "pending") {
    lines.push(WARMUP_CALLOUT_MARKER)
    lines.push("")
  }

  // SIG-99: review-effort badge under the heading. Independent of
  // confidence — see PrOverviewVerdict.reviewEffort docs. Rendered as
  // a single bold-prefixed line so it picks up GitHub's normal weight
  // hierarchy without competing with the `### Summary` heading.
  if (typeof verdict.reviewEffort === "number") {
    lines.push(`**Effort:** ${verdict.reviewEffort}/5 ${effortLabel(verdict.reviewEffort)}`)
    lines.push("")
  }

  // SIG-100: pre-merge quality gates section. Placed BEFORE the
  // summary so a reviewer sees blocking-or-actionable gate results
  // first. Renders as a checklist with ✅ / ❌ / ⚠️ / ℹ️ glyphs per
  // gate severity. Skipped entirely when no gates ran.
  const gatesSection = renderPreMergeGatesSection(gateResults)
  if (gatesSection !== null) {
    lines.push(gatesSection)
    lines.push("")
  }

  lines.push(`### Summary${isFirstRun ? "" : " — latest push"}`)
  lines.push("")
  lines.push(verdict.summary)

  if (verdict.files.length > 0) {
    lines.push("")
    lines.push("### Important files")
    lines.push("")
    lines.push("| File | Score | Notes | Next step |")
    lines.push("| --- | :---: | --- | --- |")
    for (const f of verdict.files) {
      // Model output is interpolated into a markdown table — a literal
      // `|` in `overview` or `nextStep` would split the cell and corrupt
      // the table. Escape with `\|` per CommonMark.
      lines.push(
        `| \`${f.path}\` | ${f.score}/5 | ${escapeTableCell(f.overview) || "—"} | ${escapeTableCell(f.nextStep) || "—"} |`
      )
    }
  }

  // SIG-99: Mermaid sequence diagram. Placed AFTER the file table so
  // a reviewer scans (summary → files → flow); GitHub renders fenced
  // ```mermaid blocks natively.
  if (verdict.mermaidDiagram) {
    lines.push("")
    lines.push("### Sequence diagram")
    lines.push("")
    lines.push("```mermaid")
    lines.push(verdict.mermaidDiagram)
    lines.push("```")
  }

  lines.push("")
  lines.push(`### Confidence: ${verdict.confidence}/5`)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }

  if (verdict.bullets.length > 0) {
    lines.push("")
    for (const b of verdict.bullets) {
      lines.push(`- ${b}`)
    }
  }

  // SIG-99: footer trio (labels / reviewers / related). All optional;
  // rendered as compact one-liners so they don't compete with the
  // file table or summary. Placed at the bottom so a reviewer who's
  // already digested the body sees the metadata last (matches
  // CodeRabbit's information order).
  if (verdict.suggestedLabels && verdict.suggestedLabels.length > 0) {
    lines.push("")
    lines.push(`**Suggested labels:** ${verdict.suggestedLabels.map((l) => `\`${l}\``).join(" ")}`)
  }
  if (verdict.suggestedReviewers && verdict.suggestedReviewers.length > 0) {
    lines.push("")
    lines.push(`**Suggested reviewers:** ${verdict.suggestedReviewers.map((u) => `@${u}`).join(", ")}`)
  }
  if (verdict.relatedPrUrls && verdict.relatedPrUrls.length > 0) {
    lines.push("")
    lines.push("**Related context:**")
    for (const url of verdict.relatedPrUrls) {
      lines.push(`- ${url}`)
    }
  }

  return lines.join("\n")
}

/**
 * SIG-99: human-readable label for a review-effort score. Mirrors the
 * anchor in the prompt's `## Field guidelines` section. Pure.
 */
function effortLabel(effort: number): string {
  switch (effort) {
    case 1: return "_(trivial)_"
    case 2: return "_(small)_"
    case 3: return "_(medium)_"
    case 4: return "_(large)_"
    case 5: return "_(needs deep review)_"
    default: return ""
  }
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
