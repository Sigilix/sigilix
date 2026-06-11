// ARC-283 Phase B1b — pure emit helpers for shadow-mode bake-off
// events. Mirrors the shape conventions in `ensemble-perf-telemetry.ts`:
//
//   - `console.log(JSON.stringify(...))` with `event` discriminator
//   - `EnsembleRunCtx` correlation fields stamped on every event
//   - headSha truncated to 7 chars at log time
//   - pure helper functions exported for unit testing
//
// Event taxonomy:
//   - `shadow-model-attempt-completed` — one per LLM call inside the
//     shadow runner (primary, retry, fallback). Mirrors prod's
//     `model-attempt-completed` shape so log analyzers can join the
//     two by `(role, attemptKind, attemptIndex)`.
//   - `shadow-verdict-comparison` — one per role with shadow enabled,
//     emitted AFTER both prod + shadow settle. Carries the post-hoc
//     diff: latency, attempts, findings counts, overlap, score
//     histograms, shadow failure reason.

import type { EnsembleRunCtx } from "./ensemble-perf-telemetry"

function correlationFields(ctx: EnsembleRunCtx): Record<string, string | number> {
  return {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: ctx.headSha.slice(0, 7),
  }
}

// ─── shadow-model-attempt-completed ───────────────────────────────

export type ShadowAttemptKind = "primary" | "retry" | "fallback"
export type ShadowAttemptOutcome = "ok" | "failed" | "aborted" | "timeout"

export interface ShadowAttemptEvent {
  /** Role being shadowed (`logic` / `security` / `performance` /
   *  `tests` / `synth`). */
  role: string
  attemptKind: ShadowAttemptKind
  /** 1-indexed attempt counter across the entire shadow
   *  `runWithRetryAndFallback` call. */
  attemptIndex: number
  model: string
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  elapsedMs: number
  outcome: ShadowAttemptOutcome
  /** Present when outcome ≠ ok. */
  failureReason?: string
  /** SIG-212: token usage reported by Ollama (`prompt_eval_count`).
   *  Mirrors the prod `model-attempt-completed` event so log analyzers
   *  can join shadow + prod attempts on `(role, attemptKind,
   *  attemptIndex)` AND aggregate token usage across both. Optional —
   *  absent when the provider didn't surface a count. */
  inputTokens?: number
  /** SIG-212: token usage reported by Ollama (`eval_count`). */
  outputTokens?: number
}

export function emitShadowAttempt(ctx: EnsembleRunCtx, info: ShadowAttemptEvent): void {
  const { failureReason, ...rest } = info
  const payload: Record<string, unknown> = {
    event: "shadow-model-attempt-completed",
    ...correlationFields(ctx),
    ...rest,
  }
  if (failureReason !== undefined) payload["failureReason"] = failureReason
  console.log(JSON.stringify(payload))
}

// ─── shadow-verdict-comparison ────────────────────────────────────

/** Per-score histogram. Always emits 1..5 keys (zero-filled). */
export type ScoreHistogram = Record<1 | 2 | 3 | 4 | 5, number>

export interface ShadowVerdictComparison {
  role: string
  prodModel: string
  shadowModel: string
  prodVerdictOk: boolean
  shadowVerdictOk: boolean
  prodElapsedMs: number
  shadowElapsedMs: number
  prodAttemptsUsed: number
  shadowAttemptsUsed: number
  prodFindingsCount: number
  shadowFindingsCount: number
  /** Findings present in BOTH prod and shadow (matched on
   *  (path, line, category) tuple). */
  overlapCount: number
  /** Findings in prod but not in shadow. */
  prodOnlyCount: number
  /** Findings in shadow but not in prod. */
  shadowOnlyCount: number
  prodScoreHistogram: ScoreHistogram
  shadowScoreHistogram: ScoreHistogram
  /**
   * SIG-86 (Codex Q4): score-filtered overlap counts. The B1c
   * aggregator needs `score4PlusOverlapCount / (score4PlusOverlapCount
   * + score4PlusProdOnlyCount)` as the main overlap-with-prod ratio
   * (only score-4+ findings carry decision weight in the bake-off
   * bars). Computed here while raw findings are in memory — historical
   * events without these fields surface as `inconclusive` to the
   * aggregator rather than being approximated from histograms.
   */
  score4PlusOverlapCount: number
  score4PlusProdOnlyCount: number
  score4PlusShadowOnlyCount: number
  score4PlusProdFindingsCount: number
  score4PlusShadowFindingsCount: number
  /** Set when shadow failed (no verdict). null on shadow success. */
  shadowFailureReason: string | null
}

