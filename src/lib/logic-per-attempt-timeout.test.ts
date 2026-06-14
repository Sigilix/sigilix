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

  it("leaves security and performance on the global default (no per-role override)", () => {
    expect(SPECIALIST_CONFIGS.security.perAttemptTimeoutMs).toBeUndefined()
    expect(SPECIALIST_CONFIGS.performance.perAttemptTimeoutMs).toBeUndefined()
  })

  it("gives logic retries:1 + no fallback (SIG-406: OpenRouter self-routes) whose attempt chain fits the wall", () => {
    // SIG-406: on OpenRouter the resilience is a single same-model RETRY (retries:1);
    // there is NO per-role cross-provider fallback (OpenRouter routes across upstreams).
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(1)
    expect(SPECIALIST_CONFIGS.logic.fallback).toBeNull()
    // The full chain — primary (120s) + backoff (800ms) + 1 retry (120s) — must fit
    // inside SPECIALIST_TIMEOUT_MS so a stalled primary can still be rescued in the wall.
    const chainMs =
      (SPECIALIST_CONFIGS.logic.retries + 1) * SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs! +
      SPECIALIST_CONFIGS.logic.retries * RETRY_BACKOFF_MS[0]!
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
