// ARC-283 Phase B1b — shadow-mode runner. Wraps the existing
// `runWithRetryAndFallback` (exported from triage-pr-review-ensemble.ts)
// so the shadow path uses the SAME retry/fallback policy as prod,
// which is what makes the bake-off comparison apples-to-apples.
//
// Two entry points:
//   - `runShadowSpecialist` — for the four specialist roles. Parses
//     the prod PR_REVIEW_SCHEMA-shaped output and returns the
//     finding array directly (no role-specific post-processing —
//     that's prod's job and we explicitly don't want to mutate the
//     comparison surface).
//   - `runShadowSynth` — for the synth role. Parses the synth
//     `{verdict, provenance}` envelope; the comparison telemetry
//     only cares about `verdict.findings`.
//
// Both emit `shadow-model-attempt-completed` events per attempt
// through the `onAttempt` callback on `runWithRetryAndFallback`.
//
// SAFETY: shadow runners NEVER post to GitHub, NEVER mutate KV /
// queues / DO state. They are pure-observation: parse, log, return.

import {
  parseSynthAnswer,
  runWithRetryAndFallback,
  type ModelConfig,
  type ChatMessage,
} from "./triage-pr-review-ensemble"
import { parsePrReviewResponse } from "./triage-pr-review"
import { PR_REVIEW_SCHEMA } from "./schemas"
import {
  emitShadowAttempt,
  type ShadowAttemptKind,
  type ShadowAttemptOutcome,
  type FindingForOverlap,
} from "./shadow-bakeoff-telemetry"
import type { EnsembleRunCtx } from "./ensemble-perf-telemetry"

export interface ShadowRunResult {
  /** True when shadow produced a parseable verdict on some attempt. */
  verdictOk: boolean
  /** Final model that produced the verdict (or the one that failed
   *  last when shadow bailed). */
  modelUsed: string
  /** Total attempts across primary retries + fallback. */
  attemptsUsed: number
  /** Findings extracted for comparison telemetry. Empty on failure. */
  findings: readonly FindingForOverlap[]
  /**
   * Full finding text (headline/body) for the SAME findings — diagnostics only
   * (e.g. the subtle-logic recall ruler triaging why a model over-fired). The
   * comparison telemetry path ignores this; prod callers never read it. Optional
   * + additive so this is non-breaking.
   */
  rawFindings?: ReadonlyArray<{
    path: string
    line: number
    score: number
    category: string
    headline: string
    body: string
    cweId?: string
    evidenceId?: string
    independentAssessment?: string
  }>
  /** Wall-clock elapsed (start → finalize). */
  elapsedMs: number
  /** Failure reason from runWithRetryAndFallback, or undefined on success. */
  failureReason?: string
}

export interface SpecialistShadowArgs {
  role: "logic" | "security" | "performance" | "tests"
  shadowConfig: ModelConfig
  apiKey: string
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  perfCtx: EnsembleRunCtx
}

export interface SynthShadowArgs {
  shadowConfig: ModelConfig
  apiKey: string
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  perfCtx: EnsembleRunCtx
}

function attemptIndexToKind(i: number, retries: number): ShadowAttemptKind {
  if (i === 1) return "primary"
  if (i <= retries + 1) return "retry"
  return "fallback"
}

function classifyOutcome(verdictOk: boolean, failureReason: string | undefined): ShadowAttemptOutcome {
  if (verdictOk) return "ok"
  const r = failureReason ?? ""
  if (r.includes("timeout") || r.includes("per_attempt")) return "timeout"
  if (r.toLowerCase().includes("abort")) return "aborted"
  return "failed"
}

export async function runShadowSpecialist(args: SpecialistShadowArgs): Promise<ShadowRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "missing_api_key",
    }
  }
  if (args.signal.aborted) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "aborted_before_start",
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]
  const outcome = await runWithRetryAndFallback({
    config: args.shadowConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    // ARC-283 Phase B1b review pass: shadow specialists MUST pass the
    // same structured-output schema as prod (see runSpecialist in
    // triage-pr-review-ensemble.ts). Without it, candidate models run
    // free-form while prod runs constrained — parse-failure rate,
    // latency, and output shape get skewed, and the bake-off
    // comparison stops being apples-to-apples.
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "shadow_specialist_did_not_parse",
    startedAt: t0,
    onAttempt: (info) => {
      emitShadowAttempt(args.perfCtx, {
        role: args.role,
        attemptKind: attemptIndexToKind(info.attemptIndex, args.shadowConfig.retries),
        attemptIndex: info.attemptIndex,
        model: info.model,
        timeoutMs: info.timeoutMs,
        startedAtMs: info.startedAtMs,
        endedAtMs: info.endedAtMs,
        elapsedMs: info.endedAtMs - info.startedAtMs,
        outcome: classifyOutcome(info.verdictOk, info.failureReason),
        ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
        // SIG-212: forward token usage to the shadow event so analyzers
        // can join prod + shadow attempts on the same correlation tuple
        // AND aggregate token cost across both paths.
        ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
        ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
      })
    },
  })
  const verdictOk = outcome.verdict !== null
  return {
    verdictOk,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
    findings: verdictOk
      ? outcome.verdict!.findings.map((f) => ({
          path: f.path,
          line: f.line,
          category: f.category,
          score: f.score,
        }))
      : [],
    rawFindings: verdictOk
      ? outcome.verdict!.findings.map((f) => ({
          path: f.path,
          line: f.line,
          score: f.score,
          category: f.category,
          headline: f.headline ?? "",
          body: f.body ?? "",
          ...(f.cweId !== undefined ? { cweId: f.cweId } : {}),
          ...(f.evidenceId !== undefined ? { evidenceId: f.evidenceId } : {}),
          ...(f.independentAssessment !== undefined ? { independentAssessment: f.independentAssessment } : {}),
        }))
      : [],
    elapsedMs: outcome.elapsedMs,
    ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
  }
}

export async function runShadowSynth(args: SynthShadowArgs): Promise<ShadowRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "missing_api_key",
    }
  }
  if (args.signal.aborted) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "aborted_before_start",
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]
  const outcome = await runWithRetryAndFallback({
    config: args.shadowConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    // Synth uses the `{verdict, provenance}` envelope which doesn't
    // match PR_REVIEW_SCHEMA — prod's `runSynthesizer` also passes
    // `format: undefined` for the same reason. Apples-to-apples here
    // means BOTH paths run free-form, so leave this as-is.
    format: undefined,
    parseAnswer: parseSynthAnswer,
    parseFailureLabel: "shadow_synth_did_not_parse",
    startedAt: t0,
    onAttempt: (info) => {
      emitShadowAttempt(args.perfCtx, {
        role: "synth",
        attemptKind: attemptIndexToKind(info.attemptIndex, args.shadowConfig.retries),
        attemptIndex: info.attemptIndex,
        model: info.model,
        timeoutMs: info.timeoutMs,
        startedAtMs: info.startedAtMs,
        endedAtMs: info.endedAtMs,
        elapsedMs: info.endedAtMs - info.startedAtMs,
        outcome: classifyOutcome(info.verdictOk, info.failureReason),
        ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
        // SIG-212: forward token usage on the shadow synth path too.
        ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
        ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
      })
    },
  })
  const verdictOk = outcome.verdict !== null
  return {
    verdictOk,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
    findings: verdictOk
      ? outcome.verdict!.verdict.findings.map((f) => ({
          path: f.path,
          line: f.line,
          category: f.category,
          score: f.score,
        }))
      : [],
    elapsedMs: outcome.elapsedMs,
    ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
  }
}