export function emitShadowVerdictComparison(ctx: EnsembleRunCtx, comp: ShadowVerdictComparison): void {
  console.log(
    JSON.stringify({
      event: "shadow-verdict-comparison",
      ...correlationFields(ctx),
      ...comp,
    }),
  )
}

/**
 * ARC-283 Phase B1b review pass — emitted when a shadow promise was
 * still in flight when the `handlePrReviewEnsemble` finally block hit
 * its grace cap. The shadow run is abandoned (no comparison emit),
 * and the prod return value is unaffected.
 *
 * `role` is one of the five shadow roles. `elapsedAtCutMs` is the wall-
 * clock spent inside the finally block before the cut (always ≤
 * SHADOW_FINALIZE_GRACE_MS). `reason` distinguishes the two grace
 * paths:
 *   - `grace_deadline` — the 5s wall-clock cap fired while the shadow
 *     promise was still pending.
 *   - `orch_aborted`   — the outer orchestrator (orchCtrl) aborted
 *     before the shadow promise settled (e.g. the 895s orchestrator
 *     wall fired, or the worker is being torn down).
 *
 * NOTE: a shadow runner _crash_ (the promise rejected) is a separate
 * event — see `shadow-run-failed` / `emitShadowRunFailed` below. Don't
 * collapse those two into one event: confusing a runner crash for a
 * time expiry hides real failure signal in dashboards.
 */
export type ShadowCutShortReason = "grace_deadline" | "orch_aborted"

export interface ShadowCutShortEvent {
  role: "logic" | "security" | "performance" | "tests" | "synth"
  elapsedAtCutMs: number
  reason: ShadowCutShortReason
}

export function emitShadowCutShort(ctx: EnsembleRunCtx, info: ShadowCutShortEvent): void {
  console.log(
    JSON.stringify({
      event: "shadow-cut-short",
      ...correlationFields(ctx),
      ...info,
    }),
  )
}

/**
 * ARC-283 Phase B1b CR-1: emitted when a shadow promise _rejected_
 * (the shadow runner itself threw, distinct from the grace deadline
 * expiring on a still-pending shadow). The shadow runners catch every
 * internal failure and return a structured `{verdictOk:false, ...}`
 * shape, so the only way the promise can reject is a programming bug
 * or a host-environment failure (memory limit, runtime tear-down).
 *
 * Surfacing this as a separate event makes the difference visible in
 * dashboards: `shadow-cut-short` = "we ran out of time", whereas
 * `shadow-run-failed` = "the shadow code path itself broke and needs
 * an on-call look". Before this split, both paths emitted
 * `shadow-cut-short`, masking real runner crashes as benign timeouts.
 */
export interface ShadowRunFailedEvent {
  role: "logic" | "security" | "performance" | "tests" | "synth"
  /** Error.message (or String(err)) from the rejected shadow promise. */
  message: string
}

export function emitShadowRunFailed(ctx: EnsembleRunCtx, info: ShadowRunFailedEvent): void {
  console.log(
    JSON.stringify({
      event: "shadow-run-failed",
      ...correlationFields(ctx),
      ...info,
    }),
  )
}

// ─── findings overlap + histogram (pure helper) ───────────────────

/** Minimum shape we need to compare findings. Both
 *  PrReviewVerdict.findings and the synth output's `findings` array
 *  satisfy this — we only depend on `path`/`line`/`category`/`score`. */
export interface FindingForOverlap {
  path: string
  line: number
  category: string
  score: number
}

