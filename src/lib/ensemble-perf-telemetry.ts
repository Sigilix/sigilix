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
  /** SIG-149: optional per-review token sink. The orchestrator hangs the
   *  recorder from `makeTokenRecorder` (ensemble-slo-telemetry) here so
   *  the per-attempt `onAttempt` callbacks — which already receive token
   *  counts — can accumulate per-review totals without threading a new
   *  param through `runSpecialist`/`runSynthesizer`. Inline function type
   *  (not an import) keeps this module free of an slo-telemetry dependency
   *  — the slo module imports this type, not the other way around.
   *  Absent in tests / shadow paths that don't care about cost.
   *  SIG-417: `costUsd` is the provider's actual per-call cost (OpenRouter
   *  `usage.cost`, credits ≈ USD), summed alongside tokens so the cost
   *  roll-up prefers measured spend over the token-pricing estimate. */
  recordTokens?: (model: string, inputTokens?: number, outputTokens?: number, costUsd?: number) => void
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
  console.log(
    JSON.stringify({
      event: "ensemble-phase-completed",
      ...correlationFields(ctx),
      phase,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
    }),
  )
}

/** `try { ... } finally { emitPhaseCompleted(...) }` shorthand. The
 *  phase event fires even when the body throws, so a failed phase
 *  shows up with a real duration instead of dropping silently from
 *  the trace. Re-throws the original error so caller behaviour is
 *  unchanged. */
export async function recordPhase<T>(ctx: EnsembleRunCtx, phase: EnsemblePhase, fn: () => Promise<T>): Promise<T> {
  const startedAtMs = Date.now()
  try {
    return await fn()
  } finally {
    emitPhaseCompleted(ctx, phase, startedAtMs)
  }
}

// ─── ensemble-subphase-completed (SIG-374) ──────────────────────────

/** SIG-374: sub-spans inside the `preflight_retrieval` / context-gather
 *  lump, so the dark middle decomposes below the phase level. Same
 *  exhaustive-union convention as `EnsemblePhase`. `ast_source_fetch`
 *  is named honestly: it covers the JS/TS source fetch + cache
 *  creation; actual parsing happens lazily in the AST consumers and is
 *  covered by `deterministic_scans`. */
export type EnsembleSubphase = "dep_vuln_scan" | "ast_source_fetch" | "graph_retrieval" | "runner_evidence"

export function emitSubphaseCompleted(
  ctx: EnsembleRunCtx,
  subphase: EnsembleSubphase,
  startedAtMs: number,
  counts: Record<string, number | boolean> = {},
  endedAtMs: number = Date.now(),
): void {
  console.log(
    JSON.stringify({
      event: "ensemble-subphase-completed",
      ...correlationFields(ctx),
      subphase,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      ...counts,
    }),
  )
}

// ─── github-file-fetch-summary (SIG-374) ────────────────────────────

/** SIG-374: per-review GitHub fetch-overlap summary (sizes SIG-371's
 *  memoization win). The GitHubClient adapter only counts (it imports
 *  no telemetry — dependency rule); the app layer reads the counter at
 *  review end and emits this once per review. */
