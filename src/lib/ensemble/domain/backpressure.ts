// SIG-455 (PR B) — pure backpressure knobs (domain layer).
//
// Two pure, side-effect-free utilities the provider backpressure layer needs:
//   1. decorrelatedJitterMs — fixed-base uniform jitter for retry scheduling.
//   2. resolveCooldownMode — env-flag → "off" | "shadow" | "enforce".
//
// parseRetryAfterMs / MAX_RETRY_AFTER_MS have been extracted to
// @/src/shared/util/retry-after so the model adapter can import them without a
// cross-feature / inward-violating edge.
//
// Domain-layer contract: NO env reads, NO I/O, NO clock calls, NO network.
// All non-deterministic inputs (rand, env) are injected by the caller.
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
