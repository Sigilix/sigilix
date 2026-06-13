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
