// SIG-304 (review CLI) Phase 1 — `--ai` output: clean, deterministic markdown for an
// AI coding agent (Claude Code / Codex) to parse + act on. No ANSI, no images, no
// HTML <details> — just stable, greppable structure: `path:line — [Pn][CATEGORY]
// [TRUST] headline`, the body, and a fenced suggestion when present.

import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import { type FindingView, viewsFor } from "./finding-view"

function renderOne(v: FindingView): string {
  const base =
    v.startLine !== undefined && v.startLine !== v.line ? `${v.path}:${v.startLine}-${v.line}` : `${v.path}:${v.line}`
  const loc = v.anchorSide === "LEFT" ? `${base} (deleted line)` : base
  const tags = `[${v.severity}][${v.category}][${v.trust}]`
  const lines = [`### ${loc} — ${tags} ${v.headline}`, "", v.body.trim()]
  // A "delete" suggestion carries suggestedReplacement === "" (an empty fence = one-click
  // removal); render the intent so an agent doesn't lose the fix.
  if (v.kind === "delete") {
    lines.push("", "Suggested fix: delete the anchored line(s).")
  } else if (v.suggestedReplacement !== undefined && v.suggestedReplacement.length > 0) {
    lines.push("", "Suggested fix:", "```suggestion", v.suggestedReplacement, "```")
  }
  return lines.join("\n")
}

export function renderAgentMarkdown(review: DryRunReview): string {
  const { inline, body } = viewsFor(review.verdict.findings, review.unanchoredFindings)
  const all = [...inline, ...body]
  const out: string[] = [
    `# Sigilix review — ${all.length} finding${all.length === 1 ? "" : "s"}`,
    "",
    review.verdict.summary.trim(),
  ]
  // RECALL-SAFETY: an agent must know the review was PARTIAL (a specialist was
  // unavailable) so it doesn't treat "no findings" as a sign-off.
  if (review.incomplete) {
    out.push(
      "",
      `> ⚠ Partial review — ${review.incomplete.rolesMissing.join(", ")} specialist(s) unavailable. This is NOT a full sign-off; re-run before relying on a clean result.`,
    )
  }
  if (inline.length > 0) {
    out.push("", "## Inline findings", "", ...inline.map(renderOne))
  }
  if (body.length > 0) {
    out.push("", "## Cross-file / file-level findings", "", ...body.map(renderOne))
  }
  if (all.length === 0) out.push("", "_No findings._")
  return out.join("\n") + "\n"
}
