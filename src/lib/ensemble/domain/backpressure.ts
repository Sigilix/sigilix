// SIG-455 (PR B) — pure backpressure knobs (domain layer).
//
// Three pure, side-effect-free utilities the provider backpressure layer needs:
//   1. decorrelatedJitterMs — fixed-base uniform jitter for retry scheduling.
//   2. parseRetryAfterMs   — HTTP `Retry-After` header → milliseconds.
//   3. resolveCooldownMode — env-flag → "off" | "shadow" | "enforce".
//
// Domain-layer contract: NO env reads, NO I/O, NO clock calls, NO network.
// All non-deterministic inputs (rand, nowMs, env) are injected by the caller.
// The only import is the `Env` type (type-only; zero runtime cost).

import type { Env } from "@/src/shared/types/env"

// ─── decorrelatedJitterMs ────────────────────────────────────────────────────

/** Default jitter lower bound (ms). */
export const JITTER_BASE_MS = 500

/** Default jitter upper bound (ms). */
export const JITTER_CAP_MS = 5000

/**
 * Compute a decorrelated jitter delay that is uniform in `[jitterBaseMs, jitterCapMs)`.
 *
 * Formula: `Math.round(jitterBaseMs + rand * (jitterCapMs - jitterBaseMs))`
 *
 * The jitter is *decoupled from any remaining time* — the caller owns budget
 * accounting and passes the desired bounds explicitly.
 *
 * @param jitterBaseMs - Minimum delay in ms. Must be >= 0.
 * @param jitterCapMs  - Maximum delay in ms. If < jitterBaseMs the cap is
 *                       treated as equal to the base (i.e. always returns base).
 * @param rand         - Uniform random value in [0, 1). Use `Math.random()` at
 *                       the call site; injected here so the function is testable.
 * @returns Delay in ms, always >= 0.
 */
export function decorrelatedJitterMs(jitterBaseMs: number, jitterCapMs: number, rand: number): number {
  const base = Math.max(0, jitterBaseMs)
  const cap = jitterCapMs < jitterBaseMs ? base : jitterCapMs
  return Math.round(base + rand * (cap - base))
}

// ─── parseRetryAfterMs ──────────────────────────────────────────────────────

/**
 * Maximum value returned by `parseRetryAfterMs` (5 minutes).
 * A hostile or misconfigured `Retry-After` must never pin us indefinitely.
 */
export const MAX_RETRY_AFTER_MS = 300_000

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * Supports two formats per RFC 9110 §10.2.3:
 *   - **delta-seconds**: a non-negative integer string (`/^\d+$/`) →
 *     `seconds * 1000`.
 *   - **HTTP-date**: any string parseable by `Date.parse` → `max(0, parsed - nowMs)`.
 *
 * Falls back to `defaultMs` when `header` is `null`, empty, negative,
 * non-numeric + non-date, or produces `NaN`.
 *
 * Always clamps the result to `MAX_RETRY_AFTER_MS` to guard against a
 * pathological large header value that would stall retries for too long.
 *
 * @param header    - The raw `Retry-After` header string, or `null`.
 * @param nowMs     - The current epoch time in ms (injected; not read from Date).
 * @param defaultMs - Value returned when the header is absent or invalid.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number, defaultMs: number): number {
  if (header === null || header === "") return defaultMs

  // Try delta-seconds: must be a non-negative integer string (no sign, no dot).
  if (/^\d+$/.test(header)) {
    const seconds = parseInt(header, 10)
    if (!isNaN(seconds)) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }

  // Guard: a string that looks like a numeric value (signed, float, scientific)
  // but did NOT match the strict non-negative integer above is an invalid
  // delta-seconds (negative or non-integer). Return defaultMs immediately
  // rather than letting Date.parse parse it as a year or partial date.
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(header)) {
    return defaultMs
  }

  // Try HTTP-date.
  const parsed = Date.parse(header)
  if (!isNaN(parsed)) {
    return Math.min(Math.max(0, parsed - nowMs), MAX_RETRY_AFTER_MS)
  }

  return defaultMs
}

// ─── resolveCooldownMode ────────────────────────────────────────────────────

/**
 * Resolve the provider cooldown feature-flag from the Worker env.
 *
 * Three-state rollout:
 *   - `"enforce"` — requests are held/rejected during a provider cooldown.
 *   - `"shadow"`  — cooldown state is tracked and telemetered; no blocking.
 *   - `"off"`     — (default) cooldown logic fully bypassed.
 *
 * Absent, unknown, or mis-cased values all resolve to `"off"`.
 */
export function resolveCooldownMode(env: Pick<Env, "SIGILIX_PROVIDER_COOLDOWN_MODE">): "off" | "shadow" | "enforce" {
  const v = env.SIGILIX_PROVIDER_COOLDOWN_MODE
  if (v === "enforce") return "enforce"
  if (v === "shadow") return "shadow"
  return "off"
}
