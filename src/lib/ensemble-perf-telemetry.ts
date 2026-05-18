// ARC-284 (Phase B0) — pure-observability telemetry for the ensemble
// review path. Every event in this module is `console.log`-only; no
// behavior change, no branches in the production hot path.
//
// The goal is to answer Codex's PR #94 latency analysis with hard
// numbers instead of inference. Once these events are emitting on
// production traffic, the next architectural change (ARC-286 Phase
// B1: fast path + skip-synth + dynamic dispatch) can be driven by
// data rather than estimates.
//
// Why a separate module?
//   - Keeps `triage-pr-review-ensemble.ts` from growing further
//     (already ~4 KLOC).
//   - Centralizes event shape so tests can pin the field set in one
//     place and future B0-style additions don't drift schemas.
//   - Makes the import surface obvious: any file that wants to
//     contribute timing telemetry imports from here.
//
// Event taxonomy (Codex spec from `arc-283-perf-research-codex-response.md`):
//   - `ensemble-phase-completed` — one per coarse-grained phase
//     (github_preload, diff_pack, preflight_retrieval, …, finalize)
//   - `model-attempt-completed`  — one per LLM call inside the
//     ensemble (specialist primary, retry, fallback, synth primary,
//     synth retry)
//   - `specialist-fanout-summary` — once per ensemble run, after the
//     Promise.allSettled() on the specialist fan-out resolves
//   - `synth-summary` — once per ensemble run, after synth lands
//     (success or skip-notice)
//   - `do-review-run-timing` — once per DO-routed run, from
//     `runPrReviewWithDoCallback`

/** Common correlation fields stamped on every event. `headSha` is
 *  truncated to 7 chars at log time to match the rest of the codebase's
 *  log surface (full SHA still available via the PR number).
 */
export interface EnsembleRunCtx {
  owner: string
  repo: string
  prNumber: number
  /** Full 40-char SHA. The emitter truncates to 7 chars for the log
   *  field; keeping it full here makes the type unambiguous + lets
   *  future emitters opt out of truncation if needed. */
  headSha: string
}

function correlationFields(ctx: EnsembleRunCtx): Record<string, string | number> {
  return {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: ctx.headSha.slice(0, 7),
  }
}

// ─── ensemble-phase-completed ───────────────────────────────────────

/** Phases recognized by `ensemble-phase-completed`. Exhaustive at
 *  the ARC-284 milestone — new phases are added here so the test
 *  surface catches accidental typos in call sites. */
export type EnsemblePhase =
  | "github_preload"
  | "diff_pack"
  | "preflight_retrieval"
  | "deterministic_scans"
  | "stack_context"
  | "specialist_fanout"
  | "review_memory"
  | "synth"
  | "post_validation"
  | "submit"
  | "finalize"

export function emitPhaseCompleted(
  ctx: EnsembleRunCtx,
  phase: EnsemblePhase,
  startedAtMs: number,
  endedAtMs: number = Date.now(),
): void {
  console.log(JSON.stringify({
    event: "ensemble-phase-completed",
    ...correlationFields(ctx),
    phase,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
  }))
}

/** `try { ... } finally { emitPhaseCompleted(...) }` shorthand. The
 *  phase event fires even when the body throws, so a failed phase
 *  shows up with a real duration instead of dropping silently from
 *  the trace. Re-throws the original error so caller behaviour is
 *  unchanged. */
export async function recordPhase<T>(
  ctx: EnsembleRunCtx,
  phase: EnsemblePhase,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now()
  try {
    return await fn()
  } finally {
    emitPhaseCompleted(ctx, phase, startedAtMs)
  }
}

// ─── model-attempt-completed ────────────────────────────────────────

/** Phase of the ensemble that owns this attempt. `specialist` covers
 *  all four roles (logic / security / performance / tests); `synth`
 *  covers both the primary synth call and the ARC-278 one-shot retry.
 */
export type ModelAttemptPhase = "specialist" | "synth"

/** Where this attempt sits within `runWithRetryAndFallback`'s retry
 *  matrix. */
export type ModelAttemptKind = "primary" | "retry" | "fallback"

export type ModelAttemptOutcome = "ok" | "failed" | "aborted" | "timeout"

