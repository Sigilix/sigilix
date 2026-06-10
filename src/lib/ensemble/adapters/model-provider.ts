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

import { chat } from "@/src/shared/adapters/model"
import type { ChatMessage } from "@/src/shared/ports/model"
import { type ModelConfig, RETRY_BACKOFF_MS, maxAttempts } from "@/src/lib/ensemble/domain/model-policy"
import { PER_ATTEMPT_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
// SIG-386 (PR1): the pure `isPermanentFailure` classifier moved to a sibling
// leaf to land this adapter at <=1k lines. Re-exported below so the public
// surface (and the importers + vi.mock paths pinned to this module) are
// unchanged; also consumed internally by `runWithRetryAndFallback`.
import { isPermanentFailure } from "./model-provider-internals"
export { isPermanentFailure } from "./model-provider-internals"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
// ─── documented laterals (frozen in this pure-move PR; ADR / Tier-1 tracked) ──
import { emitModelAttempt, type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { withComposedTimeout } from "@/src/lib/agent-loop"
import { parsePrReviewResponse } from "@/src/lib/triage-pr-review"

/**
 * Per-role model lineup with retry/fallback config (v3.1 LOCKED spec
 * amendment, post-shadow-mode telemetry from PR #35-36 dogfooding).
 *
 * Initial v3.1 lineup had two real bugs:
 *   - `qwen3-coder:30b:cloud` was a phantom — Ollama Turbo's tag list
 *     doesn't include a 30B variant on cloud (verified via /api/tags).
 *     Security + tests specialists 404'd on every call.
 *   - `deepseek-v4-pro:cloud` is the latest reasoning model, capacity-
 *     constrained on Ollama Turbo's underlying provider; routinely
 *     returns 503 under demand spikes. With specialist retries
 *     disabled per original spec, that = silent specialist failure
 *     and quorum loss.
 *
 * After dual sign-off (Codex + Kimi K2.6) the lineup is now:
 *   - Same primary models where they were working (logic, perf, synth)
 *   - Replaced phantom qwen3-coder:30b → deepseek-v4-flash for
 *     security + tests (known-working family member, predictable cost)
 *   - Cross-provider fallbacks per role (true uncorrelated resilience —
 *     Kimi-B's argument: same-family fallback fails when the upstream
 *     provider has an outage, defeating the fallback's purpose)
 *   - Retries enabled per-role, sized by criticality (logic gets 2,
 *     others 1, synth 1; user constraint "logic cannot fail").
 */
export const SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  // SIG-234 lineup swap (2026-05-26): all 5 specialist + synth roles
  // now use UNIQUE primary models per the founder's 4+1 constraint.
  // Driven by Codex's ARC-292 lineup proposal + Ollama-format-
  // compatibility validation (curl-tested each candidate with a
  // JSON-schema-constrained prompt; `mistral-large-3:675b-cloud`,
  // `glm-4.6:cloud`, and `deepseek-v3.1:671b-cloud` ALL wrap output
  // in ```json``` markdown fences and are NOT used). The slow logic
  // primary (deepseek-v4-pro:cloud at 100-270s) is demoted to
  // security fallback — kept reachable for its reasoning capability
  // without anchoring wall-time.
  logic: {
    // 2026-06-05 — SWAPPED BACK to `deepseek-v4-pro:cloud` from
    // `deepseek-v4-flash:cloud`. The original demotion reason (100-270s
    // latency) is VOID: that was the unbounded-CoT stall, which the SIG-287
    // `think:false` fix already cured — with `think:false`, v4-pro returns
    // structured output in ~6-12s on Turbo (curl-probed + live eval), same
    // ballpark as flash, well within the budget invariant below. The subtle-
    // logic recall ruler (tests/logic-recall-eval.live.test.ts, K=12 real-path)
    // shows v4-pro + the FP-discipline prompt in this PR at recall 93% / FP 25%
    // vs flash-tuned 86% / 31% — better on BOTH axes, and the only config that
    // beats Greptile's recall (82%) while matching CodeRabbit's precision floor
    // (~75%). v4-pro keeps the V4 reasoning lineage + 1M context.
    primary: "deepseek-v4-pro:cloud",
    // 2026-05-26 Codex/measurement: production telemetry on PR #188
    // showed deepseek-v4-flash + kimi-k2.5 (the prior fallback) BOTH
    // hit exactly 60_000ms (PER_ATTEMPT_TIMEOUT_MS) on every review.
    // The retry/fallback ladder was 100% waste — 180s burned, logic
    // verdict never returned, customer got `[DEGRADED COVERAGE]` either
    // way. Codex diagnostic: logic's prompt shape (full retrieval +
    // graph + symbol context) is uniquely expensive; the issue is
    // prompt-driven, not model-driven, so swapping fallbacks alone
    // wouldn't help.
    //
    // #188 tactical fix `retries:0`+`fallback:null` capped logic at 60s
    // (vs 180s), but the ROOT CAUSE was never the ladder — it's that the
    // 60s PER-ATTEMPT cap is too small for logic's prompt. SIG-287 added a
    // trim, but it CANNOT reach the 6000-tok cap: the mandatory floor
    // (diff+graph+deterministic+system+meta+rules+schema) is ~8.4k tok even
    // on a small PR. Live #241 telemetry: model-attempt-completed
    // elapsedMs=60000 outcome=aborted — logic was STILL generating at the
    // cap on EVERY review → "logic specialist unavailable" banner for weeks.
    //
    // SIG-287 TRUE ROOT CAUSE (2026-05-30, telemetry + Ollama API docs +
    // DeepSeek-v4-pro, all concurring): the timeout was NEVER the lever. The
    // 60→110→240→360s bumps ALL failed for the same reason — `generate`/
    // `ollamaChat` omitted `think:false`, so deepseek-v4-flash (a REASONING
    // model) ran an unbounded chain-of-thought in a separate `thinking` field
    // (which the stream reader ignores), emitting ZERO `response` tokens until
    // the per-attempt cap aborted it. Live #251 telemetry: timeoutMs:360000
    // elapsedMs:360000 outcome:aborted with NO outputTokens — a flash model
    // producing nothing in 6 min = a stuck reasoning phase, not slow
    // generation. THE FIX (ollama.ts/ollama-chat.ts): set `think:false` on
    // schema-constrained calls so the model emits the structured answer
    // directly — logic now finishes in seconds like every other role.
    //
    // RESILIENCE (founder-chosen fast-fallback, 2026-05-30): with think:false
    // logic is fast, so drop the per-attempt cap 360→120s (still 2× the
    // expected <60s, covers route variance) and ADD a cross-provider fallback
    // (was null) so ANY future stall — route outage, capacity dip — fails fast
    // and the fallback rescues, exactly like the tests role (primary abort →
    // retry/fallback ok). qwen3-coder-next:cloud (Codex pick): cross-provider
    // from DeepSeek (fails independently — the point of a fallback), proven
    // fast in the same #251 telemetry that exposed the stall (it's security's
    // primary, returned in 7.4s), code-analysis-capable, and think:false
    // applies to it too. NOT deepseek-v4-pro (same family as the failing
    // primary + the slow reasoner — the wrong rescue for a stall). Chain:
    // primary 120s + fallback 120s = ~240s ≤ SPECIALIST_TIMEOUT_MS(370s, 130s
    // slack); the budget invariant (370+325+195 ≤ 895) is unchanged. NOTE:
    // logic can now make 2 model calls (primary + fallback), so
    // MAX_CALLS_PER_ENSEMBLE_RUN rose 16→17. VERIFY reliability across MULTIPLE
    // post-deploy reviews (outcome:ok + real outputTokens + elapsedMs well
    // under cap) before declaring SIG-287 fixed.
    retries: 0,
    fallback: "qwen3-coder-next:cloud",
    perAttemptTimeoutMs: 120_000,
  },
  security: {
    // REVERTED from qwen3-coder-next (a coder model) to a REASONING model
    // after the pr/07 benchmark regression. The SIG-234 premise —
    // "vulnerability patterns are mostly syntax/dataflow recognition, not
    // frontier reasoning" — holds for INJECTION but FAILS for AUTHORIZATION:
    // IDOR / BOLA / broken access control are reasoning ("should this caller
    // reach this resource?"), not pattern matching. On an IDOR-heavy benchmark
    // the coder model produced ZERO authz findings (only the two obvious
    // injections); raw pre-gate KV telemetry confirmed they were NEVER
    // generated (not gate-dropped). In a controlled re-test on the exact diff,
    // deepseek-v4-flash (the logic primary, a FAST reasoner) caught all of
    // them. Deliberately the SAME model as logic — recall beats the
    // 4+1-unique-primaries nicety, and v4-flash is proven in-budget on the hot
    // path (deepseek-v4-pro is too slow for a critical-path primary; it stays
    // on the fallback as the deeper authz backup).
    primary: "deepseek-v4-flash:cloud",
    retries: 1,
    fallback: "deepseek-v4-pro:cloud",
  },
  performance: {
    // Phase 4a.1: glm-5.1 promoted from fallback → primary.
    // Shadow telemetry: glm-5.1 won 6/12 fallback runs, minimax was unreliable.
    //
    // ARC-167 spot-check (2026-05-12): swap ratified on a 41-run sample
    // pulled from production KV. glm-5.1 hits 100% success (26/26) vs
    // minimax-m2.1's 80% (12/15 with 3 timeouts). Findings depth holds
    // up — glm-5.1 averages 1.08 findings/verdict (vs 0.92), with 18%
    // longer body text per finding. The latency tradeoff is real
    // (glm-5.1 p95 = 144s) but well under the 250s specialist budget
    // (SIG-287). Full analysis in
    // `.claude/research/arc-167/_report.md`.
    primary: "glm-5.1:cloud",
    retries: 1,
    // Cross-provider fallback retained — kimi-k2.5 same family as
    // logic's fallback so we know it's reachable.
    fallback: "kimi-k2.5:cloud",
  },
  tests: {
    // SIG-349: deepseek-v4-flash becomes the tests primary after the
    // tests-overfire ruler showed the tuned prompt + deterministic citation gate
    // beating the MiniMax M3 baseline on post-gate recall/precision/FP while
    // returning in seconds instead of ~70s/call. It deliberately shares the
    // security primary: tests-lane believability + runtime beats model-diversity
    // neatness here, and the tests prompt/gate keeps security/perf duplicates
    // from surfacing customer-visible testing findings.
    primary: "deepseek-v4-flash:cloud",
    // Keep MiniMax M3 as the cross-provider fallback, not a same-model retry.
    // V4 Flash is fast but has occasional schema parse failures on testing
    // evidence prompts; fallback routes those failures to the known tests-lane
    // baseline instead of dropping coverage. A retry on the same model would
    // usually cost less than MiniMax, but the existing runner treats parse
    // failures as permanent, so the fallback is the reliable rescue path today.
    retries: 0,
    fallback: "minimax-m3:cloud",
    // 160s keeps V4 Flash + MiniMax fallback at 320s, leaving 50s of the 370s
    // specialist wall for orchestration overhead. Healthy V4 Flash attempts are
    // far below this; the cap exists so MiniMax fallback has its old budget.
    perAttemptTimeoutMs: 160_000,
  },
}

export const SYNTHESIZER_CONFIG: ModelConfig = {
  // SIG-234 lineup swap (2026-05-26): synth primary moves to
  // `gpt-oss:120b-cloud` — open-weight, medium-usage, removes
  // Moonshot from the customer-visible critical merge path entirely.
  // Format-tested clean (1.3s on a small prompt; expected 25-75s on
  // a 4-verdict synth payload). Codex's HIGHEST-priority swap per
  // ARC-292: "Moonshot capacity dip burned 6m16s on PR #97."
  primary: "gpt-oss:120b-cloud",
  retries: 1,
  // ARC-291 (PR #97 hot-fix): swap fallback from kimi-k2.5 → DeepSeek
  // family. Pre-this-fix the fallback was kimi-k2.5:cloud — SAME
  // PROVIDER as primary (both Moonshot). When Moonshot had a bad few
  // minutes, primary + retry + fallback all hit the same wall, the
  // ARC-278 retry doubled the burn, and synth_timeout fired even
  // though specialist verdicts were ready to merge.
  //
  // Sigilix's own review of PR #97 demoed this: 6m 16s wall-clock
  // burned, both attemptSynth calls timed out twice, customer saw
  // "Couldn't review — see PR comment." Brand-fatal UX.
  //
  // Every OTHER ModelConfig in this file has cross-provider
  // fallback. Synth was the only outlier. DeepSeek-v4-flash is the
  // proven lighter DeepSeek variant (already primary on security +
  // tests specialists). DIFFERENT provider from Moonshot — fails
  // INDEPENDENTLY, which is the whole point of fallback.
  //
  // Worst-case math with cross-provider fallback:
  //   Primary attempt:  60s (PER_ATTEMPT cap)  — Moonshot slow → null
  //   Retry attempt:    60s + 1s backoff       — Moonshot slow → null
  //   Fallback attempt: 60s                    — DeepSeek likely OK
  //   Total:           ~121s if Moonshot is slow but DeepSeek is fine
  // vs the pre-fix:
  //   Total:           ~362s (180s × 2 outer attempts) → skip-notice
  fallback: "deepseek-v4-flash:cloud",
}

/**
 * SIG-276 Phase 2: the write-time claim extractor. A cheap, single-shot
 * classifier (no retry, no fallback) over the final findings — fail-open
 * by design, so a capacity blip just yields no claims rather than burning
 * the merge path. `deepseek-v4-flash:cloud` matches the logic specialist's
 * proven format-clean primary.
 */
export const CLAIM_EXTRACTOR_CONFIG: ModelConfig = {
  primary: "deepseek-v4-flash:cloud",
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

export const MAX_CALLS_PER_ENSEMBLE_RUN = (
  maxAttempts(SPECIALIST_CONFIGS.logic)
  + maxAttempts(SPECIALIST_CONFIGS.security)
  + maxAttempts(SPECIALIST_CONFIGS.performance)
  + maxAttempts(SPECIALIST_CONFIGS.tests)
  // ARC-278 (CR catch on PR #91): reserve TWO synth budgets, not
  // one. The retry path can fire a second `runSynthesizer` call
  // (itself primary + retry + cross-provider fallback). Without
  // this, a worst-case PR can spend up to N + maxAttempts(SYNTH)
  // extra and overshoot the daily cap.
  + (2 * maxAttempts(SYNTHESIZER_CONFIG))
)

// ─── specialist runner ────────────────────────────────────────────────

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export interface SpecialistRunArgs {
  role: SpecialistRole
  apiKey: string | undefined
  systemPrompt: string
  initialMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  /**
   * ARC-283 Phase B1b: correlation context for emitting
   * `model-attempt-completed` per retry/fallback attempt. Threaded
   * through from the orchestrator's `perfCtx` so the per-attempt
   * event carries the same {owner, repo, prNumber, headSha} as the
   * surrounding `phase-completed` + `specialist-fanout-summary`
   * events for downstream correlation.
   */
  perfCtx: EnsembleRunCtx
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
  if (!args.apiKey) {
    return {
      verdict: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: SPECIALIST_CONFIGS[args.role].primary,
      attemptsUsed: 0,
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialMessage },
  ]
  const config = SPECIALIST_CONFIGS[args.role]
  return runWithRetryAndFallback({
    config,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "specialist_did_not_parse",
    startedAt: t0,
    // Keep the prod path explicit even though runWithRetryAndFallback also
    // defaults from config.perAttemptTimeoutMs. Shadow callers rely on the
    // shared default; prod keeps the override visible at the role boundary.
    ...(config.perAttemptTimeoutMs !== undefined
      ? { perAttemptTimeoutMs: config.perAttemptTimeoutMs }
      : {}),
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Bucket attempts into primary/retry/fallback by attemptIndex:
    //   1                  → primary
    //   2..(retries + 1)   → retry
    //   (retries + 2)      → fallback (only fires when config.fallback
    //                         is set; runWithRetryAndFallback skips it
    //                         when fallback is null).
    onAttempt: (info) => {
      try {
        const attemptKind = info.attemptIndex === 1
          ? "primary"
          : info.attemptIndex <= config.retries + 1
            ? "retry"
            : "fallback"
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
        })
        // SIG-149: accumulate per-review token spend (every settled
        // attempt — incl. retries/fallback/parse-fail — burned tokens).
        args.perfCtx.recordTokens?.(info.model, info.inputTokens, info.outputTokens)
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSpecialist` runs inside
        // Promise.allSettled — an uncaught throw here converts a valid
        // specialist verdict into a rejected entry, dropping coverage.
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(JSON.stringify({
          event: "model-attempt-emit-error",
          owner: args.perfCtx.owner,
          repo: args.perfCtx.repo,
          prNumber: args.perfCtx.prNumber,
          headSha: args.perfCtx.headSha.slice(0, 7),
          phase: "specialist",
          role: args.role,
          message: err instanceof Error ? err.message : String(err),
        }))
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
 *   2. If retryable failure (503/429/network/abort-not-from-orch) AND
 *      retries remaining → backoff + retry (attempts 2..N+1)
 *   3. If primary exhausted AND fallback configured → try fallback once
 *   4. Return final outcome (success OR last failure)
 *
 * Parse failures are NOT retried — they indicate a model output
 * problem, not a capacity problem; retrying the same prompt at
 * temperature 0 will yield the same bad output.
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
      (perAttemptSignal) => attemptChat({
        model: config.primary, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
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
    })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.primary,
        attemptsUsed,
      }
    }
    lastFailureReason = outcome.failureReason
    lastFailureRaw = outcome.failureRawAnswer
    // Failure classification:
    //
    //   Permanent (404 missing-model, 401/403 auth, 400 validation,
    //   parse failure) → don't retry primary (same prompt → same error).
    //   But DO try the cross-provider fallback (arc PR #37 catch): a
    //   404 on deepseek-v4-pro says nothing about whether kimi-k2.5
    //   exists — they're different providers entirely. Same for parse
    //   failures: a different model may format output correctly. So
    //   `break` out of the retry loop to skip ahead to fallback.
    //
    //   Transient (5xx upstream-overload, 429 rate-limited, network
    //   errors, timeout) → keep retrying primary; backoff helps. Fall
    //   back if all retries exhausted.
    if (isPermanentFailure(outcome.failureReason, parseFailureLabel)) {
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
      (perAttemptSignal) => attemptChat({
        model: fallbackModel, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
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
    })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.fallback,
        attemptsUsed,
      }
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

  return wrapFailure(lastFailureReason ?? "exhausted_no_fallback", lastFailureRaw, config.primary, attemptsUsed, startedAt)
}

function wrapFailure<T>(
  reason: string,
  rawAnswer: string | undefined,
  modelUsed: string,
  attemptsUsed: number,
  startedAt: number,
): {
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
} {
  const out: ReturnType<typeof wrapFailure<T>> = {
    verdict: null,
    elapsedMs: Date.now() - startedAt,
    modelUsed,
    attemptsUsed,
  }
  if (reason) out.failureReason = reason
  if (rawAnswer) out.failureRawAnswer = rawAnswer
  return out
}

async function attemptChat<T>(args: {
  model: string
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  // SIG-212: usage is present on BOTH success and parse-failure paths
  // (chat() round-trip completed, model consumed tokens producing the
  // output — even if that output didn't parse). Absent on the
  // exception path where no tokens were exchanged.
  inputTokens?: number
  outputTokens?: number
}> {
  try {
    const result = await chat({
      model: args.model,
      messages: args.messages,
      apiKey: args.apiKey,
      signal: args.signal,
      chatEnabled: args.chatEnabled,
      ...(args.format ? { format: args.format } : {}),
      temperature: 0,
    })
    // SIG-212: capture token usage from chat()'s result. Forward on
    // BOTH success and parse-failure paths so cost telemetry stays
    // accurate even when the model produced unparseable output.
    // `usage` is optional on ChatResult to keep test mocks lightweight;
    // the production accumulator always returns `usage: {...}`.
    const usagePayload: { inputTokens?: number; outputTokens?: number } = {}
    if (result.usage?.inputTokens !== undefined) usagePayload.inputTokens = result.usage.inputTokens
    if (result.usage?.outputTokens !== undefined) usagePayload.outputTokens = result.usage.outputTokens
    const verdict = args.parseAnswer(result.message.content)
    if (!verdict) {
      return {
        verdict: null,
        failureReason: args.parseFailureLabel,
        failureRawAnswer: result.message.content.slice(0, 32_000),
        ...usagePayload,
      }
    }
    return { verdict, ...usagePayload }
  } catch (e) {
    return {
      verdict: null,
      failureReason: e instanceof Error ? e.message : String(e),
    }
  }
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
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
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

export function parseSynthAnswer(content: string): SynthParsedOutput | null {
  // Expect `{verdict: PrReviewVerdict, provenance: {...}}`.
  const parsed = parseFirstJsonObject(content)
  if (!parsed) return null
  const verdict = parsePrReviewResponse(JSON.stringify(parsed.verdict))
  if (!verdict) return null
  if (!isValidProvenance(parsed.provenance)) return null
  return { verdict, provenance: parsed.provenance }
}

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
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
    parseAnswer: parseSynthAnswer,
    parseFailureLabel: "synth_failed_parse",
    startedAt: t0,
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Same attemptKind/outcome bucketing as the specialist path; role
    // is the literal "synth" string (matches the `ModelAttemptPhase`
    // type definition in `ensemble-perf-telemetry.ts`).
    onAttempt: (info) => {
      try {
        const attemptKind = info.attemptIndex === 1
          ? "primary"
          : info.attemptIndex <= effectiveConfig.retries + 1
            ? "retry"
            : "fallback"
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
        })
        // SIG-149: accumulate synth token spend into the per-review total.
        args.perfCtx.recordTokens?.(info.model, info.inputTokens, info.outputTokens)
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSynthesizer` is invoked
        // by `attemptSynth` in the orchestrator (which catches throws +
        // returns null → fires the ARC-278 retry → if THAT also throws,
        // synth_timeout skip-notice fires for a valid synth output).
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(JSON.stringify({
          event: "model-attempt-emit-error",
          owner: args.perfCtx.owner,
          repo: args.perfCtx.repo,
          prNumber: args.perfCtx.prNumber,
          headSha: args.perfCtx.headSha.slice(0, 7),
          phase: "synth",
          role: "synth",
          message: err instanceof Error ? err.message : String(err),
        }))
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

function isValidProvenance(value: unknown): value is SynthesizerProvenance {
  // CR PR #35 catch: tighten shape check beyond "are findings + dropped
  // arrays?" — without this, a payload like `{findings:[{}], dropped:[]}`
  // passes and validateForSubmission then crashes
  // on `provenance.findings[i].sourceFindingIds.length` (undefined).
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.findings) || !Array.isArray(v.dropped)) {
    return false
  }
  // Each provenance.findings[i] must have an array sourceFindingIds.
  // The hallucination guard in validateForSubmission relies on this.
  for (const f of v.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false
    const entry = f as Record<string, unknown>
    if (!Array.isArray(entry.sourceFindingIds)) return false
    if (!entry.sourceFindingIds.every((id) => typeof id === "string")) return false
  }
  // dropped entries are looser — they're informational only and never
  // dereferenced into the customer-facing verdict, but still validate
  // for shape stability.
  for (const d of v.dropped) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false
  }
  // ARC-189: `softened` is OPTIONAL on the wire (synth outputs from
  // pre-v2 prompts omit it). When present, must be an array of
  // object-shaped entries. The renderer dereferences
  // `softened[i].sourceFindingId` to look up the corresponding
  // finding for score-decrement, so we tighten the per-item check
  // to require a string-shaped sourceFindingId — same belt-and-
  // suspenders pattern as the findings.sourceFindingIds[] guard.
  if (v.softened !== undefined) {
    if (!Array.isArray(v.softened)) return false
    for (const s of v.softened) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false
      const entry = s as Record<string, unknown>
      if (typeof entry.sourceFindingId !== "string") return false
    }
  }
  return true
}
