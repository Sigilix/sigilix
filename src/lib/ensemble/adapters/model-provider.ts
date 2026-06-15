// SIG-362 (PR 10) — the model-call adapter (adapters layer): the
// Ollama→OpenRouter seam.
//
// The ONLY place that knows the actual provider call (`chat`) + the per-role
// model lineups + the HTTP/parse error taxonomy. Holds the retry/fallback
// executor (`runWithRetryAndFallback`) and the specialist/synthesizer runners;
// the wire-format parsers (`parseSynthAnswer`/`isValidProvenance`) are
// colocated pure helpers. The pure retry knobs (`ModelConfig`/backoff/
// maxAttempts) live in `../domain/model-policy`.
//
// Three documented LATERALS (pre-existing couplings, frozen verbatim in this
// pure-move PR — ADR / Tier-1 tracked, NOT untangled here): the perf-telemetry
// emitter, the agent-loop timeout composer, and the wire parser still living
// in triage-pr-review.ts (the render/submit sibling, itself decomposing under
// Tier-1). These point sideways/up and are deliberately left
// as-is until a later PR pulls them to ports.

import type { ChatMessage } from "@/src/shared/ports/model"
import { type ModelConfig, RETRY_BACKOFF_MS, maxAttempts } from "@/src/lib/ensemble/domain/model-policy"
import type { CostProjectionLineup } from "@/src/lib/ensemble/domain/cost-projection"
import { PER_ATTEMPT_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import {
  reconstructSynthProvenance,
  type ProvenanceSource,
} from "@/src/lib/ensemble/domain/synth-provenance-reconstruct"
// SIG-386 (PR1): the pure `isPermanentFailure` classifier moved to a sibling
// leaf to land this adapter at <=1k lines. Re-exported below so the public
// surface (and the importers + vi.mock paths pinned to this module) are
// unchanged; also consumed internally by `runWithRetryAndFallback`.
// SIG-287: `wrapFailure` joined the leaf for the same budget reason (private —
// not re-exported, only `runWithRetryAndFallback` calls it).
import { breaksSameModelRetry, isValidProvenance, wrapFailure } from "./model-provider-internals"
export { breaksSameModelRetry, isPermanentFailure, isValidProvenance } from "./model-provider-internals"
// SIG-405/406: per-model API-key selection (key-by-id-shape) — OpenRouter id →
// OPENROUTER_API_KEY, `:cloud` tag → OLLAMA_API_KEY. The latter lets local eval runs
// hit Ollama Turbo (no OpenRouter spend) via a `:cloud` model override. Re-exported.
import { selectConfigApiKey, type ModelApiKeys } from "./model-provider-routing"
export { modelApiKeys, selectConfigApiKey, type ModelApiKeys } from "./model-provider-routing"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
// ─── documented laterals (frozen in this pure-move PR; ADR / Tier-1 tracked) ──
import { emitModelAttempt, type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { withComposedTimeout } from "@/src/lib/agent-loop"
import { parsePrReviewResponse } from "@/src/lib/triage-pr-review"
import type { McpToolId } from "@/src/shared/domain/config/types"
import { createSpecialistMcpTools } from "./specialist-mcp-tools"
import { type SpecialistRuntimeTool } from "./specialist-tool-loop"
import { attemptChat } from "./model-provider-attempt"

/**
 * Per-role model lineup (SIG-406 alpha, 2026-06-14): the OpenRouter LIVE DEFAULT.
 * All review roles run on OpenRouter — `fallback: null` because OpenRouter routes
 * each call across upstream providers with automatic failover (no per-role backup
 * needed). `retries: 1` covers a transient OpenRouter error. Reasoning levels
 * (logic+tests medium) + the recall/reasoning prompt suffixes are env-applied via
 * `wrangler.toml [vars]`, so code defaults stay off for local/tests.
 *
 * Local eval testing still hits Ollama Turbo with NO OpenRouter spend: the `chat`
 * router dispatches by model-id shape, so a `:cloud` override (the eval harness's
 * `FIXTURE_EVAL_MODEL_<role>` / `LOGIC_RECALL_MODEL`) routes to Ollama and the key
 * is picked by shape. Pre-alpha Ollama lineup history lives in git.
 */
export const SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  // logic — openai/o3: best deep multi-step reasoning for the subtle-correctness
  // frontier (races/predicates/data-flow). Runs with the recall-suffix +
  // reasoning-suffix-v1 at effort medium (via [vars]).
  logic: {
    primary: "openai/o3",
    retries: 1,
    fallback: null,
    perAttemptTimeoutMs: 120_000,
  },
  // security — deepseek/deepseek-v4-flash: fast reasoner; reasoning stays OFF (it
  // regresses flash), recall-suffix + authz-resolution addendum carry recall.
  security: {
    primary: "deepseek/deepseek-v4-flash",
    retries: 1,
    fallback: null,
  },
  // performance — z-ai/glm-5.1: perf bugs are universal structural patterns; no
  // reasoning (off), fast + cheap on the highest-volume role.
  performance: {
    primary: "z-ai/glm-5.1",
    retries: 1,
    fallback: null,
  },
  // tests — deepseek/deepseek-v4-pro: edges flash on subtle test-quality cases;
  // reasoning medium (via [vars]).
  tests: {
    primary: "deepseek/deepseek-v4-pro",
    retries: 1,
    fallback: null,
    perAttemptTimeoutMs: 160_000,
  },
}

export const SYNTHESIZER_CONFIG: ModelConfig = {
  // SIG-406 alpha: nemotron-3-ultra on OpenRouter — a strong GENERALIST adjudicator
  // (dedupe / severity / merge) decorrelated from every specialist family
  // (o3 / DeepSeek / GLM), so it's an unbiased judge with no self-preference. Runs
  // free-form (format:undefined) with the retention directive (recall-first; the
  // gates handle precision). retries:1; fallback:null (OpenRouter self-routes).
  primary: "nvidia/nemotron-3-ultra-550b-a55b",
  retries: 1,
  fallback: null,
  perAttemptTimeoutMs: 150_000,
}

/**
 * SIG-276 Phase 2: the write-time claim extractor. A cheap, single-shot classifier
 * (no retry, no fallback) over the final findings — fail-open by design, so a
 * capacity blip just yields no claims rather than burning the merge path.
 * SIG-406 alpha: on OpenRouter (`deepseek/deepseek-v4-flash`).
 */
export const CLAIM_EXTRACTOR_CONFIG: ModelConfig = {
  primary: "deepseek/deepseek-v4-flash",
  retries: 0,
  fallback: null,
}
/** Per-attempt cap for the claim extractor. Kept well under the
 *  specialist budget — the classifier prompt is small and the call is
 *  fail-open, so a slow model must not extend customer-visible latency. */
export const CLAIM_EXTRACTOR_TIMEOUT_MS = 25_000

/** @deprecated kept for telemetry compatibility — derive from SPECIALIST_CONFIGS instead */
export const SPECIALIST_MODELS: Record<SpecialistRole, string> = {
  logic: SPECIALIST_CONFIGS.logic.primary,
  security: SPECIALIST_CONFIGS.security.primary,
  performance: SPECIALIST_CONFIGS.performance.primary,
  tests: SPECIALIST_CONFIGS.tests.primary,
}
export const SYNTHESIZER_MODEL = SYNTHESIZER_CONFIG.primary

/**
 * SIG-417: the model lineup the cost projection prices, as typed domain data.
 * Returns ALL specialist primaries + the synth primary — a conservative
 * UPPER-BOUND lineup (the projection runs before routing finalizes, and an
 * over-estimate is the safe direction for a cost ceiling). The orchestrator
 * passes this into `packAndRoute` so the packing layer never imports these
 * adapter-owned configs.
 */
export function buildCostProjectionLineup(): CostProjectionLineup {
  return {
    specialistModels: [
      SPECIALIST_CONFIGS.logic.primary,
      SPECIALIST_CONFIGS.security.primary,
      SPECIALIST_CONFIGS.performance.primary,
      SPECIALIST_CONFIGS.tests.primary,
    ],
    synthModel: SYNTHESIZER_CONFIG.primary,
  }
}

// SIG-406: baseline fanout + synth reservation ONLY — 4 specialists ×
// maxAttempts(retries:1, fallback:null)=2 + 2×synth(2) = 12. The SIG-393 re-sweep +
// SIG-395 invariant-lens add-on phases make extra `runSpecialist` calls NOT counted
// here (unchanged from pre-alpha accounting; full add-on budgeting is SIG-369).
export const MAX_CALLS_PER_ENSEMBLE_RUN =
  maxAttempts(SPECIALIST_CONFIGS.logic) +
  maxAttempts(SPECIALIST_CONFIGS.security) +
  maxAttempts(SPECIALIST_CONFIGS.performance) +
  maxAttempts(SPECIALIST_CONFIGS.tests) +
  // ARC-278 (CR catch on PR #91): reserve TWO synth budgets — the retry path can
  // fire a second `runSynthesizer` call.
  2 * maxAttempts(SYNTHESIZER_CONFIG)

// ─── specialist runner ────────────────────────────────────────────────

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export interface SpecialistRunArgs {
  role: SpecialistRole
  /** SIG-405/406: the provider key set; runSpecialist picks the key matching the
   *  role's model by id-shape (OpenRouter id → openrouter key; `:cloud` → ollama). */
  apiKeys: ModelApiKeys
  systemPrompt: string
  initialMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  /** SIG-287: role's bounded reasoning level (from `flags.reasoningByRole`);
   *  undefined → `think:false`. Primary attempt only. */
  reasoning?: "high" | "medium" | "low"
  /**
   * ARC-283 Phase B1b: correlation context for emitting
   * `model-attempt-completed` per retry/fallback attempt. Threaded
   * through from the orchestrator's `perfCtx` so the per-attempt
   * event carries the same {owner, repo, prNumber, headSha} as the
   * surrounding `phase-completed` + `specialist-fanout-summary`
   * events for downstream correlation.
   */
  perfCtx: EnsembleRunCtx
  mcpTools?: {
    toolIds: McpToolId[]
  }
  /**
   * SIG-369(b): optional per-CALL model-config override. When present it
   * REPLACES `SPECIALIST_CONFIGS[role]` for this call (model + retry/fallback/
   * timeout knobs all come from the override); the API key is still selected by
   * the override's model-id shape, so an OpenRouter override stays on the
   * OpenRouter key. Used ONLY by the second-pass recall phases (invariant-lens,
   * resweep) to route their re-runs to a cheaper reasoner behind a default-off
   * flag. Absent → byte-identical to today (the role's shipped config). The
   * primary specialist fan-out never passes it.
   */
  modelOverride?: ModelConfig
  /**
   * SIG-369(b): optional per-attempt input-composition observer (logic role,
   * shadow mode only). Fired once per settled attempt with that attempt's
   * per-call input-token split + tool-loop stats, INSIDE the existing protected
   * `onAttempt` try/catch — so it inherits the fail-open guard and a telemetry
   * throw can never convert a valid verdict into a dropped specialist (Codex
   * sign-off A). Absent → byte-identical to today (no observation).
   */
  onInputComposition?: (info: {
    perCallInputTokens: Array<number | undefined>
    toolCallsMade: number
    toolResultTokens: number
  }) => void
}

export interface SpecialistRunResult {
  verdict: PrReviewVerdict | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  /** Which model actually produced the verdict (or last attempted on failure).
   *  Differs from SPECIALIST_MODELS[role] when fallback fired. */
  modelUsed: string
  /** Total model invocations across primary retries + fallback. */
  attemptsUsed: number
}

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export async function runSpecialist(args: SpecialistRunArgs): Promise<SpecialistRunResult> {
  const t0 = Date.now()
  // SIG-406: the role's OpenRouter config; the API key is picked by model-id shape
  // (a `:cloud` eval override → the Ollama key). Missing key → fail closed below
  // (the other provider's key is never substituted).
  // SIG-369(b): a per-call `modelOverride` (second-pass phases only) REPLACES the
  // role config; absent → byte-identical to the shipped role config. The key is
  // selected from `config` either way, so the override's model-id shape decides
  // the provider key (an OpenRouter override → the OpenRouter key, no leak).
  const config = args.modelOverride ?? SPECIALIST_CONFIGS[args.role]
  const apiKey = selectConfigApiKey(config, args.apiKeys)
  if (!apiKey) {
    return {
      verdict: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: config.primary,
      attemptsUsed: 0,
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialMessage },
  ]
  const specialistTools =
    args.mcpTools && args.mcpTools.toolIds.length > 0
      ? createSpecialistMcpTools({ toolIds: args.mcpTools.toolIds, reviewCorpus: args.initialMessage })
      : undefined
  return runWithRetryAndFallback({
    config,
    apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "specialist_did_not_parse",
    startedAt: t0,
    ...(specialistTools !== undefined ? { specialistTools } : {}),
    ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}), // SIG-287 (primary-attempt-only)
    // Keep the prod path explicit even though runWithRetryAndFallback also
    // defaults from config.perAttemptTimeoutMs. Shadow callers rely on the
    // shared default; prod keeps the override visible at the role boundary.
    ...(config.perAttemptTimeoutMs !== undefined ? { perAttemptTimeoutMs: config.perAttemptTimeoutMs } : {}),
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Bucket attempts into primary/retry/fallback by attemptIndex:
    //   1                  → primary
    //   2..(retries + 1)   → retry
    //   (retries + 2)      → fallback (only fires when config.fallback
    //                         is set; runWithRetryAndFallback skips it
    //                         when fallback is null).
    onAttempt: (info) => {
      try {
        const attemptKind =
          info.attemptIndex === 1 ? "primary" : info.attemptIndex <= config.retries + 1 ? "retry" : "fallback"
        const outcome = info.verdictOk
          ? "ok"
          : (info.failureReason ?? "").includes("timeout")
            ? "timeout"
            : (info.failureReason ?? "").toLowerCase().includes("abort")
              ? "aborted"
              : "failed"
        emitModelAttempt(args.perfCtx, {
          phase: "specialist",
          role: args.role,
          attemptKind,
          attemptIndex: info.attemptIndex,
          model: info.model,
          timeoutMs: info.timeoutMs,
          startedAtMs: info.startedAtMs,
          endedAtMs: info.endedAtMs,
          elapsedMs: info.endedAtMs - info.startedAtMs,
          outcome,
          ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
          // SIG-212: forward token usage from runWithRetryAndFallback.
          ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
          ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
          // SIG-417: forward the actual per-call cost on the attempt event.
          ...(info.costUsd !== undefined ? { costUsd: info.costUsd } : {}),
          ...(info.thinkingChars !== undefined ? { thinkingChars: info.thinkingChars } : {}), // SIG-287
        })
        // SIG-149: accumulate per-review token spend (every settled
        // attempt — incl. retries/fallback/parse-fail — burned tokens).
        // SIG-417: also accumulate the actual per-call cost (credits ≈ USD).
        args.perfCtx.recordTokens?.(info.model, info.inputTokens, info.outputTokens, info.costUsd)
        // SIG-369(b): feed the per-call input split + tool-loop stats to the
        // logic-input-composition recorder (shadow only; absent otherwise). In
        // this SAME protected block so it's fail-open. `perCallInputTokens` is
        // absent on the exception path (no call completed) — nothing to record.
        if (args.onInputComposition !== undefined && info.perCallInputTokens !== undefined) {
          args.onInputComposition({
            perCallInputTokens: info.perCallInputTokens,
            toolCallsMade: info.toolCallsMade ?? 0,
            toolResultTokens: info.toolResultTokens ?? 0,
          })
        }
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSpecialist` runs inside
        // Promise.allSettled — an uncaught throw here converts a valid
        // specialist verdict into a rejected entry, dropping coverage.
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(
          JSON.stringify({
            event: "model-attempt-emit-error",
            owner: args.perfCtx.owner,
            repo: args.perfCtx.repo,
            prNumber: args.perfCtx.prNumber,
            headSha: args.perfCtx.headSha.slice(0, 7),
            phase: "specialist",
            role: args.role,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    },
  })
}

/**
 * Run a chat call with retry + cross-provider fallback. Used by both
 * specialist and synthesizer paths to centralize the retry policy
 * (added post-shadow-mode telemetry; original v3.1 spec disabled
 * retries for cost reasons but capacity 503s on frontier models made
 * that untenable for the logic specialist specifically).
 *
 * Sequence:
 *   1. Try primary (attempt 1)
 *   2. If retryable failure (503/429/network/abort-not-from-orch, OR a parse
 *      failure) AND retries remaining → backoff + retry (attempts 2..N+1)
 *   3. If primary exhausted AND fallback configured → try fallback once
 *   4. Return final outcome (success OR last failure)
 *
 * SIG-438: a parse failure IS retried on the same model. It indicates a
 * (non-deterministic) output-format glitch, not a fixed property of the prompt —
 * a re-roll of the same model often parses (PR #574: the security specialist
 * parsed one pass and failed the next on identical input). Only the genuinely
 * unretryable failures break early (auth / 404 / 400 / missing-key / aborted) —
 * see `breaksSameModelRetry`. (Pre-SIG-406 parse failures broke to the
 * cross-provider fallback; `fallback: null` since SIG-406 left them no recovery,
 * so the same-model retry is now it.)
 */
export interface AttemptCallbackInfo {
  /** 1-indexed across the entire retry+fallback chain (primary
   *  attempt 1, retry attempts 2..N+1, fallback attempt N+2). */
  attemptIndex: number
  model: string
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  verdictOk: boolean
  /** Present when verdictOk=false. Same free-form string
   *  `runWithRetryAndFallback` returns as its top-level
   *  `failureReason` for the final outcome. */
  failureReason?: string
  /** SIG-212: token usage reported by the underlying `chat()` call.
   *  Present whenever the LLM round-trip completed (success OR parse-
   *  failure — the model still consumed tokens producing the unparseable
   *  output). Absent on exception paths (HTTP error, timeout, abort)
   *  where no tokens were exchanged. */
  inputTokens?: number
  outputTokens?: number
  /** SIG-417: actual per-call cost (credits ≈ USD) reported by `usage.cost`
   *  (OpenRouter only). Rides the same paths as the token counts — present on
   *  success + parse-failure, absent on exception paths and on providers
   *  (Ollama) that don't report it. */
  costUsd?: number
  /** SIG-287: cumulative thinking-char count for the attempt (length only,
   *  never the CoT text). Absent on the default-off `think:false` path. */
  thinkingChars?: number
  /** SIG-369(b): input tokens of EACH `chat()` call this attempt made, in
   *  order — single-shot is one entry (`[inputTokens]`), the tool conversation
   *  is two (`[toolTurn, final]`, the final re-sends everything). A `undefined`
   *  entry = that call's provider reported no usage (kept distinct from 0).
   *  Absent on the exception path (no call completed). Telemetry only. */
  perCallInputTokens?: Array<number | undefined>
  /** SIG-369(b): tool calls executed this attempt (tool conversation only; 0 /
   *  absent on the single-shot path). */
  toolCallsMade?: number
  /** SIG-369(b): estimated tokens of the tool-result block fed into the final
   *  tool-conversation call (tool path only; 0 / absent single-shot). */
  toolResultTokens?: number
}

export async function runWithRetryAndFallback<T>(args: {
  config: ModelConfig
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
  startedAt: number
  /**
   * Phase 4a.4 (ARC-175): per-attempt timeout cap. Each individual
   * `attemptChat` call aborts after this many ms so a single slow
   * primary can't eat the entire `SPECIALIST_TIMEOUT_MS` budget.
   * Defaults to `config.perAttemptTimeoutMs` when the role config provides
   * one, otherwise `PER_ATTEMPT_TIMEOUT_MS` (60s). Tests and special callers
   * may pass this field explicitly to override the config without mutating it.
   */
  perAttemptTimeoutMs?: number
  /** SIG-287: bounded reasoning level for the PRIMARY attempt(s) only — the
   *  cross-provider fallback omits it (Codex #5: keep the slow-model fallback,
   *  e.g. security's v4-pro, out of reasoning scope). Undefined → think:false. */
  reasoning?: "high" | "medium" | "low"
  /**
   * ARC-283 Phase B1b: optional per-attempt observer. Fires AFTER
   * each settled attempt (primary, retry, OR fallback), on BOTH
   * success and failure branches, BEFORE the next iteration. The
   * shadow runner uses this to emit `shadow-model-attempt-completed`;
   * the prod path uses it (wired in `runSpecialist`/`runSynthesizer`)
   * to emit `model-attempt-completed`.
   *
   * `runWithRetryAndFallback` itself does NOT wrap the callback in
   * try/catch — callers own that decision. The prod-path callers
   * (`runSpecialist`/`runSynthesizer`) DO wrap because their
   * runSpecialist/runSynthesizer call is inside `Promise.allSettled`
   * (or `attemptSynth`'s catch) where an emit-throw would silently
   * discard a valid verdict. The shadow runner deliberately leaves
   * its callback bare — shadow-mode telemetry failures should be
   * loud, not papered over.
   */
  onAttempt?: (info: AttemptCallbackInfo) => void
  specialistTools?: SpecialistRuntimeTool[]
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}> {
  const { config, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel, startedAt } = args
  const perAttemptCap = args.perAttemptTimeoutMs ?? config.perAttemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS

  let attemptsUsed = 0
  let lastFailureReason: string | undefined
  let lastFailureRaw: string | undefined

  // Try primary with retries
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) {
      return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
    }
    if (attempt > 0) {
      // Backoff before retry
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0
      await sleepWithSignal(delay, signal)
      if (signal.aborted) {
        return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
      }
    }
    attemptsUsed++
    // ARC-283 (B1b): mark per-attempt wall-clock start BEFORE the
    // composed-timeout wrapper so the onAttempt observer gets the
    // true span (including any time spent inside attemptChat's
    // setup, not just chat()'s round-trip).
    const attemptStartMs = Date.now()
    // Phase 4a.4: per-attempt cap. attemptChat already returns a
    // structured failure on AbortError (its inner try/catch catches
    // chat()'s thrown abort), so withComposedTimeout's grace path
    // observes a settled `{verdict: null, failureReason: ...}` and
    // returns it cleanly — no extra throw/catch needed here.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) =>
        attemptChat({
          model: config.primary,
          apiKey,
          messages,
          signal: perAttemptSignal,
          chatEnabled,
          format,
          parseAnswer,
          parseFailureLabel,
          ...(args.specialistTools !== undefined ? { specialistTools: args.specialistTools } : {}),
          ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}), // SIG-287: PRIMARY only (fallback omits)
        }),
      perAttemptCap,
      signal,
    )
    // ARC-283 (B1b): emit onAttempt on BOTH success and failure
    // branches of the primary/retry loop. Fires before the early
    // `return` below so the observer sees every settled call.
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: config.primary,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      // SIG-212: forward token usage from attemptChat. Present on
      // both success and parse-failure; absent on HTTP/timeout/abort.
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
      // SIG-417: forward the actual per-call cost alongside the token counts.
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.thinkingChars !== undefined ? { thinkingChars: outcome.thinkingChars } : {}), // SIG-287
      // SIG-369(b): forward the per-call input split + tool-loop stats so the
      // logic-input-composition recorder (wired via onInputComposition) can see
      // the tool-turn-vs-final doubling separately.
      ...(outcome.perCallInputTokens !== undefined ? { perCallInputTokens: outcome.perCallInputTokens } : {}),
      ...(outcome.toolCallsMade !== undefined ? { toolCallsMade: outcome.toolCallsMade } : {}),
      ...(outcome.toolResultTokens !== undefined ? { toolResultTokens: outcome.toolResultTokens } : {}),
    })
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, elapsedMs: Date.now() - startedAt, modelUsed: config.primary, attemptsUsed }
    }
    lastFailureReason = outcome.failureReason
    lastFailureRaw = outcome.failureRawAnswer
    // Failure classification (SIG-438):
    //
    //   Break-early (404 missing-model, 401/403 auth, 400 validation,
    //   missing_api_key, aborted) → a re-roll of the SAME model can't fix it.
    //   Still try the cross-provider fallback below (arc PR #37 catch): a 404
    //   on deepseek-v4-pro says nothing about whether the fallback exists —
    //   they're different providers entirely.
    //
    //   Retry the same model (5xx upstream-overload, 429 rate-limited, network
    //   errors, timeout, AND parse failures) → backoff helps the transient
    //   classes, and a parse failure is non-deterministic so a re-roll of the
    //   same model often parses. Pre-SIG-406 parse failures broke to the
    //   fallback ("a different model may format correctly"); with `fallback:
    //   null` the same-model retry is now their ONLY recovery (PR #574 dropped
    //   the security specialist this way). Fall back if all retries exhausted.
    if (breaksSameModelRetry(outcome.failureReason, parseFailureLabel)) {
      break
    }
  }

  // Primary exhausted (either retries used up on transient errors, OR
  // primary hit a permanent failure and broke early). In BOTH cases
  // try the cross-provider fallback before giving up — fallback runs
  // on different infra and may succeed where primary couldn't.
  if (config.fallback && !signal.aborted) {
    const fallbackModel = config.fallback
    attemptsUsed++
    // ARC-283 (B1b): mirror the primary-loop start mark so the
    // fallback attempt also gets a true wall-clock span on the
    // onAttempt observer.
    const attemptStartMs = Date.now()
    // Phase 4a.4: same per-attempt cap on the fallback. The fallback
    // gets one shot — capped — so even if the cross-provider model is
    // also slow, the overall specialist run finishes within budget.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) =>
        attemptChat({
          model: fallbackModel,
          apiKey,
          messages,
          signal: perAttemptSignal,
          chatEnabled,
          format,
          parseAnswer,
          parseFailureLabel,
          ...(args.specialistTools !== undefined ? { specialistTools: args.specialistTools } : {}),
        }),
      perAttemptCap,
      signal,
    )
    // ARC-283 (B1b): emit onAttempt for the fallback as well, on
    // BOTH success and failure branches.
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: fallbackModel,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      // SIG-212: forward token usage on the fallback path too.
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
      // SIG-417: forward the actual per-call cost on the fallback path too.
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.thinkingChars !== undefined ? { thinkingChars: outcome.thinkingChars } : {}), // SIG-287 (fallback: normally absent)
      // SIG-369(b): forward the per-call input split + tool-loop stats on the fallback too.
      ...(outcome.perCallInputTokens !== undefined ? { perCallInputTokens: outcome.perCallInputTokens } : {}),
      ...(outcome.toolCallsMade !== undefined ? { toolCallsMade: outcome.toolCallsMade } : {}),
      ...(outcome.toolResultTokens !== undefined ? { toolResultTokens: outcome.toolResultTokens } : {}),
    })
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, elapsedMs: Date.now() - startedAt, modelUsed: config.fallback, attemptsUsed }
    }
    // Fallback also failed. Use ITS failure as the reason (more recent + relevant).
    return wrapFailure(
      `fallback_failed: ${outcome.failureReason ?? "unknown"}`,
      outcome.failureRawAnswer,
      config.fallback,
      attemptsUsed,
      startedAt,
    )
  }

  return wrapFailure(
    lastFailureReason ?? "exhausted_no_fallback",
    lastFailureRaw,
    config.primary,
    attemptsUsed,
    startedAt,
  )
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  // CR + arc PR #37 catch: if the signal is already aborted on entry,
  // the abort event has already fired and our addEventListener will
  // never trigger — without this guard we'd sleep the full ms before
  // returning. Closes the race between caller's abort check + our
  // listener installation.
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// ─── synthesizer runner ───────────────────────────────────────────────

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble`,
 * `src/lib/shadow-bakeoff-runner.ts`, and (SIG-426) the CI-failure-triage
 * synth pass (`src/lib/ci-triage-synth-run.ts`) — an INTENTIONAL contract
 * expansion: the CI pass runs ONE grounded synth over a CI-evidence
 * `userMessage` (failed log + diff + named-file context) with the CI preamble,
 * so a CI-derived diagnosis inherits the same grounding/anchoring/dedup stack.
 */
export interface SynthesizerRunArgs {
  apiKey: string | undefined
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  /**
   * ARC-185: per-PR synthesizer config override sourced from
   * `commands.review.{model.primary, model.fallbacks}` in
   * `sigilix.json`. When undefined, the runner uses the
   * `SYNTHESIZER_CONFIG` constant (current default behavior).
   *
   * v1 limitation: `ModelConfig.fallback` is a single string; if
   * the user supplies multiple fallbacks, only the first is used at
   * the synth path. The user-facing API still accepts an array (so
   * the schema doesn't churn when we extend the runtime support)
   * but the runtime drops the tail. Telemetry records the count.
   */
  configOverride?: ModelConfig
  /**
   * ARC-283 Phase B1b: correlation context for emitting
   * `model-attempt-completed` per retry/fallback attempt. Same
   * shape + purpose as `SpecialistRunArgs.perfCtx`.
   */
  perfCtx: EnsembleRunCtx
  /**
   * SIG-392: flat source specialist findings ({id, path, line, headline}) used
   * to RECONSTRUCT provenance when the model emits a valid verdict but omits
   * the `provenance` block (gemma large-payload behavior). When provided and
   * the model's provenance is absent/invalid, the parse rebuilds it by
   * co-location instead of failing the whole synth to fallback. Omitted →
   * current strict behavior (invalid provenance → parse null → retry/fallback).
   */
  provenanceSources?: ReadonlyArray<ProvenanceSource>
}

interface SynthesizerRunOutput {
  verdict: PrReviewVerdict | null
  provenance: SynthesizerProvenance | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}

/**
 * Composite type the synth retry path emits — both verdict + provenance
 * are needed for a successful synth, so the runWithRetryAndFallback
 * helper treats this as the parsed-answer shape.
 */
interface SynthParsedOutput {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance
}

export function parseSynthAnswer(
  content: string,
  provenanceSources?: ReadonlyArray<ProvenanceSource>,
): SynthParsedOutput | null {
  // Expect `{verdict: PrReviewVerdict, provenance: {...}}`.
  const parsed = parseFirstJsonObject(content)
  if (!parsed) return null
  const verdict = parsePrReviewResponse(JSON.stringify(parsed.verdict))
  if (!verdict) return null
  if (isValidProvenance(parsed.provenance)) return { verdict, provenance: parsed.provenance }
  // SIG-392: the verdict parsed but provenance is absent/malformed (gemma drops
  // the block on large payloads). Rather than fail the whole synth to the
  // deepseek fallback, RECONSTRUCT provenance by co-locating each verdict
  // finding with its real source (recall- + precision-safe vs the
  // hallucination guard — unmatched findings get [] and are dropped exactly as
  // a hallucination would be). Only when sources are supplied; otherwise keep
  // the strict null so the retry/fallback ladder runs as before.
  if (provenanceSources && provenanceSources.length > 0) {
    const { provenance, matched, unmatched } = reconstructSynthProvenance(verdict.findings, provenanceSources)
    console.log(
      JSON.stringify({
        event: "pr-review-synth-provenance-reconstructed",
        verdictFindings: verdict.findings.length,
        matched,
        unmatchedDropped: unmatched,
      }),
    )
    return { verdict, provenance }
  }
  return null
}

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble`,
 * `src/lib/shadow-bakeoff-runner.ts`, and (SIG-426) the CI-failure-triage
 * synth pass (`src/lib/ci-triage-synth-run.ts`). The CI use is an INTENTIONAL
 * contract expansion — `runSynthesizer` is content-agnostic (specialist
 * verdicts only ever live inside `userMessage`), so a CI-evidence bundle works
 * with no shape change.
 */
