// SIG-392 — deterministic class-redundancy collapse (pure domain).
//
// The recall-eliciting logic prompt (OPENCLAW_LOGIC_RECALL_MODE) reports the
// SAME bug-CLASS once per occurrence — measured: "an awaited DB/IO call with no
// try/catch" emitted as 6 near-identical findings, one per handler. The class
// SURVIVES every existing mechanism: near-dup collapse requires same path +
// |Δline|<=5 (these are the same class >5 lines apart, across handlers), and
// coverage-stamp-collapse only handles the testing class.
//
// RECALL-SAFETY (the hard constraint — collapsing must NEVER drop a distinct
// bug): "same class" is NOT enough. A finding "no try/catch on the webhook —
// the customer is billed again" is a double-charge bug that merely mentions the
// class. So a member is collapsed ONLY when it is LEXICALLY NEAR-IDENTICAL to
// the keeper (headline-Jaccard >= CLASS_HEADLINE_JACCARD) — genuine same-stamp
// redundancy — never on the class signature alone. Plus: candidates are capped
// at score <= CLASS_COLLAPSE_MAX_SCORE (a score>=4 finding asserts severity and
// is never folded), the curated negative gate excludes named-consequence
// findings, and every dropped finding's FULL HEADLINE is preserved in the
// survivor body + telemetry (so a mis-merge is auditable, never silent).
//
// Runs as the final stage in applyRecallFloors, after coverage-stamp-collapse —
// same no-resurrection-by-ordering guarantee. Spec:
// docs/superpowers/specs/2026-06-12-sig392-class-collapse-gate-spec.md

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { headlineJaccard } from "@/src/lib/ensemble/domain/near-dup-collapse"

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
// a pure class stamp. The headline-Jaccard floor below is the PRIMARY guard
// (distinct consequences are worded differently → low similarity); this token
// list is a cheap secondary filter for the most dangerous consequence words.
const SPECIFIC_CONSEQUENCE_TOKENS =
  /(double[-\s]?(charge|count|appl|bill)|billed\s+(again|twice)|sent\s+twice|data\s+loss|\bloses?\b|\bcorrupts?\b|\bduplicate\b|\bmismatch\b|\binjection\b|\brace\b|over[-\s]?refund|\bwrong\b|\bincorrect\b|\bleaks?\b|\bbypass\b|\bunauthenticated\b|\bunauthori[sz]ed\b|off[-\s]by[-\s]one|\boverflow\b|\bstale\b|\bdeadlock\b|never\s+(released|closed|committed)|committed\s+(even|when))/i

/** Minimum same-class, near-identical findings to collapse — 3+, so a PAIR
 *  stays the near-dup collapse's job and a lone instance is untouched. */
export const CLASS_COLLAPSE_MIN = 3
/** Candidates above this score assert real severity and are NEVER folded. */
export const CLASS_COLLAPSE_MAX_SCORE = 3
/** Headline-similarity floor: a member collapses only if it is this close to
 *  the keeper. Genuine same-class stamps are near-identical; distinct bugs that
 *  merely share the class phrase are not. */
export const CLASS_HEADLINE_JACCARD = 0.6

/** The collapsible class of a finding, or null. A COLLAPSE CANDIDATE: matches a
 *  curated class signature, scores <= the ceiling, and names no specific
 *  downstream consequence. (Candidacy is necessary but not sufficient — the
 *  Jaccard floor in `collapseClassRedundantFindings` is the actual merge gate.) */
export function collapsibleClassOf(f: PrReviewFinding): string | null {
  if (f.score > CLASS_COLLAPSE_MAX_SCORE) return null
  const headline = f.headline ?? ""
  if (SPECIFIC_CONSEQUENCE_TOKENS.test(headline)) return null
  for (const c of CLASS_SIGNATURES) {
    if (c.re.test(headline)) return c.id
  }
  return null
}

export interface ClassCollapseResult<P> {
  findings: PrReviewFinding[]
  provenanceFindings: P[]
  collapsed: ReadonlyArray<{
    classId: string
    keptHeadline: string
    collapsedCount: number
    droppedHeadlines: string[]
    locations: string[]
  }>
}

