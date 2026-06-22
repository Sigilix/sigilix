// SIG-304 (review CLI) Phase 1 — the shared per-finding "view" the output modes
// render. Computes the display fields ONCE (severity pill, trust word, category)
// from the canonical engine helpers, so json / agent-markdown / plain / (later) rich
// all agree. Reuses `severityLabelForScore` + `trustWord` — no re-derivation.

import type { PrReviewFinding, CodeContext } from "@/src/shared/domain/pr-review-finding"
import { severityLabelForScore } from "@/src/lib/ensemble/domain/verdict"
import { trustWord } from "@/src/lib/trust-ledger-render"

export interface FindingView {
  path: string
  line: number
  startLine?: number
  anchorSide?: "LEFT"
  severity: "P0" | "P1" | "P2" | "P3"
  score: number
  category: string
  trust: "VERIFIED" | "REPRODUCED" | "GROUNDED" | "MODEL"
  headline: string
  body: string
  suggestedReplacement?: string
  /** SIG-162: shape of the proposed change; `"delete"` means remove the anchored range. */
  kind?: "delete" | "replace" | "insert" | "describe"
  /** SIG-304: runtime diff slice for the rich code panel (display evidence). */
  codeContext?: CodeContext
}

export function toFindingView(f: PrReviewFinding): FindingView {
  return {
    path: f.path,
    line: f.line,
    ...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
    ...(f.anchorSide !== undefined ? { anchorSide: f.anchorSide } : {}),
    severity: severityLabelForScore(f.score),
    score: f.score,
    category: f.category,
    trust: trustWord(f.trust),
    headline: f.headline,
    body: f.body,
    ...(f.suggestedReplacement !== undefined ? { suggestedReplacement: f.suggestedReplacement } : {}),
    ...(f.kind !== undefined ? { kind: f.kind } : {}),
    ...(f.codeContext !== undefined ? { codeContext: f.codeContext } : {}),
  }
}

/** Anchored findings + body-only (unanchored) findings, as views, in render order. */
export function viewsFor(
  verdictFindings: readonly PrReviewFinding[],
  unanchored: readonly PrReviewFinding[],
): {
  inline: FindingView[]
  body: FindingView[]
} {
  return {
    inline: verdictFindings.map(toFindingView),
    body: unanchored.map(toFindingView),
  }
}
