// SIG-318 (PR 8) / SIG-386 — model-provider adapter INTERNALS (PR1 marginal trim).
//
// `isPermanentFailure` is a pure, dependency-free failure-classification helper
// lifted verbatim out of `./model-provider.ts` to land that file at <=1k lines.
// Relocation only: the body is byte-identical (modulo the leading `export`,
// which it already carried). `model-provider.ts` re-exports it so its 16-export
// surface and the `vi.mock` test paths pinned to it are unchanged.

import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"

/** The settled-failure shape `runWithRetryAndFallback` returns (verdict null +
 *  the surrounding telemetry). Generic over the parsed-answer type so the
 *  specialist (`PrReviewVerdict`) and synth (`SynthParsedOutput`) paths share it. */
export interface RetryFailureResult<T> {
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
  /** SIG-455 (PR B Task 5): max Retry-After ms seen across all attempts; absent when no 429. */
  providerRateLimitMs?: number
}

// SIG-287: relocated from model-provider.ts to keep that adapter <=1k lines
// (the SIG-386 pattern). Pure failure-wrapper; body byte-identical to the
// private helper it replaces. `model-provider.ts` imports it.
export function wrapFailure<T>(
  reason: string,
  rawAnswer: string | undefined,
  modelUsed: string,
  attemptsUsed: number,
  startedAt: number,
): RetryFailureResult<T> {
  const out: RetryFailureResult<T> = {
    verdict: null,
    elapsedMs: Date.now() - startedAt,
    modelUsed,
    attemptsUsed,
  }
  if (reason) out.failureReason = reason
  if (rawAnswer) out.failureRawAnswer = rawAnswer
  return out
}

// Bedrock-ensemble migration: relocated VERBATIM from model-provider.ts to keep
// that adapter <=1k lines (the SIG-386 spill-sibling pattern — same as
// `wrapFailure` above). Pure abort-aware sleep; only `runWithRetryAndFallback`
// calls it.
export async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * Classify a failure reason as permanent (don't retry, don't fall back)
 * vs transient (retry primary, then try fallback).
 *
 * Permanent reasons (CR PR #37 catch — caller should fast-fail):
 *   - parse failure label (model output didn't parse; same prompt at
 *     temp=0 will keep failing)
 *   - HTTP 4xx (except 429 which is rate-limit + transient)
 *     - 404: phantom model name (same problem hits the fallback path
 *       if config is wrong, but better to fail loud than retry silently)
 *     - 401/403: auth — retrying won't fix it
 *     - 400: validation error in our request
 *   - "missing_api_key", "aborted" (already short-circuited but defensive)
 *
 * Transient reasons (keep retrying / falling back):
 *   - HTTP 5xx (server overload — the original case we built for)
 *   - HTTP 429 (rate limited; backoff helps)
 *   - Network errors, timeouts
 *   - Unknown (fail open — assume transient so we still try fallback)
 *
 * The chat() helper throws errors with messages like
 * `Ollama HTTP <status>: <body>`, so we extract the status code. For
 * non-HTTP failures (network), the message has no status — treat as
 * transient.
 */
export function isPermanentFailure(failureReason: string | undefined, parseFailureLabel: string): boolean {
  if (!failureReason) return false
  if (failureReason === parseFailureLabel) return true
  if (failureReason === "missing_api_key" || failureReason === "aborted") return true
  // Match `Ollama HTTP <status>` or generic `HTTP <status>` patterns
  const httpMatch = failureReason.match(/HTTP\s+(\d{3})/i)
  if (httpMatch && httpMatch[1]) {
    const status = Number.parseInt(httpMatch[1], 10)
    if (status === 429) return false // rate-limited = transient
    if (status >= 400 && status < 500) return true // other 4xx = permanent
  }
  return false
}

/**
 * SIG-438: should the SAME-MODEL retry loop in `runWithRetryAndFallback` stop
 * early (`break`) on this failure? True only for failures a re-roll of the same
 * model cannot fix: auth (missing key / 401 / 403), model-missing (404),
 * bad-request (400), and `aborted`.
 *
 * A PARSE failure is deliberately EXCLUDED (returns false → keep retrying the
 * same model). LLM output is non-deterministic, so re-rolling the same model
 * frequently parses — observed in prod: a specialist parsed one review pass and
 * failed the next on byte-identical input (PR #574 dropped the security
 * specialist this way). Pre-SIG-406 a parse failure broke here to skip to the
 * cross-provider fallback ("a different model may format correctly"); SIG-406
 * set `fallback: null` on every specialist, so that recovery is gone — without
 * this exclusion a parse failure gets ZERO retries and the specialist is
 * dropped fail-open.
 *
 * STRICTER than `isPermanentFailure`: every reason this returns true for,
 * `isPermanentFailure` also does — but NOT the parse label. `isPermanentFailure`
 * is left unchanged — it stays a re-exported public predicate with its own test
 * suite and, by design, still classes the parse label as permanent (the two
 * diverge only there).
 */
export function breaksSameModelRetry(failureReason: string | undefined, parseFailureLabel: string): boolean {
  if (failureReason === parseFailureLabel) return false
  return isPermanentFailure(failureReason, parseFailureLabel)
}

/**
 * SIG-460: extract the upstream PROVIDER SLUG named in a failure reason, so
 * `runWithRetryAndFallback` can EXCLUDE it from the next attempt of the same run
 * (`provider: { ignore: [slug] }`). OpenRouter's automatic failover only covers
 * REQUEST-time errors; a MID-STREAM provider 500 (`OpenRouter stream error: Upstream
 * error from WandB: Internal server error`) kills the attempt, and a plain same-model
 * retry can re-pick the same dead provider.
 *
 * Matches the `Upstream error from <Provider>` form (the observed mid-stream shape),
 * then normalizes the DISPLAY name to OpenRouter's slug convention (lowercase, strip
 * non-alphanumerics): `"WandB" → "wandb"`, `"DeepInfra" → "deepinfra"`. Returns null
 * when no provider is named (HTTP-status errors, timeouts, parse failures, aborts) —
 * those add no exclusion (current behavior). A mis-normalized slug is a documented
 * OpenRouter no-op in `ignore`, so a wrong guess never breaks a call. Pure; exported
 * for tests.
 */
export function parseFailedProvider(failureReason: string | undefined): string | null {
  if (!failureReason) return null
  const match = failureReason.match(/upstream error from\s+([^:,\n]+)/i)
  if (!match || !match[1]) return null
  const slug = match[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return slug.length > 0 ? slug : null
}

// SIG-392: relocated from model-provider.ts to keep that adapter <=1k lines
// (the SIG-386 pattern). Pure wire-shape validator; body byte-identical.
export function isValidProvenance(value: unknown): value is SynthesizerProvenance {
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
