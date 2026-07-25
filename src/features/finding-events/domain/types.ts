// SIG-606 — finding event log domain types.
//
// One event per CANDIDATE finding (posted AND suppressed). Structural metadata
// ONLY: no headline, no body, no diff hunk — those are customer-source-derived and
// deliberately out of scope (see migrations/0037_create_finding_event.sql).

/** Where in the pipeline this event was observed. */
export type FindingEventStage = "validator" | "render-prep" | "verification" | "publish"

/**
 * The RECONCILED fate of a candidate.
 *
 * ⚠️ Never derive this from a gate callback's `dropped`/`enforced` flag — that flag
 * means enforce-vs-shadow, and most gates run in shadow, so a "flagged" candidate
 * was usually still posted. It is resolved against the FINAL posted set by
 * `reconcileFindingOutcomes`.
 *
 * `unknown` is load-bearing: when the posted set is unavailable (an errored or
 * aborted review), we record `unknown` rather than guessing `suppressed`. Guessing
 * would inject false negatives into the label corpus — the one failure this table
 * exists to avoid.
 */
export type FindingOutcome = "posted-inline" | "posted-body" | "suppressed" | "unknown"

/** How a candidate was surfaced when it survived to publication. */
export type PostedSurface = "posted-inline" | "posted-body"

/** A candidate observed at a push site, before its outcome is known. */
export interface FindingEventDraft {
  /** Stable-ish identity computed at push time; joins a candidate across stages. */
  findingKey: string
  /**
   * False when the candidate lacked the inputs to derive a real key (e.g. a missing
   * headline), so `findingKey` is a fabricated placeholder that CANNOT match the
   * posted set. Such a row must reconcile to `unknown`, never `suppressed` —
   * otherwise a finding we actually posted gets recorded as rejected purely because
   * we couldn't identify it. Absent/true means the key is real.
   */
  identityResolved?: boolean
  contentFingerprint?: string | null
  category?: string | null
  score?: number | null
  confidence?: number | null
  gateScore?: number | null
  path?: string | null
  line?: number | null
  startLine?: number | null
  sourceSpecialists?: string[] | null
  trustTier?: string | null
  stage: FindingEventStage
  gate?: string | null
  reason?: string | null
  /** Enforce-vs-shadow: did the gate actually act? NOT posted-vs-suppressed. */
  enforced?: boolean
}

/** What publication observed for a candidate that survived. */
export interface PostedFindingRecord {
  surface: PostedSurface
  inlineCommentId?: number | null
  trustTier?: string | null
}

/**
 * A draft with its outcome resolved — the row shape written to D1.
 *
 * Discriminated on `outcome` so the corrupting states are UNREPRESENTABLE: only a
 * `posted-inline` row may carry an `inlineCommentId`. `appendFindingEvents` is
 * exported from the barrel and the writer hand-constructs rows at the publish
 * site, so "suppressed with a comment id" must fail to compile, not merely fail
 * review.
 */
export type FindingEvent = FindingEventDraft &
  (
    | { outcome: "posted-inline"; inlineCommentId?: number | null; trustTier?: string | null }
    | { outcome: "posted-body"; inlineCommentId?: null; trustTier?: string | null }
    | { outcome: "suppressed" | "unknown"; inlineCommentId?: null; trustTier?: null }
  )
