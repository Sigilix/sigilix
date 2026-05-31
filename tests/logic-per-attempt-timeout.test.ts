// SIG-236: logic's per-role per-attempt timeout. The root-cause fix for
// "logic specialist unavailable" — its ~8.4k-token prompt needs >60s, so the
// global PER_ATTEMPT_TIMEOUT_MS aborted it mid-generation on every review.
// These assertions pin the value + the budget invariant that keeps it safe.

import { describe, expect, it } from "vitest"
import {
  SPECIALIST_CONFIGS,
  SPECIALIST_TIMEOUT_MS,
  PER_ATTEMPT_TIMEOUT_MS,
} from "../src/lib/triage-pr-review-ensemble"

describe("SIG-236 logic per-attempt timeout", () => {
  it("gives logic a 360s per-attempt cap (SIG-287 — 110s/240s each left it intermittent)", () => {
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs).toBe(360_000)
    // It MUST exceed the global default — that 60s cap is the bug it fixes.
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
  })

  it("leaves the other roles on the global default (no per-role override)", () => {
    expect(SPECIALIST_CONFIGS.security.perAttemptTimeoutMs).toBeUndefined()
    expect(SPECIALIST_CONFIGS.performance.perAttemptTimeoutMs).toBeUndefined()
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs).toBeUndefined()
  })

  it("keeps one attempt within the specialist wall — logic must stay retries:0/fallback:null", () => {
    // A single 360s attempt fits inside SPECIALIST_TIMEOUT_MS (370s); a SECOND
    // would not (2×360s > 370s), so logic must never re-enable retries/fallback.
    expect(SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!).toBeLessThan(SPECIALIST_TIMEOUT_MS)
    expect(2 * SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs!).toBeGreaterThan(SPECIALIST_TIMEOUT_MS)
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(0)
    expect(SPECIALIST_CONFIGS.logic.fallback).toBeNull()
  })
})
