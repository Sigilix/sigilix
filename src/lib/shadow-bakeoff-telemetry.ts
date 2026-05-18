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
  /** Set when shadow failed (no verdict). null on shadow success. */
  shadowFailureReason: string | null
}

export function emitShadowVerdictComparison(
  ctx: EnsembleRunCtx,
  comp: ShadowVerdictComparison,
): void {
  console.log(JSON.stringify({
    event: "shadow-verdict-comparison",
    ...correlationFields(ctx),
    ...comp,
  }))
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
 */
export function computeFindingsOverlap(
  prod: readonly FindingForOverlap[],
  shadow: readonly FindingForOverlap[],
): FindingsOverlapResult {
  const prodKeys = new Set(prod.map(key))
  const shadowKeys = new Set(shadow.map(key))
  let overlap = 0
  for (const k of prodKeys) if (shadowKeys.has(k)) overlap++
  return {
    overlapCount: overlap,
    prodOnlyCount: prodKeys.size - overlap,
    shadowOnlyCount: shadowKeys.size - overlap,
    prodScoreHistogram: buildHistogram(prod),
    shadowScoreHistogram: buildHistogram(shadow),
  }
}
