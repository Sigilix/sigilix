// SIG-104 PR-3 — the learnings SUPPRESS gate (app layer). Split out of
// render-prep so that file stays under the 1k-line budget (the same reason
// `verification-prep` was carved out). This adapts the post-synth renderable
// finding set + its provenance to the pure `decideLearningSuppressions` domain
// core, enforces the `OPENCLAW_LEARNINGS_MODE` flag, and returns the filtered
// kept set plus the carve-out attributions for the inline pill.
//
// RECALL-SAFETY: the hard carve-outs (never a P0/P1, never security/logic by
// provenance, never deterministically-grounded, narrow-match only, fail-closed
// on unknown provenance) all live in the pure domain fn — this file only wires
// the mode + telemetry. `off` ⇒ no load (byte-identical); `shadow` ⇒ compute +
// telemeter, drop NOTHING and attribute NOTHING (byte-identical output); `on` ⇒
// drop the suppressions and stamp `shapedByLearning` on the carve-out keeps.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import {
  decideLearningSuppressions,
  loadLearnings,
  resolveLearningsMode,
  selectRelevantForPaths,
  type SuppressibleFinding,
} from "@/src/features/learnings"

type ProvenanceFindings = SynthesizerProvenance["findings"]

export interface ApplyLearningSuppressionsArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  /** Immutable GitHub repo id — the learnings store subject key. Absent ⇒ skip. */
  repoId: number | undefined
  /**
   * The post-withdrawal/precision kept findings. Stamping `shapedByLearning` mutates these in place —
   * safe because it's a runtime-only display field on a KEPT finding (same convention render-prep already
   * uses, e.g. `contentFingerprint`). NB these are not all clones: a consensus-1 finding is the original
   * object (annotateWithConsensus returns it unchanged), so do NOT add isolation-dependent mutation here.
   */
  kept: PrReviewFinding[]
  /** The full consensus-ranked clone array `kept` is a subset of (for index/provenance lookup). */
  renderableFindings: ReadonlyArray<PrReviewFinding>
  /** Per-consensus-index provenance — `sourceSpecialists` keys the security/logic carve-out. */
  consensusProvenance: ProvenanceFindings
  /** The PR's changed + not-yet-reviewed paths — the learning relevance scope. */
  changedPaths: ReadonlyArray<string>
}

/**
 * Apply suppress-polarity learnings to the kept finding set at the deterministic
 * post-synth gate. Returns the (possibly filtered) findings to render: in `on`
 * this excludes the suppressions and the surviving carve-out keeps carry the
 * `shapedByLearning` attribution stamp; in `off`/`shadow` it returns the input
 * unchanged (shadow telemeters first). Best-effort — any load/throw degrades to
 * "no suppression" (the recall-safe failure).
 */
export async function applyLearningSuppressions(args: ApplyLearningSuppressionsArgs): Promise<PrReviewFinding[]> {
  const { env, owner, repo, prNumber, repoId, kept, renderableFindings, consensusProvenance, changedPaths } = args

  const mode = resolveLearningsMode(env.OPENCLAW_LEARNINGS_MODE)
  if (mode === "off" || repoId === undefined) return kept

  try {
    const store = await loadLearnings(env, "repo", String(repoId))
    const entries = store?.entries ?? []
    if (entries.length === 0) return kept
    // Same relevance + budget gate the prompt injection uses, so the gate only
    // considers learnings that were eligible to shape this review.
    const relevant = selectRelevantForPaths(entries, [...changedPaths])
    if (relevant.length === 0) return kept

    // Map each kept clone back to its consensus index so the carve-out reads the
    // finding's real provenance (`sourceSpecialists`), never the synth category.
    const indexOf = new Map<PrReviewFinding, number>()
    for (let i = 0; i < renderableFindings.length; i++) {
      const f = renderableFindings[i]
      if (f !== undefined && !indexOf.has(f)) indexOf.set(f, i)
    }
    const suppressible: SuppressibleFinding[] = kept.map((f) => {
      const idx = indexOf.get(f)
      const provenance = idx !== undefined ? consensusProvenance[idx] : undefined
      return {
        score: f.score,
        category: f.category,
        path: f.path,
        // Both provenance signals: synth-reported roles + the authoritative
        // `<role>-<n>` source ids (the carve-out keys on both).
        sourceSpecialists: provenance?.sourceSpecialists ?? [],
        ...(provenance?.sourceFindingIds !== undefined ? { sourceFindingIds: provenance.sourceFindingIds } : {}),
        ...(f.astEvidence !== undefined ? { astEvidence: f.astEvidence } : {}),
        ...(f.cweId !== undefined ? { cweId: f.cweId } : {}),
        ...(f.evidenceId !== undefined ? { evidenceId: f.evidenceId } : {}),
        ...(f.evidenceRefs !== undefined ? { evidenceRefs: f.evidenceRefs } : {}),
      }
    })

    const { suppressions, carveOutKeeps } = decideLearningSuppressions(suppressible, relevant)
    if (suppressions.length === 0 && carveOutKeeps.length === 0) return kept

    // Telemetry runs in BOTH shadow and on (the point of shadow is to bake the
    // decision corpus without changing output).
    console.log(
      JSON.stringify({
        event: "learnings-suppress-decision",
        owner,
        repo,
        prNumber,
        mode,
        candidates: relevant.length,
        wouldSuppress: suppressions.length,
        carveOutKeeps: carveOutKeeps.length,
        suppressedCategories: suppressions.map((s) => suppressible[s.index]?.category).filter((c) => c !== undefined),
        carveOutReasons: carveOutKeeps.map((c) => c.reason),
      }),
    )

    // Shadow: telemetered above, output byte-identical (no drop, no attribution).
    if (mode === "shadow") return kept

    // On: stamp the attribution on each carve-out keep (the inline pill), then
    // drop the suppressed findings from the kept set.
    for (const keep of carveOutKeeps) {
      const finding = kept[keep.index]
      if (finding !== undefined) finding.shapedByLearning = { ruleText: keep.ruleText }
    }
    const suppressedIndices = new Set(suppressions.map((s) => s.index))
    return kept.filter((_, i) => !suppressedIndices.has(i))
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "learnings-suppress-apply-failed",
        owner,
        repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return kept
  }
}