/**
 * Collapse, per curated class, the cluster of `>= CLASS_COLLAPSE_MIN` candidate
 * findings that are LEXICALLY NEAR-IDENTICAL to the class's highest-score
 * candidate (headline-Jaccard `>= CLASS_HEADLINE_JACCARD`) into ONE pr-scope
 * survivor. The survivor takes the MAX member score, lists every dropped
 * finding's FULL headline + `path:line` in its body, unions all collapsed
 * provenance ids, and is `scopeLocked`. Candidates that are NOT near-identical
 * to the keeper are left UNTOUCHED (a distinct bug is never folded). Below the
 * threshold (or no similar cluster) returns the inputs by reference.
 * `findings[i]` ↔ `provenanceFindings[i]` alignment is preserved.
 */
export function collapseClassRedundantFindings<P extends { sourceFindingIds: ReadonlyArray<string> }>(
  findings: ReadonlyArray<PrReviewFinding>,
  provenanceFindings: ReadonlyArray<P>,
): ClassCollapseResult<P> {
  const byClass = new Map<string, number[]>()
  for (let i = 0; i < findings.length; i++) {
    const cls = collapsibleClassOf(findings[i]!)
    if (cls === null) continue
    const arr = byClass.get(cls) ?? []
    arr.push(i)
    byClass.set(cls, arr)
  }

  const droppedSet = new Set<number>()
  // keepIdx → { classId, droppedIdxs }
  const survivors = new Map<number, { classId: string; dropped: number[] }>()
  for (const [classId, idxs] of byClass) {
    if (idxs.length < CLASS_COLLAPSE_MIN) continue
    // keeper = highest-score candidate (tie → earliest index).
    let keepIdx = idxs[0]!
    for (const i of idxs) {
      if (findings[i]!.score > findings[keepIdx]!.score) keepIdx = i
    }
    // collapse ONLY the cluster near-identical to the keeper.
    const keepHeadline = findings[keepIdx]!.headline ?? ""
    const cluster = idxs.filter(
      (i) => i === keepIdx || headlineJaccard(findings[i]!.headline ?? "", keepHeadline) >= CLASS_HEADLINE_JACCARD,
    )
    if (cluster.length < CLASS_COLLAPSE_MIN) continue // not enough genuine same-stamp → safe no-op
    const dropped = cluster.filter((i) => i !== keepIdx)
    for (const i of dropped) droppedSet.add(i)
    survivors.set(keepIdx, { classId, dropped })
  }

  if (survivors.size === 0) {
    return { findings: findings as PrReviewFinding[], provenanceFindings: provenanceFindings as P[], collapsed: [] }
  }

  const collapsedTelemetry: Array<{
    classId: string
    keptHeadline: string
    collapsedCount: number
    droppedHeadlines: string[]
    locations: string[]
  }> = []
  const outFindings: PrReviewFinding[] = []
  const outProvenance: P[] = []
  for (let i = 0; i < findings.length; i++) {
    if (droppedSet.has(i)) continue
    const meta = survivors.get(i)
    if (meta !== undefined) {
      const kept = findings[i]!
      const droppedHeadlines = meta.dropped.map((d) => findings[d]!.headline)
      const locations = [...new Set(meta.dropped.map((d) => `${findings[d]!.path}:${findings[d]!.line}`))].sort()
      const maxScore = meta.dropped.reduce((s, d) => Math.max(s, findings[d]!.score), kept.score)
      const mergedIds = [
        ...new Set([i, ...meta.dropped].flatMap((d) => provenanceFindings[d]?.sourceFindingIds ?? [])),
      ].sort()
      const survivor: PrReviewFinding = {
        ...kept,
        score: maxScore,
        scope: "pr",
        // Lock the scope so the inline-first promotion does not anchor this
        // aggregate to the one kept finding's inherited line.
        scopeLocked: true,
        body:
          droppedHeadlines.length > 0
            ? `${kept.body}\n\nSame issue also at: ${meta.dropped
                .map((d) => `${findings[d]!.headline} (\`${findings[d]!.path}:${findings[d]!.line}\`)`)
                .join("; ")}`
            : kept.body,
      }
      outFindings.push(survivor)
      outProvenance.push({ ...(provenanceFindings[i] as P), sourceFindingIds: mergedIds })
      collapsedTelemetry.push({
        classId: meta.classId,
        keptHeadline: kept.headline,
        collapsedCount: meta.dropped.length,
        droppedHeadlines: droppedHeadlines.slice(0, 10),
        locations: locations.slice(0, 10),
      })
    } else {
      outFindings.push(findings[i]!)
      outProvenance.push(provenanceFindings[i] ?? ({ sourceFindingIds: [] } as unknown as P))
    }
  }
  return { findings: outFindings, provenanceFindings: outProvenance, collapsed: collapsedTelemetry }
}
