// SIG-606 — outcome reconciliation. The correctness core of the finding event log.
//
// THE BUG THIS EXISTS TO PREVENT: every validator gate reports a `dropped`/
// `enforced` flag, and it is tempting to read that as "this candidate was
// suppressed." It is not. That flag means ENFORCE-vs-SHADOW — whether the gate was
// configured to act — and most gates default to shadow or off. A gate firing in
// shadow mode flags a candidate that is then POSTED anyway. Labelling those rows
// "suppressed" would fill the corpus with false negatives and quietly teach any
// future model that findings we actually shipped were rejected.
//
// So outcome is resolved ONE way only: against the FINAL posted set observed at
// publication. A candidate present there was posted (with the surface publication
// actually used); a candidate absent from it was suppressed.

import type { FindingEvent, FindingEventDraft, PostedFindingRecord } from "./types"

/**
 * Resolve each draft's outcome against the final posted set.
 *
 * @param drafts    candidates observed at the push sites (gate hits and survivors).
 * @param posted    findingKey → what publication did with it. Pass `null` when the
 *   posted set is UNAVAILABLE (errored/aborted review) — every row then records
 *   `unknown` rather than a guessed `suppressed`. An empty map is different: it
 *   means publication ran and posted nothing, so candidates really were suppressed.
 *
 * Pure; never throws. Drafts are not mutated.
 */
export function reconcileFindingOutcomes(
  drafts: readonly FindingEventDraft[],
  posted: ReadonlyMap<string, PostedFindingRecord> | null | undefined,
): FindingEvent[] {
  // `!posted` (not `=== null`) so an undefined caller can't slip past strict TS
  // into a crash. An empty Map is truthy, so the null-vs-empty distinction holds.
  return drafts.map((draft) => {
    if (!posted || draft.identityResolved === false) {
      // Two ways we legitimately do not know:
      //  • no posted set observed (errored/aborted review), or
      //  • the candidate had no derivable identity, so its key CANNOT match the
      //    posted set — treating that as `suppressed` would record a finding we may
      //    well have posted as rejected, purely because we couldn't identify it.
      // trust_tier is publication-assigned, so it is NULL on a non-survivor row.
      return { ...draft, outcome: "unknown" as const, trustTier: null, inlineCommentId: null }
    }
    const hit = posted.get(draft.findingKey)
    if (!hit) {
      return { ...draft, outcome: "suppressed" as const, trustTier: null, inlineCommentId: null }
    }
    // PUBLICATION IS THE AUTHORITY on both id and tier, unconditionally. A stale
    // draft value must never win over what was observed — including when
    // publication assigned NO tier (trust ledger off), where letting a draft value
    // through would persist a tier as though publication had assigned it. This
    // upholds the migration's invariant: trust_tier is NULL unless the ledger was
    // on AND the finding survived.
    // Split per surface so the discriminated union narrows: only a posted-inline
    // row may carry a comment id.
    if (hit.surface === "posted-inline") {
      return {
        ...draft,
        outcome: "posted-inline" as const,
        inlineCommentId: hit.inlineCommentId ?? null,
        trustTier: hit.trustTier ?? null,
      }
    }
    return { ...draft, outcome: "posted-body" as const, inlineCommentId: null, trustTier: hit.trustTier ?? null }
  })
}
