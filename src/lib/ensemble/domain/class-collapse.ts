// SIG-392 — deterministic class-redundancy collapse (pure domain).
//
// The recall-eliciting logic prompt (OPENCLAW_LOGIC_RECALL_MODE) reports the
// SAME bug-CLASS once per occurrence — measured: "an awaited DB/IO call with no
// try/catch" emitted as 6 separate findings, one per handler at lines spanning
// the file. The class SURVIVES every existing mechanism: the near-dup collapse
// requires same path + |Δline|<=5 (these are the same class >5 lines apart,
// across handlers), and coverage-stamp-collapse only handles the testing class.
// So the guarantee is code: 3+ findings of one curated class (anywhere in the
// PR) collapse into one pr-scope finding listing every location. Runs as the
// stage AFTER collapseCoverageStamps in applyRecallFloors — same
// no-resurrection-by-ordering guarantee. Mirrors coverage-stamp-collapse.
// Spec: docs/superpowers/specs/2026-06-12-sig392-class-collapse-gate-spec.md

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

/** Curated collapsible classes. START with the one observed offender
 *  (missing-error-handling); add classes only as shadow telemetry surfaces
 *  them — a generic "similar headline" merge is the recall-unsafe trap the
 *  SIG-392 dedup-floor investigation already rejected. */
const CLASS_SIGNATURES: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: "missing-error-handling",
    re: /\b(no|missing|lacks?|without|absent)\b[^.]{0,40}\b(try\s*\/?\s*catch|error[-\s](handling|handler|middleware|wrapper|boundary))\b|unhandled\s+(promise\s+)?rejection/i,
  },
]

// A finding that names a SPECIFIC downstream consequence is a distinct bug, not
// a pure class stamp — never collapse it (a "no try/catch → double-charge"
// finding is the double-charge bug, not generic missing-error-handling). The
// falsifier for edits is the pinned regression in class-collapse.test.ts.
const SPECIFIC_CONSEQUENCE_TOKENS =
  /(double[-\s]?(charge|count|appl)|data\s+loss|loses?\s+|injection|race|over[-\s]?refund|wrong|incorrect|leaks?|bypass|off[-\s]by[-\s]one|overflow|stale|deadlock)/i

/** The collapsible class of a finding, or null. Gated on the HEADLINE only
 *  (the recall prompt emits an unstable `error-handling` category not in the
 *  standard set, so category is not a reliable signal here). */
export function collapsibleClassOf(f: PrReviewFinding): string | null {
  const headline = f.headline ?? ""
  if (SPECIFIC_CONSEQUENCE_TOKENS.test(headline)) return null
  for (const c of CLASS_SIGNATURES) {
    if (c.re.test(headline)) return c.id
  }
  return null
}

/** Minimum same-class findings to collapse — 3+, so a PAIR stays the near-dup
 *  collapse's job and a lone instance is untouched. */
export const CLASS_COLLAPSE_MIN = 3

export interface ClassCollapseResult<P> {
  findings: PrReviewFinding[]
  provenanceFindings: P[]
  collapsed: ReadonlyArray<{ classId: string; keptHeadline: string; collapsedCount: number; locations: string[] }>
}

/**
 * Collapse each curated class with `>= CLASS_COLLAPSE_MIN` findings into ONE
 * pr-scope survivor: the highest-score finding of the class survives (tie →
 * earliest index) with one appended body line listing the other findings'
 * `path:line` locations and the ascending union of all collapsed provenance
 * sourceFindingIds. Distinct classes collapse independently. Below-threshold
 * classes + every non-class finding pass through untouched; the no-collapse
 * case returns the inputs by reference. `findings[i]` ↔ `provenanceFindings[i]`
 * alignment is preserved. Recall-safe: one survivor still represents the class.
 */
export function collapseClassRedundantFindings<P extends { sourceFindingIds: ReadonlyArray<string> }>(
  findings: ReadonlyArray<PrReviewFinding>,
  provenanceFindings: ReadonlyArray<P>,
): ClassCollapseResult<P> {
  // Group finding indexes by collapsible class.
  const byClass = new Map<string, number[]>()
  for (let i = 0; i < findings.length; i++) {
    const cls = collapsibleClassOf(findings[i]!)
    if (cls === null) continue
    const arr = byClass.get(cls) ?? []
    arr.push(i)
    byClass.set(cls, arr)
  }

  // Per class: the kept index + the dropped indexes (only for classes at/above
  // the threshold). Distinct classes are independent.
  const keepByClass = new Map<string, number>()
  const droppedSet = new Set<number>()
  const collapsed: Array<{ classId: string; keptHeadline: string; collapsedCount: number; locations: string[] }> = []
  for (const [classId, idxs] of byClass) {
    if (idxs.length < CLASS_COLLAPSE_MIN) continue
    let keepIdx = idxs[0]!
    for (const i of idxs) {
      if (findings[i]!.score > findings[keepIdx]!.score) keepIdx = i
    }
    keepByClass.set(classId, keepIdx)
    const dropped = idxs.filter((i) => i !== keepIdx)
    for (const i of dropped) droppedSet.add(i)
    const locations = [...new Set(dropped.map((i) => `${findings[i]!.path}:${findings[i]!.line}`))].sort()
    collapsed.push({ classId, keptHeadline: findings[keepIdx]!.headline, collapsedCount: dropped.length, locations })
  }

  if (collapsed.length === 0) {
    return {
      findings: findings as PrReviewFinding[],
      provenanceFindings: provenanceFindings as P[],
      collapsed: [],
    }
  }

  // Union of every collapsed class's provenance ids, keyed to its survivor.
  const mergedIdsByKeep = new Map<number, string[]>()
  for (const [classId, keepIdx] of keepByClass) {
    const idxs = byClass.get(classId)!
    mergedIdsByKeep.set(
      keepIdx,
      [...new Set(idxs.flatMap((i) => provenanceFindings[i]?.sourceFindingIds ?? []))].sort(),
    )
  }
  const locationsByKeep = new Map<number, string[]>()
  for (const c of collapsed) {
    // find this class's keep index
    const keepIdx = keepByClass.get(c.classId)!
    locationsByKeep.set(keepIdx, c.locations)
  }

  const outFindings: PrReviewFinding[] = []
  const outProvenance: P[] = []
  for (let i = 0; i < findings.length; i++) {
    if (droppedSet.has(i)) continue
    const mergedIds = mergedIdsByKeep.get(i)
    if (mergedIds !== undefined) {
      const kept = findings[i]!
      const locs = locationsByKeep.get(i) ?? []
      const survivor: PrReviewFinding = {
        ...kept,
        scope: "pr",
        // Lock the scope so the inline-first promotion does not anchor this
        // aggregate to the one kept finding's inherited line.
        scopeLocked: true,
        body: locs.length > 0 ? `${kept.body}\n\nAlso at: ${locs.map((l) => `\`${l}\``).join(", ")}` : kept.body,
      }
      outFindings.push(survivor)
      outProvenance.push({ ...(provenanceFindings[i] as P), sourceFindingIds: mergedIds })
    } else {
      outFindings.push(findings[i]!)
      outProvenance.push(provenanceFindings[i] ?? ({ sourceFindingIds: [] } as unknown as P))
    }
  }
  // Telemetry cardinality cap: first 10 locations per class.
  return {
    findings: outFindings,
    provenanceFindings: outProvenance,
    collapsed: collapsed.map((c) => ({ ...c, locations: c.locations.slice(0, 10) })),
  }
}