export async function runSynthesizer(args: SynthesizerRunArgs): Promise<SynthesizerRunOutput> {
  const t0 = Date.now()
  const effectiveConfig: ModelConfig = args.configOverride ?? SYNTHESIZER_CONFIG
  if (!args.apiKey) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: effectiveConfig.primary,
      attemptsUsed: 0,
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]

  // No `format` arg here — synth output is `{verdict, provenance}` which
  // doesn't match PR_REVIEW_SCHEMA shape directly. Tolerated by
  // parseFirstJsonObject + post-validation.
  const outcome = await runWithRetryAndFallback<SynthParsedOutput>({
    config: effectiveConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: undefined,
    parseAnswer: (content: string) => parseSynthAnswer(content, args.provenanceSources),
    parseFailureLabel: "synth_failed_parse",
    startedAt: t0,
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Same attemptKind/outcome bucketing as the specialist path; role
    // is the literal "synth" string (matches the `ModelAttemptPhase`
    // type definition in `ensemble-perf-telemetry.ts`).
    onAttempt: (info) => {
      try {
        const attemptKind =
          info.attemptIndex === 1 ? "primary" : info.attemptIndex <= effectiveConfig.retries + 1 ? "retry" : "fallback"
        const outcomeLabel = info.verdictOk
          ? "ok"
          : (info.failureReason ?? "").includes("timeout")
            ? "timeout"
            : (info.failureReason ?? "").toLowerCase().includes("abort")
              ? "aborted"
              : "failed"
        emitModelAttempt(args.perfCtx, {
          phase: "synth",
          role: "synth",
          attemptKind,
          attemptIndex: info.attemptIndex,
          model: info.model,
          timeoutMs: info.timeoutMs,
          startedAtMs: info.startedAtMs,
          endedAtMs: info.endedAtMs,
          elapsedMs: info.endedAtMs - info.startedAtMs,
          outcome: outcomeLabel,
          ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
          // SIG-212: forward token usage on the synth path too.
          ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
          ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
          // SIG-417: forward the actual per-call cost on the synth path too.
          ...(info.costUsd !== undefined ? { costUsd: info.costUsd } : {}),
        })
        // SIG-149: accumulate synth token spend into the per-review total.
        // SIG-417: also accumulate the actual per-call cost (credits ≈ USD).
        args.perfCtx.recordTokens?.(info.model, info.inputTokens, info.outputTokens, info.costUsd)
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSynthesizer` is invoked
        // by `attemptSynth` in the orchestrator (which catches throws +
        // returns null → fires the ARC-278 retry → if THAT also throws,
        // synth_timeout skip-notice fires for a valid synth output).
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(
          JSON.stringify({
            event: "model-attempt-emit-error",
            owner: args.perfCtx.owner,
            repo: args.perfCtx.repo,
            prNumber: args.perfCtx.prNumber,
            headSha: args.perfCtx.headSha.slice(0, 7),
            phase: "synth",
            role: "synth",
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    },
  })

  if (outcome.verdict) {
    return {
      verdict: outcome.verdict.verdict,
      provenance: outcome.verdict.provenance,
      elapsedMs: outcome.elapsedMs,
      modelUsed: outcome.modelUsed,
      attemptsUsed: outcome.attemptsUsed,
    }
  }

  // Distinguish parse-vs-provenance failures in telemetry. parseSynthAnswer
  // returns null for either case, but we lose the distinction inside the
  // retry helper. Re-parse the raw answer here to label the failure
  // accurately (CR PR #35 catch — telemetry consumers need this split).
  // SIG-392: with `provenanceSources` supplied, the common "valid verdict /
  // omitted provenance" case is now INTERCEPTED by reconstruction (returns a
  // verdict → not a failure), so this `synth_invalid_provenance` label now
  // fires only when sources were empty or the verdict itself failed to parse —
  // expect it to trend toward zero in dashboards, not that it's broken.
  let failureReason = outcome.failureReason ?? "synth_failed_parse"
  if (outcome.failureRawAnswer) {
    const parsed = parseFirstJsonObject(outcome.failureRawAnswer)
    const hasVerdict = parsed && parsePrReviewResponse(JSON.stringify(parsed.verdict))
    if (hasVerdict && !isValidProvenance(parsed?.provenance)) {
      failureReason = "synth_invalid_provenance"
    }
  }

  const result: SynthesizerRunOutput = {
    verdict: null,
    provenance: null,
    elapsedMs: outcome.elapsedMs,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
  }
  if (failureReason) result.failureReason = failureReason
  if (outcome.failureRawAnswer) result.failureRawAnswer = outcome.failureRawAnswer
  return result
}
