// SIG-304 (review CLI) Phase 1 — `--plain` output: one terse line per finding
// (`path:line  Pn  CATEGORY  TRUST  headline`), plus a one-line tally footer. No
// ANSI, no color — safe for any pipe. (Rich truecolor terminal output is a separate
// mode; this is the minimal grep-friendly form.)

import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import { type FindingView, viewsFor } from "./finding-view"

function line(v: FindingView): string {
  return `${v.path}:${v.line}  ${v.severity}  ${v.category.toUpperCase()}  ${v.trust}  ${v.headline}`
}

export function renderPlain(review: DryRunReview): string {
  const { inline, body } = viewsFor(review.verdict.findings, review.unanchoredFindings)
  const all = [...inline, ...body]
  if (all.length === 0) return "sigilix: no findings\n"
  const counts = all.reduce<Record<string, number>>(
    (acc, v) => ((acc[v.severity] = (acc[v.severity] ?? 0) + 1), acc),
    {},
  )
  const footer = ["P0", "P1", "P2", "P3"].map((s) => `${counts[s] ?? 0} ${s}`).join(" · ")
  return all.map(line).join("\n") + `\n\n${all.length} findings (${footer})\n`
}
