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
import {
  SPECIALIST_CONFIGS,
  SPECIALIST_TIMEOUT_MS,
  PER_ATTEMPT_TIMEOUT_MS,
} from "../src/lib/triage-pr-review-ensemble"

const TESTS_SPECIALIST_MIN_HEADROOM_MS = 40_000

describe("specialist per-attempt timeout overrides", () => {
  it("caps logic at 120s per attempt (think:false makes it fast; 2× the expected <60s for route variance)", () => {
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs).toBe(120_000)
    // Still above the global 60s default — logic's prompt is the largest, so
    // keep generous headroom even though think:false makes it finish fast.
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
  })

  it("caps tests at 110s per attempt so MiniMax M3 can finish testing-evidence cases", () => {
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs).toBe(110_000)
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
  })

  it("leaves security and performance on the global default (no per-role override)", () => {
    expect(SPECIALIST_CONFIGS.security.perAttemptTimeoutMs).toBeUndefined()
    expect(SPECIALIST_CONFIGS.performance.perAttemptTimeoutMs).toBeUndefined()
  })

  it("gives logic a cross-provider fallback (retries:0) whose primary+fallback chain fits the specialist wall", () => {
    // retries:0 — the resilience is the cross-provider FALLBACK, not a same-
    // model retry (a re-run of a stalled deepseek would just stall again).
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(0)
    // qwen3-coder-next:cloud — cross-provider from the deepseek-v4-flash
    // primary (fails independently) and proven fast in live telemetry.
    expect(SPECIALIST_CONFIGS.logic.fallback).toBe("qwen3-coder-next:cloud")
    expect(SPECIALIST_CONFIGS.logic.fallback).not.toBe(SPECIALIST_CONFIGS.logic.primary)
    // The full chain — primary (120s) + fallback (120s), no retry backoff —
    // must fit inside SPECIALIST_TIMEOUT_MS so a stalled primary can still be
    // rescued within the wall.
    const chainMs = 2 * SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!
    expect(chainMs).toBeLessThanOrEqual(SPECIALIST_TIMEOUT_MS)
  })

  it("keeps the tests primary+retry+fallback chain inside the specialist wall with 40s headroom", () => {
    const chainMs = 3 * SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs!
    expect(SPECIALIST_TIMEOUT_MS - chainMs).toBeGreaterThanOrEqual(TESTS_SPECIALIST_MIN_HEADROOM_MS)
  })
})