export interface ModelAttemptEvent {
  /** Specialist | synth. */
  phase: ModelAttemptPhase
  /** For specialists, the role name (`logic`/`security`/...). For
   *  synth, the literal string `"synth"`. */
  role: string
  /** Which retry/fallback bucket this attempt belongs to. */
  attemptKind: ModelAttemptKind
  /** 1-indexed attempt counter across the entire
   *  `runWithRetryAndFallback` call (primary retries → fallback in
   *  order). Useful for correlating with `attemptsUsed`. */
  attemptIndex: number
  /** Model identifier (e.g. `deepseek-v4-pro:cloud`). */
  model: string
  /** Per-attempt timeout cap (`PER_ATTEMPT_TIMEOUT_MS` or the synth
   *  attempt cap). */
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  elapsedMs: number
  outcome: ModelAttemptOutcome
  /** Present when outcome ≠ ok. Free-form reason (HTTP status,
   *  parse-failure label, etc.) — same string `runWithRetryAndFallback`
   *  surfaces in its `failureReason` return. */
  failureReason?: string
}

export function emitModelAttempt(ctx: EnsembleRunCtx, info: ModelAttemptEvent): void {
  const { failureReason, ...rest } = info
  const payload: Record<string, unknown> = {
    event: "model-attempt-completed",
    ...correlationFields(ctx),
    ...rest,
  }
  if (failureReason !== undefined) payload["failureReason"] = failureReason
  console.log(JSON.stringify(payload))
}

// ─── specialist-fanout-summary ──────────────────────────────────────

export interface SpecialistFanoutSummary {
  dispatchedRoles: readonly string[]
  succeededRoles: readonly string[]
  failedRoles: readonly string[]
  fanoutElapsedMs: number
  /** Role that took the longest among DISPATCHED roles (whether it
   *  succeeded or failed). `null` when no roles were dispatched. */
  slowestRole: string | null
  slowestElapsedMs: number
  /** Sum of `attemptsUsed` across every specialist's
   *  `runWithRetryAndFallback` outcome. Counts primary + retries +
   *  fallback as one each. */
  totalAttemptsUsed: number
  /** How many specialists landed on their cross-provider fallback
   *  (i.e. `modelUsed === config.fallback`). */
  fallbacksUsed: number
}

export function emitSpecialistFanoutSummary(
  ctx: EnsembleRunCtx,
  summary: SpecialistFanoutSummary,
): void {
  console.log(JSON.stringify({
    event: "specialist-fanout-summary",
    ...correlationFields(ctx),
    ...summary,
  }))
}

// ─── synth-summary ──────────────────────────────────────────────────

export interface SynthSummary {
  elapsedMs: number
  attemptsUsed: number
  retryUsed: boolean
  /** Present when `retryUsed === true`. `null` when retry didn't
   *  fire. The four-way outcome mirrors `SynthAttemptOutcome` in
   *  `triage-pr-review-ensemble.ts`. */
  retryOutcome: "ok" | "timeout" | "parse" | "provenance" | null
  inputSpecialistCount: number
  inputFindingCount: number
  outputFindingCount: number
  /** Final model that produced the verdict, or the one that failed
   *  on the last attempt when synth bailed. */
  modelUsed: string
}

export function emitSynthSummary(ctx: EnsembleRunCtx, summary: SynthSummary): void {
  console.log(JSON.stringify({
    event: "synth-summary",
    ...correlationFields(ctx),
    ...summary,
  }))
}

// ─── do-review-run-timing ───────────────────────────────────────────

/** Emitted by `runPrReviewWithDoCallback` after the run-result post
 *  resolves. Captures the queue → DO → ensemble → result path so
 *  end-to-end latency includes the parts BEFORE the orchestrator
 *  starts. */
export interface DoReviewRunTiming {
  /** DO run-id assigned by the dispatcher. */
  runId: string
  /** Wall-clock the queue consumer entered. */
  pickedUpAtMs: number
  /** Wall-clock the run-result post resolved. */
  finishedAtMs: number
  /** End-to-end consumer time. Includes the ensemble run but also DO
   *  /pickup + /run-result roundtrips. */
  consumerWallMs: number
  /** `posted` / `errored` / `skipped`, mirrors the ensemble's
   *  `EnsembleResult.status`. */
  finalState: string
}

export function emitDoReviewRunTiming(
  ctx: EnsembleRunCtx,
  timing: DoReviewRunTiming,
): void {
  console.log(JSON.stringify({
    event: "do-review-run-timing",
    ...correlationFields(ctx),
    ...timing,
  }))
}
