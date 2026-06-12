// SIG-392 — deterministic near-duplicate collapse (pure domain).
//
// The synth posts near-duplicate findings (probe #28: one finding twice
// verbatim; probe #31: two wordings of the same units bug at the same line,
// plus a second wording of an already-caught SQLi). Prompt-side DEDUPE rules
// demonstrably don't bind across models, so the collapse is code: the FINAL
// stage of applyRecallFloors — AFTER the SIG-351 source floor restores, and
// nothing downstream re-restores (validate/post follow). Spec:
// docs/superpowers/specs/2026-06-11-sig392-near-dup-collapse-spec.md

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

/** Same-anchor gate: only findings this close are even compared. */
const LINE_SLACK = 5
/** Token-overlap floor for headline similarity (calibrated on real probe
 *  pairs: N+1 pair 0.58, units pair 0.33, distinct-bugs-same-line pair 0.12). */
const JACCARD_THRESHOLD = 0.25

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "and",
  "or",
  "with",
  "without",
  "per",
  "when",
  "while",
  "that",
  "this",
  "its",
  "it",
  "by",
  "from",
  "into",
  "not",
  "no",
  "does",
  "do",
  "then",
  "after",
  "before",
])

/** Lowercase, strip backticks/punctuation, drop stopwords, light de-plural. */
export function headlineTokens(headline: string): Set<string> {
  const out = new Set<string>()
  for (const raw of headline.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0 || STOPWORDS.has(raw)) continue
    let t = raw
    if (t.length > 3) {
      if (t.endsWith("es")) t = t.slice(0, -2)
      else if (t.endsWith("s")) t = t.slice(0, -1)
    }
    out.add(t)
  }
  return out
}

export function headlineJaccard(a: string, b: string): number {
  const ta = headlineTokens(a)
  const tb = headlineTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  return shared / (ta.size + tb.size - shared)
}

export interface CollapsedPair {
  keptHeadline: string
  droppedHeadline: string
  jaccard: number
  sharedSource: boolean
}

export interface NearDupCollapseResult<P> {
  findings: PrReviewFinding[]
  provenanceFindings: P[]
  collapsedPairs: CollapsedPair[]
}

function isNearDuplicate(
  a: PrReviewFinding,
  b: PrReviewFinding,
  aSources: ReadonlyArray<string>,
  bSources: ReadonlyArray<string>,
): { match: boolean; jaccard: number; sharedSource: boolean } {
  const jaccard = headlineJaccard(a.headline, b.headline)
  const none = { match: false, jaccard, sharedSource: false }
  if (a.path !== b.path) return none
  if (Math.abs(a.line - b.line) > LINE_SLACK) return none
  if (a.category !== b.category) return none
  const bSet = new Set(bSources)
  const sharedSource = aSources.some((id) => bSet.has(id))
  return { match: sharedSource || jaccard >= JACCARD_THRESHOLD, jaccard, sharedSource }
}

/**
 * Collapse near-duplicate post-synth findings, keeping the higher-score
 * twin (tie → the earlier index — deterministic) and merging the dropped
 * row's sourceFindingIds into the survivor's provenance row (ascending
 * union) so every source stays accounted for downstream validation. One
 * left-to-right reduce over index order: each candidate is compared to the
 * SURVIVORS, so A~B, B~C chains converge to one survivor. Pure; when
 * nothing collapses the input arrays are returned by reference.
 *
 * `findings[i]` ↔ `provenanceFindings[i]` index alignment is the caller's
 * contract (the same one the recall floors maintain) and is preserved.
 */
export function collapseNearDuplicateFindings<P extends { sourceFindingIds: ReadonlyArray<string> }>(
  findings: ReadonlyArray<PrReviewFinding>,
  provenanceFindings: ReadonlyArray<P>,
): NearDupCollapseResult<P> {
  const survivors: Array<{ finding: PrReviewFinding; provenance: P }> = []
  const collapsedPairs: CollapsedPair[] = []
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!
    const provenance = provenanceFindings[i] ?? ({ sourceFindingIds: [] } as unknown as P)
    let absorbed = false
    for (const s of survivors) {
      const verdict = isNearDuplicate(s.finding, finding, s.provenance.sourceFindingIds, provenance.sourceFindingIds)
      if (!verdict.match) continue
      const keepCandidate = finding.score > s.finding.score
      const kept = keepCandidate ? finding : s.finding
      const dropped = keepCandidate ? s.finding : finding
      const mergedIds = [...new Set([...s.provenance.sourceFindingIds, ...provenance.sourceFindingIds])].sort()
      const keptProvenance = keepCandidate ? provenance : s.provenance
      s.finding = kept
      s.provenance = { ...keptProvenance, sourceFindingIds: mergedIds }
      collapsedPairs.push({
        keptHeadline: kept.headline,
        droppedHeadline: dropped.headline,
        jaccard: verdict.jaccard,
        sharedSource: verdict.sharedSource,
      })
      absorbed = true
      break
    }
    if (!absorbed) survivors.push({ finding, provenance })
  }
  if (collapsedPairs.length === 0) {
    return {
      findings: findings as PrReviewFinding[],
      provenanceFindings: provenanceFindings as P[],
      collapsedPairs,
    }
  }
  return {
    findings: survivors.map((s) => s.finding),
    provenanceFindings: survivors.map((s) => s.provenance),
    collapsedPairs,
  }
}