export interface FindingsOverlapResult {
  overlapCount: number
  prodOnlyCount: number
  shadowOnlyCount: number
  prodScoreHistogram: ScoreHistogram
  shadowScoreHistogram: ScoreHistogram
  /**
   * SIG-86 (Codex Q4): score-4+ filtered overlap. The aggregator's
   * pass/fail bar is "≥50% overlap at score 4+" — derived metrics
   * have to be computed here, while the raw findings are still in
   * memory. Recomputing from histograms alone is impossible because
   * histograms lose tuple identity.
   */
  score4PlusOverlapCount: number
  score4PlusProdOnlyCount: number
  score4PlusShadowOnlyCount: number
  score4PlusProdFindingsCount: number
  score4PlusShadowFindingsCount: number
}

function key(f: FindingForOverlap): string {
  return `${f.path}:${f.line}:${f.category}`
}

function emptyHistogram(): ScoreHistogram {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
}

function buildHistogram(findings: readonly FindingForOverlap[]): ScoreHistogram {
  const h = emptyHistogram()
  for (const f of findings) {
    const s = f.score
    if (s === 1 || s === 2 || s === 3 || s === 4 || s === 5) {
      h[s] = h[s] + 1
    }
  }
  return h
}

/**
 * Compute findings overlap between prod + shadow on the
 * (path, line, category) tuple. Dedup by tuple within each side, so
 * a model that emits two findings on the same line+category still
 * counts as one entry.
 *
 * Histograms are taken from the ORIGINAL (un-deduped) findings array
 * to preserve "this model is spammy on score-1" signal.
 *
 * SIG-86 (Codex Q4): also computes the score-4+ filtered overlap +
 * per-side counts. Filtering happens on the RAW findings (before tuple
 * dedup) so a single (path, line, category) that appears at scores
 * 3 and 5 in the same array still contributes to the score-4+ side.
 */
export function computeFindingsOverlap(
  prod: readonly FindingForOverlap[],
  shadow: readonly FindingForOverlap[],
): FindingsOverlapResult {
  const prodKeys = new Set(prod.map(key))
  const shadowKeys = new Set(shadow.map(key))
  let overlap = 0
  for (const k of prodKeys) if (shadowKeys.has(k)) overlap++

  // Score-4+ filtered overlap. Build keys from findings whose score is
  // 4 or 5 only; the dedup-by-tuple semantics match the main overlap
  // calculation above.
  const prodScore4Plus = prod.filter((f) => f.score >= 4)
  const shadowScore4Plus = shadow.filter((f) => f.score >= 4)
  const prodScore4PlusKeys = new Set(prodScore4Plus.map(key))
  const shadowScore4PlusKeys = new Set(shadowScore4Plus.map(key))
  let score4PlusOverlap = 0
  for (const k of prodScore4PlusKeys) {
    if (shadowScore4PlusKeys.has(k)) score4PlusOverlap++
  }

  return {
    overlapCount: overlap,
    prodOnlyCount: prodKeys.size - overlap,
    shadowOnlyCount: shadowKeys.size - overlap,
    prodScoreHistogram: buildHistogram(prod),
    shadowScoreHistogram: buildHistogram(shadow),
    score4PlusOverlapCount: score4PlusOverlap,
    score4PlusProdOnlyCount: prodScore4PlusKeys.size - score4PlusOverlap,
    score4PlusShadowOnlyCount: shadowScore4PlusKeys.size - score4PlusOverlap,
    score4PlusProdFindingsCount: prodScore4Plus.length,
    score4PlusShadowFindingsCount: shadowScore4Plus.length,
  }
}

// ─── pure helper: build the comparison payload ────────────────────
//
// Extracted so the orchestrator's hot path stays a thin caller and
// the diff-shape logic gets unit-tested in isolation. Same fields the
// orchestrator used to populate inline against `prod*` / `shadow*`
// locals — no behavior change.

/** Minimum prod-side outcome the comparison needs. Mirrors the
 *  subset of `SpecialistRunResult` / `SynthesizerRunOutput` that
 *  the orchestrator already collects pre-shadow. */
