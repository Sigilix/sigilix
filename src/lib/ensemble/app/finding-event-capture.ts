// SIG-606 writer — capture candidate findings during a review, then materialize
// them into persistable events at flush time.
//
// WHY A TWO-STEP: `computeFindingKey` is async (crypto.subtle.digest) but the
// validator gate callbacks are synchronous, so the sink collects SYNC captures
// during the review and the keys are derived once, asynchronously, at the flush.
//
// ⚠️ `headline` is IN-MEMORY ONLY. It is carried on the capture solely to derive
// the finding key hash and is DROPPED by `materializeFindingEvents` — it never
// reaches the FindingEventDraft and therefore never reaches D1. The finding_event
// table deliberately has no headline/body column (customer-source-derived; see
// migrations/0037_create_finding_event.sql). Do not add it to the draft.
//
// ⚠️ THE SAME RULE COVERS `gate` AND `reason`, which ARE persisted. They must be
// STABLE CODES ONLY (e.g. "diff-consistency" / "claimed-missing-file-present") —
// NEVER interpolated finding text. Every gate call site has `finding.headline` in
// scope (the console.log right above each one already prints it), so a template
// literal there would quietly ship customer text into the table. They are
// length-clamped below as defence-in-depth, not as permission.
//
// ⚠️ The `satisfies FindingEventDraft` in materializeFindingEvents is LOAD-BEARING,
// not decoration: it is what makes adding `headline:` to that literal a compile
// error. Deleting the word `satisfies` silently re-opens the leak, because
// Promise.all inference erases the excess-property check against the return type.

import { computeFindingKey } from "@/src/lib/ensemble/domain/findings"
import type { FindingEventDraft, FindingEventStage, PostedFindingRecord } from "@/src/features/finding-events"

/** A candidate observed mid-review. Sync-constructible; keys resolved at flush. */
export interface FindingEventCapture {
  path: string
  /** IN-MEMORY ONLY — hashed into findingKey, never persisted. Ignored when
   *  `findingKey` is supplied. */
  headline: string
  /**
   * A PRE-COMPUTED key, when the call site already holds one (the review manifest
   * does, derived by the same computeFindingKey at render-prep). Supplying it avoids
   * a second derivation site — the failure mode there is a silent, total join miss.
   */
  findingKey?: string
  stage: FindingEventStage
  gate?: string | null
  reason?: string | null
  /** Enforce-vs-shadow (did the gate act), NOT posted-vs-suppressed. */
  enforced?: boolean
  category?: string | null
  score?: number | null
  confidence?: number | null
  gateScore?: number | null
  contentFingerprint?: string | null
  line?: number | null
  startLine?: number | null
  /** Not yet populated by any call site — the specialist lives on the parallel
   *  SynthesizerProvenance, not on the finding. */
  sourceSpecialists?: string[] | null
  // NOTE: deliberately NO trustTier here. Publication is its unconditional
  // authority (reconcileFindingOutcomes overwrites it in every branch), so a value
  // set at capture time would be silently discarded.
}

/**
 * A candidate that survived to publication.
 *
 * Takes the ALREADY-COMPUTED `findingKey` rather than (path, headline). The publish
 * side holds it on `ReviewManifestFinding.key`, derived by the same
 * `computeFindingKey` at render-prep. Re-deriving here would create a second
 * derivation site for the load-bearing join: if either side's inputs ever drift the
 * join fails SILENTLY AND TOTALLY (every row would read "suppressed") with no error
 * anywhere. Accepting the key makes that unrepresentable — and keeps `headline` out
 * of the publish-side API entirely.
 */
export interface PostedFindingCapture {
  findingKey: string
  surface: "posted-inline" | "posted-body"
  inlineCommentId?: number | null
  trustTier?: string | null
}

/** Hard cap on captures materialized per review. The sink is fed by 13 gate sites
 *  across the whole candidate set PLUS one capture per survivor at publish, so it is
 *  unbounded in principle; the batch write is one db.batch(). Truncation is LOGGED,
 *  never silent, and is STAGE-AWARE — see boundCaptures. */
