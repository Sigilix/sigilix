// SIG-304 (review CLI) Phase 1 — `--json` output: machine-readable findings for CI /
// scripting. Exposes proofTier + anchorSide + startLine, which neither CodeRabbit's
// nor Greptile's CLI surfaces.

import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import { viewsFor } from "./finding-view"

export function renderJson(review: DryRunReview): string {
  const { inline, body } = viewsFor(review.verdict.findings, review.unanchoredFindings)
  return JSON.stringify(
    {
      summary: review.verdict.summary,
      confidence: review.verdict.confidence,
      counts: {
        total: inline.length + body.length,
        inline: inline.length,
        body: body.length,
        bySeverity: tallyBySeverity([...inline, ...body]),
      },
      findings: inline,
      bodyFindings: body,
    },
    null,
    2,
  )
}

function tallyBySeverity(views: { severity: string }[]): Record<string, number> {
  const out: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const v of views) out[v.severity] = (out[v.severity] ?? 0) + 1
  return out
}
