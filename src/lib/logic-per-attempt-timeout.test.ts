// SIG-287: logic's per-role per-attempt timeout + fast-fallback resilience.
//
// The ORIGINAL "logic specialist unavailable" fix chased the per-attempt
// timeout (60→110→240→360s) — all of which failed. The TRUE root cause was
// a missing `think:false`: deepseek-v4-flash (a reasoning model) burned the
// whole budget in its thinking phase emitting zero `response` tokens (see
// tests/ollama-chat.test.ts + tests/ollama.test.ts for the think:false
// assertions). With think:false logic finishes in seconds, so the per-attempt
// cap drops to 120s and logic gains a cross-provider fallback so any future
// stall fails fast and is rescued. These assertions pin that config + the
// budget invariant that keeps it safe.

import { describe, expect, it } from "vitest"
import { SPECIALIST_CONFIGS, SPECIALIST_TIMEOUT_MS, PER_ATTEMPT_TIMEOUT_MS } from "@/src/lib/triage-pr-review-ensemble"
import { RETRY_BACKOFF_MS } from "@/src/lib/ensemble/domain/model-policy"

// SIG-406: the retry path inserts RETRY_BACKOFF_MS[0] between primary and retry, so the
// worst-case tests chain is 2×160s + 800ms = 320,800ms → ~49.2s headroom under the wall.
const TESTS_SPECIALIST_MIN_HEADROOM_MS = 49_000

describe("specialist per-attempt timeout overrides", () => {
  it("caps logic at 120s per attempt (think:false makes it fast; 2× the expected <60s for route variance)", () => {
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs).toBe(120_000)
    // Still above the global 60s default — logic's prompt is the largest, so
    // keep generous headroom even though think:false makes it finish fast.
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
  })

  it("caps tests at 160s per attempt so V4 Flash can fall back to MiniMax M3 inside the wall", () => {
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs).toBe(160_000)
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
  })

  it("gives security + performance retries:2 @ 90s — SIG-449 rework: parse re-rolls (not a longer cap) recover our-side stream/parse failures, and the 3-attempt chain still fits the wall", () => {
    // The OpenRouter activity log showed both fast roles finishing well under 90s
    // (flash p99/max 51.6s, glm-5.1 p99/max 54.9s) with zero provider cancels/errors,
    // so "unavailable" was an our-side parse/stream failure. The lever is an extra
    // attempt (retries:1→2), and the tighter 90s cap keeps the 3-attempt chain inside
    // the role wall while still clearing the observed max by ~35s.
    for (const role of ["security", "performance"] as const) {
      const cfg = SPECIALIST_CONFIGS[role]
      expect(cfg.perAttemptTimeoutMs).toBe(90_000)
      expect(cfg.retries).toBe(2)
      expect(cfg.fallback).toBeNull()
      expect(cfg.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
      // Full chain — 3 attempts (primary + 2 retries) + both backoffs — fits the wall.
      const backoffMs = RETRY_BACKOFF_MS.slice(0, cfg.retries).reduce((a, b) => a + b, 0)
      const chainMs = (cfg.retries + 1) * cfg.perAttemptTimeoutMs! + backoffMs
      expect(chainMs).toBeLessThanOrEqual(SPECIALIST_TIMEOUT_MS)
    }
  })

  it("gives logic retries:2 + no fallback (SIG-450 burst resilience) whose 3-attempt chain still fits the wall", () => {
    // SIG-450 (2026-06-16): logic raised retries:1→2 — under concurrent-PR burst it was the
    // heaviest role (reasoning=high) and blanked first ("logic unavailable", #29 re-probe 3/5).
    // Same lever as the SIG-449 fast roles: an extra same-model attempt recovers a transient
    // 429/parse/stream failure. Still NO cross-provider fallback (OpenRouter self-routes).
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(2)
    expect(SPECIALIST_CONFIGS.logic.fallback).toBeNull()
    // The full 3-attempt chain — 3×120s + both backoffs (0.8s + 2.5s) = 363.3s — must fit
    // inside the 370s role wall so a stalled primary can still be rescued (6.7s slack). Uses
    // the accurate per-retry backoff sum (matching the security/performance guard above).
    const backoffMs = RETRY_BACKOFF_MS.slice(0, SPECIALIST_CONFIGS.logic.retries).reduce((a, b) => a + b, 0)
    const chainMs = (SPECIALIST_CONFIGS.logic.retries + 1) * SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs! + backoffMs
    expect(chainMs).toBeLessThanOrEqual(SPECIALIST_TIMEOUT_MS)
  })

  it("keeps the tests primary+retry chain (incl. backoff) inside the specialist wall (SIG-406)", () => {
    expect(SPECIALIST_CONFIGS.tests.retries).toBe(1)
    expect(SPECIALIST_CONFIGS.tests.fallback).toBeNull()
    const chainMs =
      (SPECIALIST_CONFIGS.tests.retries + 1) * SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs! +
      SPECIALIST_CONFIGS.tests.retries * RETRY_BACKOFF_MS[0]!
    expect(SPECIALIST_TIMEOUT_MS - chainMs).toBeGreaterThanOrEqual(TESTS_SPECIALIST_MIN_HEADROOM_MS)
  })
})
