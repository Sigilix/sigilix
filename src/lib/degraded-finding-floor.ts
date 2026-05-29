// SIG-287 — degraded-coverage finding floor.
//
// When the ensemble runs with DEGRADED coverage (a dispatched specialist
// timed out / was cancelled — in practice `logic` on ~every review), the
// synthesizer can shrug: it emits a low-confidence "no concerns" verdict
// and DROPS the findings the specialists that DID return actually raised
// (on PR #218 the synth emitted 0 findings while `performance` had a
// real score-2 finding). Combined with the event downgrade (#219, a
// degraded review can no longer post a confident APPROVE), the review
// becomes an honest-but-empty "partial review" — which still hides what
// the surviving specialists found.
//
// This floor re-injects, ONLY on degraded runs, any returned specialist
// finding at or above `minScore` whose source id the synth did not
// account for in its provenance. The re-injected finding flows through
// the normal post-synth pipeline (validators, anchor repair, withdrawal
// suppression, inline-grounding, score-1 advisory demotion) exactly like
// a synth-kept finding — nothing is force-posted. It just ensures the
// synth can't silently erase the only signal a degraded review has.
//
// Pure + structural (no import from the ensemble — avoids a cycle). The
// orchestrator passes the synth verdict's findings + its INDEX-PARALLEL
// provenance findings (the hallucination guard pairs them by index, so
// the floor appends to BOTH in lockstep to preserve alignment).

import type { PrReviewFinding } from "./triage-pr-review"
import type { SpecialistRole } from "./ensemble-router"

/** Minimum specialist-finding score the floor will restore. Nits (score 1) stay dropped. */
export const DEGRADED_FLOOR_MIN_SCORE = 2

/**
 * One synth provenance entry — structurally compatible with
 * `SynthesizerProvenance["findings"][number]` so the orchestrator can
 * pass `synthOutput.provenance.findings` straight in and back out.
 */
export interface FloorProvenanceFinding {
  sourceSpecialists: SpecialistRole[]
  sourceFindingIds: string[]
  action: "kept" | "merged" | "rewritten"
  verifiedViaRetrieval: boolean
}

export interface DegradedFloorSpecialist {
  role: SpecialistRole
  /** The role's returned findings (specialist findings carry a stable `id`). */
  findings: ReadonlyArray<PrReviewFinding & { id: string }>
}

export interface DegradedFloorResult {
  /** Synth findings + any restored specialist findings, appended in order. */
  findings: PrReviewFinding[]
  /** Provenance findings + matching entries for the restored findings, INDEX-PARALLEL to `findings`. */
  provenanceFindings: FloorProvenanceFinding[]
  /** What was restored (for telemetry). Empty when nothing qualified. */
  restored: Array<{ role: SpecialistRole; id: string; score: number; headline: string }>
}

/**
 * Re-inject returned specialist findings (score >= `minScore`) the synth
 * did not account for, preserving index-alignment between `findings` and
 * `provenanceFindings`. Pure — returns fresh arrays; never mutates input.
 * The caller must only invoke this on degraded runs.
 */
export function applyDegradedCoverageFindingFloor(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  specialists: ReadonlyArray<DegradedFloorSpecialist>
  minScore?: number
}): DegradedFloorResult {
  const minScore = args.minScore ?? DEGRADED_FLOOR_MIN_SCORE
  // Every source finding id the synth already represents in its output.
  const accounted = new Set<string>(
    args.provenanceFindings.flatMap((p) => p.sourceFindingIds),
  )
  const findings: PrReviewFinding[] = [...args.findings]
  const provenanceFindings: FloorProvenanceFinding[] = [...args.provenanceFindings]
  const restored: DegradedFloorResult["restored"] = []

  for (const { role, findings: specialistFindings } of args.specialists) {
    for (const f of specialistFindings) {
      if (f.score < minScore) continue
      if (accounted.has(f.id)) continue
      // Guard a (pathological) duplicate id across specialists so we never
      // double-inject and skew the index pairing.
      accounted.add(f.id)
      findings.push(f)
      provenanceFindings.push({
        sourceSpecialists: [role],
        sourceFindingIds: [f.id],
        action: "kept",
        verifiedViaRetrieval: false,
      })
      restored.push({ role, id: f.id, score: f.score, headline: f.headline })
    }
  }

  return { findings, provenanceFindings, restored }
}
