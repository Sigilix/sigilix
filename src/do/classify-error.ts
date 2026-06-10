// ARC-190 Task 3: classify ensemble errors as transient (worth a
// retry alarm) or terminal (no retry — the same input would fail
// again).
//
// Pure functions. Used by the consumer wrapper (Task 7) before
// posting /run-result; the DO uses the verdict to decide whether to
// schedule a retry alarm or finalize the run as `failed`.
//
// Spec §4.6 — "v1 transient: HTTP 5xx, network timeouts, model
// timeouts. v1 terminal: 422 invalid-anchor, missing_api_key,
// outside-config-allowed-paths, hallucination-only verdicts."
//
// Default fallback: unrecognized → "transient" (pessimistic — better
// to burn one extra retry than terminal-fail a fixable thing per
// plan v2 Task 3).

import { GitHubHttpError } from "@/src/shared/adapters/github"

export type EnsembleErrorClass = "transient" | "terminal"

const TERMINAL_ENSEMBLE_REASONS = new Set<string>([
  "missing_api_key",
  "synth_invalid_provenance",
  "submit_fallback_failed",
])

const TRANSIENT_ENSEMBLE_REASON_PREFIXES = [
  "timeout",
  "aborted",
  "fallback_failed",
]

function readEnsembleReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null
  const e = err as Record<string, unknown>
  if (typeof e.failureReason === "string") return e.failureReason
  return null
}

function readErrMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return ""
}

function isAbortLike(err: unknown): boolean {
  const msg = readErrMessage(err)
  return /\bAbortError\b|operation\s+was\s+aborted|^aborted$/i.test(msg)
}

function isNetworkFetchFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  return /fetch\s+failed|network\s+request\s+failed|ECONNRESET|ENETUNREACH/i.test(err.message)
}

/**
 * Classify a thrown / returned ensemble error as transient or
 * terminal. Pure; defaults to "transient" on unrecognized inputs.
 */
export function classifyEnsembleError(err: unknown): EnsembleErrorClass {
  if (err instanceof GitHubHttpError) {
    if (err.status >= 500 && err.status < 600) return "transient"
    if (err.status === 422) return "terminal"
    if (err.status === 408) return "transient"
    return "transient"
  }
  const reason = readEnsembleReason(err)
  if (reason && TERMINAL_ENSEMBLE_REASONS.has(reason)) return "terminal"
  if (reason && TRANSIENT_ENSEMBLE_REASON_PREFIXES.some((p) => reason.startsWith(p))) {
    return "transient"
  }
  const msg = readErrMessage(err)
  if (/outside-config-allowed-paths/.test(msg)) return "terminal"
  // CR PR #70: match both hyphenated and underscored spellings so a
  // plain `Error("submit_fallback_failed")` (which the structured-
  // failureReason path at line 24 already treats as terminal) is
  // classified consistently when it surfaces only via err.message.
  if (/submit[-_]fallback[-_]failed/.test(msg)) return "terminal"
  if (isAbortLike(err)) return "transient"
  if (isNetworkFetchFailure(err)) return "transient"
  return "transient"
}

/**
 * Coarse stage label for telemetry. Pure; never throws.
 */
export function classifyEnsembleStage(err: unknown): string {
  if (err instanceof GitHubHttpError) return `github-http-${err.status}`
  const reason = readEnsembleReason(err)
  if (reason) return `ensemble-${reason}`
  if (isAbortLike(err)) return "aborted"
  if (isNetworkFetchFailure(err)) return "network"
  return "unknown"
}