const MAX_FINDING_EVENTS = 500

/** Persisted label codes are short by construction; clamp as defence-in-depth so a
 *  bad call site interpolating finding text can't ship an essay into the table. */
const MAX_CODE_LEN = 120

function clampCode(v: string | null | undefined): string | null {
  if (typeof v !== "string" || v.length === 0) return null
  return v.length <= MAX_CODE_LEN ? v : v.slice(0, MAX_CODE_LEN)
}

/** Total string coercion — these feed computeFindingKey, which calls .toLowerCase(). */
function safeStr(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Apply MAX_FINDING_EVENTS, keeping `publish`-stage captures FIRST.
 *
 * A positional `slice(0, MAX)` is the wrong end to cut: gate captures accumulate
 * throughout the review while publish captures are appended once at the end, so a
 * large review would drop 100% of the publish rows — the only ones carrying
 * `content_fingerprint`, and the only cure for a finding that tripped no gate having
 * no row at all. That silently reopens both gaps precisely on the reviews with the
 * most label value. Order within each group is preserved (stable partition).
 */
function boundCaptures(captures: readonly FindingEventCapture[]): FindingEventCapture[] {
  if (captures.length <= MAX_FINDING_EVENTS) return [...captures]
  const publish = captures.filter((c) => c.stage === "publish")
  const rest = captures.filter((c) => c.stage !== "publish")
  const kept = [...publish.slice(0, MAX_FINDING_EVENTS), ...rest].slice(0, MAX_FINDING_EVENTS)
  console.warn(
    JSON.stringify({
      event: "finding-event-capture-truncated",
      captured: captures.length,
      kept: kept.length,
      cap: MAX_FINDING_EVENTS,
      // Per-stage, so a reader can tell WHICH rows were lostrather than just how many.
      publishCaptured: publish.length,
      publishKept: kept.filter((c) => c.stage === "publish").length,
      gateDropped: rest.length - kept.filter((c) => c.stage !== "publish").length,
    }),
  )
  return kept
}

/** Minimal shape the gate callbacks already hold.
 *  Every field admits an explicit `undefined` (not just absence) because these
 *  arrive from mid-pipeline objects where a field can genuinely be undefined at
 *  runtime — `captureGateHit` is total over exactly that case. */
interface GateFinding {
  path?: string | null | undefined
  headline?: string | null | undefined
  category?: string | null | undefined
  score?: number | null | undefined
  confidence?: number | null | undefined
  gateScore?: number | null | undefined
  contentFingerprint?: string | null | undefined
  line?: number | null | undefined
  startLine?: number | null | undefined
}

/**
 * Record one gate hit. Sync + total: a malformed finding still yields a capture
 * (with empty path/headline) rather than throwing inside a review's hot path.
 * No-ops when no sink is threaded (the sink is optional everywhere).
 */
export function captureGateHit(
  sink: FindingEventCapture[] | undefined,
  args: { gate: string; stage: FindingEventStage; reason: string; enforced: boolean; finding: GateFinding },
): void {
  if (!sink) return
  const f = args.finding
  sink.push({
    path: typeof f.path === "string" ? f.path : "",
    headline: typeof f.headline === "string" ? f.headline : "",
    stage: args.stage,
    gate: args.gate,
    reason: args.reason,
    enforced: args.enforced,
    category: f.category ?? null,
    score: f.score ?? null,
    confidence: f.confidence ?? null,
    gateScore: f.gateScore ?? null,
    contentFingerprint: f.contentFingerprint ?? null,
    line: f.line ?? null,
    startLine: f.startLine ?? null,
  })
}

/**
 * Derive the finding keys and DROP the headline, producing the persistable drafts.
 * Order is preserved so a caller can correlate positionally.
 */
export async function materializeFindingEvents(captures: readonly FindingEventCapture[]): Promise<FindingEventDraft[]> {
  const bounded = boundCaptures(captures)
  return Promise.all(
    bounded.map(async (c) => {
      // Total: computeFindingKey calls .toLowerCase(), so a runtime undefined here
      // would reject the whole Promise.all and lose the ENTIRE review's labels.
      const path = safeStr(c.path)
      const headline = safeStr(c.headline)
      // No headline → no derivable identity. The key below cannot match the posted
      // set, so flag it and let reconcile record `unknown` instead of a
      // confidently-wrong `suppressed`.
      const preKey = safeStr(c.findingKey).trim()
      const identityResolved = preKey.length > 0 || headline.length > 0
      const findingKey = preKey.length > 0 ? preKey : await computeFindingKey(path, headline)
      // Explicit field list — a spread would leak `headline` into the draft.
      // `satisfies` is load-bearing: it is what rejects `headline:` at compile time.
      return {
        findingKey,
        identityResolved,
        contentFingerprint: c.contentFingerprint ?? null,
        category: c.category ?? null,
        score: c.score ?? null,
        confidence: c.confidence ?? null,
        gateScore: c.gateScore ?? null,
        path,
        line: c.line ?? null,
        startLine: c.startLine ?? null,
        sourceSpecialists: c.sourceSpecialists ?? null,
        trustTier: null, // publication is the sole authority; see reconcile
        stage: c.stage,
        gate: clampCode(c.gate),
        reason: clampCode(c.reason),
        enforced: c.enforced ?? false,
      } satisfies FindingEventDraft
    }),
  )
}

/**
 * Build the posted-set lookup that `reconcileFindingOutcomes` resolves against.
 * Keyed the same way as the captures so the two join.
 */
export function buildPostedFindingRecords(posted: readonly PostedFindingCapture[]): Map<string, PostedFindingRecord> {
  const out = new Map<string, PostedFindingRecord>()
  for (const p of posted) {
    const key = safeStr(p.findingKey)
    if (key.length === 0) continue
    const existing = out.get(key)
    // Conflict (same finding inline AND in the body rollup, or a duplicated input):
    // keep the richer record. Last-write-wins would let a later posted-body entry
    // overwrite a posted-inline one and DROP its inlineCommentId.
    if (existing && (existing.surface === "posted-inline" || existing.inlineCommentId != null)) continue
    out.set(key, {
      surface: p.surface,
      inlineCommentId: p.inlineCommentId ?? null,
      trustTier: p.trustTier ?? null,
    })
  }
  return out
}

/** The manifest projection of a posted finding — everything a publish-stage capture
 *  needs, including the key and the content fingerprint. */
interface PostedManifestFinding {
  key: string
  path: string
  score?: number | null | undefined
  line?: number | null | undefined
  category?: string | null | undefined
  contentFingerprint?: string | null | undefined
}

/**
 * Record a candidate that SURVIVED to publication, as a `publish`-stage capture.
 *
 * WHY THIS EXISTS (two gaps it closes):
 *  1. The validator gates only capture candidates they HIT. A finding that tripped
 *     no gate had no row at all — censored sampling, the exact thing the table
 *     exists to prevent.
 *  2. `contentFingerprint` is assigned AFTER the validator stage, so every
 *     validator-stage row has it NULL. It is the join key for human dismissals
 *     (which carry a fingerprint, not a headline), so without a publish-stage row
 *     a dismissal has nothing to join to. NOTE: populated for ANCHORED survivors
 *     only — body-only/unanchored entries reach here with no fingerprint, because
 *     the annotate pass covers the consensus findings, not the unanchored rollup.
 *     Those have no inline comment and so no dismissal to join to either.
 *
 * Uses the manifest's own `key` — no re-derivation, and no headline handling here.
 */
export function capturePostedFinding(sink: FindingEventCapture[] | undefined, f: PostedManifestFinding): void {
  if (!sink) return
  sink.push({
    findingKey: safeStr(f.key),
    path: safeStr(f.path),
    headline: "", // unused: the key is supplied
    stage: "publish",
    contentFingerprint: f.contentFingerprint ?? null,
    category: f.category ?? null,
    score: f.score ?? null,
    line: f.line ?? null,
  })
}
