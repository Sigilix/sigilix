// SIG-392 — deterministic cross-file coverage-stamp collapse (pure domain).
//
// PR #494's 13-PR real-world batch measured 12 tests-category findings / 0
// real — almost all per-file "ships without tests" stamps — "the entire
// precision gap". The class survives every existing mechanism: the tests
// gate is enforce-but-DEMOTE (SIG-245), the near-dup collapse requires same
// path+line (stamps span FILES), and the prompt-side aggregation rule binds
// only as well as the synth model obeys it. So the guarantee is code: 2+
// pure coverage stamps collapse into one pr-scope finding listing every
// path. Runs as the stage AFTER collapseNearDuplicateFindings in
// applyRecallFloors — same no-resurrection-by-ordering guarantee. Spec:
// docs/superpowers/specs/2026-06-12-sig392-coverage-stamp-collapse-spec.md

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

const COVERAGE_CLASS =
  /(without (any |a single )?(unit )?tests?|no test coverage|test coverage|untested|lacks (unit )?tests?)/i

// Conservative negative gate: a testing finding naming a concrete failure
// mechanism is NEVER a pure stamp. Manual token list — when editing, the
// pinned regression in coverage-stamp-collapse.test.ts ("sibling test only
// covers the single FINAL case" must survive) is the falsifier (Kimi
// sign-off condition).
const MECHANISM_TOKENS =
  /(race|incorrect|wrong|fails?|breaks?|bug|overflow|injection|missing await|off.by.one|regression|covers (the|only)|not multiple)/i

/** A "pure coverage stamp": testing-category observation with no mechanism. */
export function isPureCoverageStamp(f: PrReviewFinding): boolean {
  if (f.category !== "testing") return false
  if (!COVERAGE_CLASS.test(f.headline)) return false
  if (MECHANISM_TOKENS.test(f.headline)) return false
  return true
}

export interface CoverageCollapseResult<P> {
  findings: PrReviewFinding[]
  provenanceFindings: P[]
  collapsed: { keptHeadline: string; collapsedCount: number; paths: string[] } | null
}

/**
 * Collapse 2+ pure coverage stamps into ONE pr-scope finding: the
 * highest-score stamp survives (tie → earliest index) with one appended
 * body line listing the other stamps' paths (ascending, deduped) and the
 * ascending union of all collapsed provenance sourceFindingIds. Fires only
 * at 2+ stamps — a lone stamp and every non-stamp finding pass through
 * untouched, and the no-collapse case returns the inputs by reference.
 * `findings[i]` ↔ `provenanceFindings[i]` alignment is preserved.
 */
export function collapseCoverageStamps<P extends { sourceFindingIds: ReadonlyArray<string> }>(
  findings: ReadonlyArray<PrReviewFinding>,
  provenanceFindings: ReadonlyArray<P>,
): CoverageCollapseResult<P> {
  const stampIndexes: number[] = []
  for (let i = 0; i < findings.length; i++) {
    if (isPureCoverageStamp(findings[i]!)) stampIndexes.push(i)
  }
  if (stampIndexes.length < 2) {
    return {
      findings: findings as PrReviewFinding[],
      provenanceFindings: provenanceFindings as P[],
      collapsed: null,
    }
  }

  let keepIdx = stampIndexes[0]!
  for (const i of stampIndexes) {
    if (findings[i]!.score > findings[keepIdx]!.score) keepIdx = i
  }
  const dropped = stampIndexes.filter((i) => i !== keepIdx)
  const otherPaths = [...new Set(dropped.map((i) => findings[i]!.path))].sort()
  const mergedIds = [...new Set(stampIndexes.flatMap((i) => provenanceFindings[i]?.sourceFindingIds ?? []))].sort()
  const kept = findings[keepIdx]!
  const survivor: PrReviewFinding = {
    ...kept,
    scope: "pr",
    // SIG-392: lock the scope so the inline-first promotion
    // (normalizeFindingScopeForAnchorability) does not anchor this cross-file
    // aggregate to the one kept stamp's inherited line.
    scopeLocked: true,
    body:
      otherPaths.length > 0
        ? `${kept.body}\n\nAlso uncovered: ${otherPaths.map((p) => `\`${p}\``).join(", ")}`
        : kept.body,
  }
  const keptProvenance = provenanceFindings[keepIdx]
  const droppedSet = new Set(dropped)
  const outFindings: PrReviewFinding[] = []
  const outProvenance: P[] = []
  for (let i = 0; i < findings.length; i++) {
    if (droppedSet.has(i)) continue
    if (i === keepIdx) {
      outFindings.push(survivor)
      outProvenance.push({ ...(keptProvenance as P), sourceFindingIds: mergedIds })
    } else {
      outFindings.push(findings[i]!)
      outProvenance.push(provenanceFindings[i] ?? ({ sourceFindingIds: [] } as unknown as P))
    }
  }
  return {
    findings: outFindings,
    provenanceFindings: outProvenance,
    collapsed: {
      keptHeadline: survivor.headline,
      collapsedCount: dropped.length,
      // Telemetry cardinality cap (Kimi sign-off condition): first 10 paths.
      paths: otherPaths.slice(0, 10),
    },
  }
}
