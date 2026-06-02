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

// ─── SIG-317 — synth verdict-truncation recovery ──────────────────────────
//
// On target-rich PRs the synthesizer emits a COMPLETE `provenance.findings`
// (one terse entry per source it decided to keep) but a SHORTER
// `verdict.findings` — it details the top-ranked findings (security-first, per
// the synth prompt's "rank by severity") and silently truncates the verbose
// verdict array, losing real subtle findings it MARKED KEPT. The synth's own
// provenance is the proof of intent: on pr/10 `provenance.findings` had 20
// entries (action "kept", 0 dropped) while `verdict.findings` had 8 — 12
// score>=3 findings lost, including a score-5 N+1, a cents/dollars bug, a
// floating promise, and the SIG-310 deterministic emit.
//
// This recovers the truncated tail: for every provenance entry BEYOND the
// verdict length, reconstruct the verdict finding from its cited source. The
// recovered findings flow through the SAME post-synth gates (grounding,
// citation, evidence, clamps, anchor repair) as synth-kept findings — nothing
// is force-posted; a recovered finding that doesn't hold is dropped by its
// gate. Precision-safe by construction: we only restore findings the synth
// itself provenanced as "kept"/"merged", never inventing new ones, and the
// gates remain the precision authority.

export interface TruncationRecoveryResult {
  /** Synth findings + recovered tail, index-parallel to `provenanceFindings`. */
  findings: PrReviewFinding[]
  /** Provenance entries, realigned 1:1 to `findings`. */
  provenanceFindings: FloorProvenanceFinding[]
  /** What was recovered (telemetry). Empty when the synth verdict wasn't truncated. */
  recovered: Array<{ id: string; score: number; category: string; headline: string }>
}

/**
 * Recover findings the synth truncated out of `verdict.findings` but still
 * accounted for in `provenance.findings` (i.e. `provenance.findings.length >
 * verdict.findings.length`). Reconstructs each orphaned tail entry from its
 * cited source finding via `sourceById`. Pure — never mutates input. Returns
 * the inputs unchanged when there is no truncation tail.
 */
export function recoverTruncatedSynthFindings(args: {
  findings: ReadonlyArray<PrReviewFinding>
  provenanceFindings: ReadonlyArray<FloorProvenanceFinding>
  /**
   * Candidate source findings keyed by source id. The orchestrator passes
   * specialist findings (`${role}-${index}`) in Part 1; orphans citing only
   * AST-emit ids are simply skipped (AST/SIG-310 recovery is a fast-follow).
   */
  sourceById: ReadonlyMap<string, PrReviewFinding & { id: string }>
  minScore?: number
}): TruncationRecoveryResult {
  const minScore = args.minScore ?? DEGRADED_FLOOR_MIN_SCORE
  // No truncation tail → nothing to recover; return inputs unchanged.
  if (args.provenanceFindings.length <= args.findings.length) {
    return {
      findings: [...args.findings],
      provenanceFindings: [...args.provenanceFindings],
      recovered: [],
    }
  }
  // Keep the aligned prefix (the findings the synth DID fully write) intact.
  const findings: PrReviewFinding[] = [...args.findings]
  const provenanceFindings: FloorProvenanceFinding[] = args.provenanceFindings.slice(0, findings.length)
  const recovered: TruncationRecoveryResult["recovered"] = []
  // Guard against re-adding a source already present in the kept prefix.
  const present = new Set<string>(provenanceFindings.flatMap((p) => p.sourceFindingIds))

  for (let i = args.findings.length; i < args.provenanceFindings.length; i++) {
    const p = args.provenanceFindings[i]
    if (!p || !Array.isArray(p.sourceFindingIds) || p.sourceFindingIds.length === 0) continue
    // Reconstruct from the highest-score cited source not already present.
    let best: (PrReviewFinding & { id: string }) | undefined
    for (const sid of p.sourceFindingIds) {
      if (present.has(sid)) continue
      const f = args.sourceById.get(sid)
      if (f && (best === undefined || f.score > best.score)) best = f
    }
    if (best === undefined || best.score < minScore) continue
    // Mark ALL cited sources present (not just `best`) — a merged provenance
    // entry [a, b] is recovered as ONE finding (the best-scored representation),
    // so a later orphan re-citing `a` or `b` must not re-recover it as a
    // duplicate. Reached only for a QUALIFYING orphan (the skip above returns
    // first), so a skipped orphan never poisons `present` for later ones.
    for (const sid of p.sourceFindingIds) present.add(sid)
    findings.push(best)
    provenanceFindings.push({
      sourceSpecialists: p.sourceSpecialists,
      sourceFindingIds: p.sourceFindingIds,
      action: p.action,
      verifiedViaRetrieval: p.verifiedViaRetrieval ?? false,
    })
    recovered.push({ id: best.id, score: best.score, category: best.category ?? "logic", headline: best.headline })
  }

  return { findings, provenanceFindings, recovered }
}