export interface ProdOutcomeForComparison {
  /** Did the prod model produce a parseable verdict? */
  verdictOk: boolean
  /** Final model that produced the verdict (or last-attempted on
   *  failure). Differs from the role's `primary` when fallback fired. */
  modelUsed: string
  /** Total prod attempts across primary retries + cross-provider
   *  fallback. */
  attemptsUsed: number
  /** Wall-clock elapsed for the prod call. */
  elapsedMs: number
  /** Findings extracted from the prod verdict (empty when verdictOk
   *  is false). Same `(path, line, category, score)` projection the
   *  shadow runner already returns so `computeFindingsOverlap` can
   *  consume both sides uniformly. */
  findings: readonly FindingForOverlap[]
}

/** Minimum shadow-side outcome the comparison needs. Matches the
 *  shape `runShadowSpecialist` / `runShadowSynth` already return —
 *  this re-declared type avoids a cyclic import from the orchestrator
 *  module without restating the runner's fuller `ShadowRunResult`. */
export interface ShadowOutcomeForComparison {
  verdictOk: boolean
  modelUsed: string
  attemptsUsed: number
  elapsedMs: number
  findings: readonly FindingForOverlap[]
  /** Free-form failure reason from `runWithRetryAndFallback`, or
   *  undefined on success. */
  failureReason?: string
}

export interface BuildShadowVerdictComparisonArgs {
  /** Role being compared (`logic`/`security`/`performance`/`tests`
   *  on the specialist path, `synth` on the synth path). Stamped on
   *  the emitted event so log-analyzers can pivot. */
  role: string
  /** Default prod model for the role (the config's primary). Used
   *  when prod failed before `modelUsed` could be set. */
  prodModelDefault: string
  prod: ProdOutcomeForComparison
  shadow: ShadowOutcomeForComparison
}

/**
 * Build the `ShadowVerdictComparison` payload from the prod + shadow
 * outcomes. Pure: no I/O, no telemetry, no environment lookups.
 *
 * Contract:
 *   - When prod produced no verdict, fall back to `prodModelDefault`
 *     for `prodModel` so the event still names the configured primary
 *     (not an empty string).
 *   - `prodAttemptsUsed` / `prodElapsedMs` are pass-through —
 *     callers are expected to fill the same values they would log to
 *     `EnsembleTelemetry`.
 *   - `shadowFailureReason` is `null` on shadow success, the shadow
 *     runner's `failureReason` string on failure, or the literal
 *     "unknown" sentinel when shadow failed without a reason
 *     (defensive — `runWithRetryAndFallback` always populates one
 *     today, but the helper stays robust to future shape drift).
 */
export function buildShadowVerdictComparison(args: BuildShadowVerdictComparisonArgs): ShadowVerdictComparison {
  const { role, prodModelDefault, prod, shadow } = args
  const overlap = computeFindingsOverlap(prod.findings, shadow.findings)
  return {
    role,
    prodModel: prod.verdictOk ? prod.modelUsed : prod.modelUsed || prodModelDefault,
    shadowModel: shadow.modelUsed,
    prodVerdictOk: prod.verdictOk,
    shadowVerdictOk: shadow.verdictOk,
    prodElapsedMs: prod.elapsedMs,
    shadowElapsedMs: shadow.elapsedMs,
    prodAttemptsUsed: prod.attemptsUsed,
    shadowAttemptsUsed: shadow.attemptsUsed,
    prodFindingsCount: prod.findings.length,
    shadowFindingsCount: shadow.findings.length,
    overlapCount: overlap.overlapCount,
    prodOnlyCount: overlap.prodOnlyCount,
    shadowOnlyCount: overlap.shadowOnlyCount,
    prodScoreHistogram: overlap.prodScoreHistogram,
    shadowScoreHistogram: overlap.shadowScoreHistogram,
    score4PlusOverlapCount: overlap.score4PlusOverlapCount,
    score4PlusProdOnlyCount: overlap.score4PlusProdOnlyCount,
    score4PlusShadowOnlyCount: overlap.score4PlusShadowOnlyCount,
    score4PlusProdFindingsCount: overlap.score4PlusProdFindingsCount,
    score4PlusShadowFindingsCount: overlap.score4PlusShadowFindingsCount,
    shadowFailureReason: shadow.verdictOk ? null : (shadow.failureReason ?? "unknown"),
  }
}