export function emitGithubFileFetchSummary(
  ctx: EnsembleRunCtx,
  summary: {
    totalCalls: number
    uniqueKeys: number
    dupCalls: number
    topDupPaths: readonly string[]
    prMetaCalls: number
  },
): void {
  console.log(
    JSON.stringify({
      event: "github-file-fetch-summary",
      ...correlationFields(ctx),
      ...summary,
    }),
  )
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
  /** SIG-212: token usage reported by Ollama on the final stream chunk
   *  (`prompt_eval_count`). Optional because providers that don't
   *  surface counts should omit rather than zero-fill — downstream
   *  aggregators treat absent as "no data," not zero. Typically present
   *  on successful attempts; failed attempts (timeout / parse error) may
   *  legitimately have no count. */
  inputTokens?: number
  /** SIG-212: token usage reported by Ollama (`eval_count`). Same
   *  optionality semantics as `inputTokens`. */
  outputTokens?: number
  /** SIG-417: actual per-call cost (OpenRouter `usage.cost`, credits ≈ USD).
   *  Same optionality semantics as the token counts — omitted when the
   *  provider didn't report it (Ollama, exception paths). Surfaced on the
   *  per-attempt event for cost-attribution drilldown. */
  costUsd?: number
  /** SIG-287 (reasoning-on harness): cumulative LENGTH of the model's
   *  `thinking`/CoT field for this attempt (char count only — never the
   *  text). Lets the soak size reasoning time per role. Absent on the
   *  default-off `think:false` path (no reasoning emitted). */
  thinkingChars?: number
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

export function emitSpecialistFanoutSummary(ctx: EnsembleRunCtx, summary: SpecialistFanoutSummary): void {
  console.log(
    JSON.stringify({
      event: "specialist-fanout-summary",
      ...correlationFields(ctx),
      ...summary,
    }),
  )
}

// ─── dispatcher-savings-summary (SIG-224 monitor) ───────────────────

export type DispatcherSavingsType = "actual" | "shadow"

export interface DispatcherSavingsSummary {
  reviewKey: string
  mode: "shadow" | "enforce_rules" | "enforce"
  savingsType: DispatcherSavingsType
  baselineSpecialists: readonly string[]
  dispatcherSpecialists: readonly string[]
  actualSpecialists: readonly string[]
  projectedSkippedRoles: readonly string[]
  actualNotInvokedRoles: readonly string[]
  projectedSpecialistCallsAvoided: number
  actualSpecialistCallsAvoided: number
  perRole: unknown
  layerVotes: unknown
}

export function reviewKeyFor(ctx: EnsembleRunCtx): string {
  return `${ctx.owner}/${ctx.repo}#${ctx.prNumber}@${ctx.headSha.slice(0, 7)}`
}

export function buildDispatcherSavingsSummary(args: {
  ctx: EnsembleRunCtx
  mode: DispatcherSavingsSummary["mode"]
  baselineSpecialists: readonly string[]
  dispatcherSpecialists: readonly string[]
  perRole: unknown
  layerVotes: unknown
}): DispatcherSavingsSummary {
  const actual = args.mode === "shadow" ? args.baselineSpecialists : args.dispatcherSpecialists
  const projectedSkipped = rolesRemoved(args.baselineSpecialists, args.dispatcherSpecialists)
  const actualNotInvoked = args.mode === "shadow" ? [] : rolesRemoved(args.baselineSpecialists, actual)
  return {
    reviewKey: reviewKeyFor(args.ctx),
    mode: args.mode,
    savingsType: args.mode === "shadow" ? "shadow" : "actual",
    baselineSpecialists: [...args.baselineSpecialists],
    dispatcherSpecialists: [...args.dispatcherSpecialists],
    actualSpecialists: [...actual],
    projectedSkippedRoles: projectedSkipped,
    actualNotInvokedRoles: actualNotInvoked,
    projectedSpecialistCallsAvoided: projectedSkipped.length,
    actualSpecialistCallsAvoided: actualNotInvoked.length,
    perRole: args.perRole,
    layerVotes: args.layerVotes,
  }
}

export function emitDispatcherSavingsSummary(ctx: EnsembleRunCtx, summary: DispatcherSavingsSummary): void {
  console.log(
    JSON.stringify({
      event: "dispatcher-savings-summary",
      ...correlationFields(ctx),
      ...summary,
    }),
  )
}

function rolesRemoved(baseline: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(next)
  return baseline.filter((role) => !kept.has(role))
}

/** Per-role outcome used by `computeSpecialistFanoutSummary`. Mirrors
 *  the relevant fields of the orchestrator's `CollectedVerdict` but
 *  decoupled — the helper doesn't need to know about
 *  `PrReviewVerdictWithIds` or `SPECIALIST_CONFIGS`. */
export interface SpecialistFanoutInput {
  role: string
  verdictOk: boolean
  attemptsUsed: number | undefined
  modelUsed: string | undefined
  /** Cross-provider fallback model for this role, used to count
   *  `fallbacksUsed`. `null` means no fallback configured. */
  fallbackModel: string | null
}

/**
 * Sigilix PR #95 catch — pure helper extracted from the inline block
 * in `handlePrReviewEnsemble` so the slowestRole / totalAttemptsUsed /
 * fallbacksUsed computation is unit-testable. The orchestrator just
 * maps its `CollectedVerdict[]` into `SpecialistFanoutInput[]` and
 * calls this.
 *
 * Per-role end time defaults to `fanoutEndMs` when the specialist
 * aborted on the outer signal before its `finally(() => set end)`
 * could fire — that specialist's elapsed becomes "from start to
 * fanout end," which is an over-estimate but never an under-estimate.
 * Over-estimate is the right bias for "slowest role" reporting: if a
 * role aborted on the outer wall, it was at least as slow as the
 * fanout wall-clock.
 *
 * Pure — exported for tests.
 */
export function computeSpecialistFanoutSummary(args: {
  dispatchedRoles: readonly string[]
  inputs: readonly SpecialistFanoutInput[]
  perRoleStartMs: ReadonlyMap<string, number>
  perRoleEndMs: ReadonlyMap<string, number>
  fanoutStartMs: number
  fanoutEndMs: number
}): SpecialistFanoutSummary {
  const succeededRoles = args.inputs.filter((v) => v.verdictOk).map((v) => v.role)
  const failedRoles = args.inputs.filter((v) => !v.verdictOk).map((v) => v.role)
  let slowestRole: string | null = null
  let slowestElapsedMs = 0
  for (const role of args.dispatchedRoles) {
    const startedAt = args.perRoleStartMs.get(role)
    const endedAt = args.perRoleEndMs.get(role)
    const ended = endedAt ?? args.fanoutEndMs
    const elapsed = startedAt !== undefined ? ended - startedAt : 0
    if (elapsed > slowestElapsedMs) {
      slowestElapsedMs = elapsed
      slowestRole = role
    }
  }
  const totalAttemptsUsed = args.inputs.reduce((sum, v) => sum + (v.attemptsUsed ?? 1), 0)
  const fallbacksUsed = args.inputs.reduce(
    (sum, v) =>
      sum + (v.modelUsed !== undefined && v.fallbackModel !== null && v.modelUsed === v.fallbackModel ? 1 : 0),
    0,
  )
  return {
    dispatchedRoles: args.dispatchedRoles,
    succeededRoles,
    failedRoles,
    fanoutElapsedMs: args.fanoutEndMs - args.fanoutStartMs,
    slowestRole,
    slowestElapsedMs,
    totalAttemptsUsed,
    fallbacksUsed,
  }
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
  console.log(
    JSON.stringify({
      event: "synth-summary",
      ...correlationFields(ctx),
      ...summary,
    }),
  )
}

/** Internal outcome union used by the orchestrator's `synthRetryOutcome`
 *  tracker. Wider than `SynthSummary["retryOutcome"]` — includes the
 *  `"n/a"` sentinel for "retry didn't fire" and `"exhausted-budget"`
 *  for synth-internal budget exhaustion. The narrowing helper below
 *  collapses both to `null` for the telemetry surface. */
export type SynthRetryOutcomeInput = "n/a" | "ok" | "timeout" | "parse" | "provenance" | "exhausted-budget"

/**
 * Sigilix PR #95 catch — coerce the orchestrator-internal
 * `synthRetryOutcome` (wider union) into the narrower
 * `SynthSummary["retryOutcome"]` shape that downstream log analyzers
 * rely on. Three behaviors:
 *
 *   - `retryUsed === false`               → `null` (retry didn't fire)
 *   - outcome === `"n/a"`                  → `null` (defensive: should
 *                                            be unreachable when
 *                                            retryUsed === true)
 *   - outcome === `"exhausted-budget"`     → `null` (synth-internal
 *                                            sentinel, not a model
 *                                            outcome)
 *   - outcome ∈ {ok,timeout,parse,provenance} → passthrough
 *
 * Extracted from the inline ternary in `handlePrReviewEnsemble` so
 * the coercion is unit-testable. Pure — exported for tests.
 */
export function narrowSynthRetryOutcome(
  retryUsed: boolean,
  outcome: SynthRetryOutcomeInput,
): SynthSummary["retryOutcome"] {
  if (!retryUsed) return null
  if (outcome === "n/a") return null
  if (outcome === "ok" || outcome === "timeout" || outcome === "parse" || outcome === "provenance") {
    return outcome
  }
  return null
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

export function emitDoReviewRunTiming(ctx: EnsembleRunCtx, timing: DoReviewRunTiming): void {
  console.log(
    JSON.stringify({
      event: "do-review-run-timing",
      ...correlationFields(ctx),
      ...timing,
    }),
  )
}

// ─── logic-input-composition (SIG-369(b)) ───────────────────────────

/**
 * SIG-369(b): emit the logic specialist's input-token decomposition (shadow
 * mode only — the caller gates on `flags.logicInputCompositionMode`). The
 * composition is assembled by the pure domain helper
 * (`buildLogicInputComposition` in `ensemble/domain/logic-input-composition`);
 * this is the IO/observability seam that logs it (keeping the domain module
 * env/console-free, per the dependency rule — Codex sign-off C).
 *
 * The `composition` parameter is a STRUCTURAL shape (not an imported type) so
 * this module stays import-free — the same convention `recordTokens` uses for
 * its inline function type (this leaf is imported BY others, never the reverse).
 * `LogicInputComposition` satisfies it structurally.
 *
 * Console.log-only — pure observability, no behavior change. Catches its own
 * throw so a degenerate JSON shape can never abort the fan-out path (mirrors
 * `maybeEmitLogicPromptBudget`).
 *
 * `reconcile` carries the cost-attribution pair: the configured logic model id
 * and the matching `tokenUsageByModel[logicModel].inputTokens`, so a dashboard
 * can confirm `summedInputTokens` lines up with the per-model accumulator
 * without a join. A mismatch flags a capture gap, not a cost change.
 */
export interface LogicInputCompositionEvent {
  systemPromptTokens: number
  initialMessageTokens: number
  sections: unknown
  toolLoop: { toolsAvailable: boolean; toolCallsMade: number; toolResultTokens: number }
  perCallInputTokens: number[]
  summedInputTokens: number
  callsMissingInputUsage: number
}

export function emitLogicInputComposition(
  ctx: EnsembleRunCtx,
  composition: LogicInputCompositionEvent,
  reconcile: { logicModel: string; summedFromTokenUsage: number | undefined },
): void {
  try {
    console.log(
      JSON.stringify({
        event: "logic-input-composition",
        ...correlationFields(ctx),
        logicModel: reconcile.logicModel,
        systemPromptTokens: composition.systemPromptTokens,
        initialMessageTokens: composition.initialMessageTokens,
        sections: composition.sections,
        toolLoop: composition.toolLoop,
        perCallInputTokens: composition.perCallInputTokens,
        summedInputTokens: composition.summedInputTokens,
        callsMissingInputUsage: composition.callsMissingInputUsage,
        summedInputTokensFromTokenUsage: reconcile.summedFromTokenUsage ?? null,
      }),
    )
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "logic-input-composition-emit-failed",
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
