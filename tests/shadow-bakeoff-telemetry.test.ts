// tests/shadow-bakeoff-telemetry.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EnsembleRunCtx } from "../src/lib/ensemble-perf-telemetry"
import {
  emitShadowAttempt,
  emitShadowVerdictComparison,
  computeFindingsOverlap,
  type ShadowAttemptEvent,
  type ShadowVerdictComparison,
} from "../src/lib/shadow-bakeoff-telemetry"

const CTX: EnsembleRunCtx = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 99,
  headSha: "feedface00000000000000000000000000000000",
}

let logSpy: ReturnType<typeof vi.spyOn>

function lastLogged(): Record<string, unknown> {
  const calls = logSpy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1]?.[0] as string) as Record<string, unknown>
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
})

describe("emitShadowAttempt", () => {
  it("emits a shadow-model-attempt-completed event with correlation fields + truncated headSha", () => {
    const info: ShadowAttemptEvent = {
      role: "synth",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "deepseek-v4-flash:cloud",
      timeoutMs: 60_000,
      startedAtMs: 1_000,
      endedAtMs: 1_500,
      elapsedMs: 500,
      outcome: "ok",
    }
    emitShadowAttempt(CTX, info)
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-model-attempt-completed")
    expect(event["owner"]).toBe("Arc-and-Anchor")
    expect(event["headSha"]).toBe("feedfac")
    expect(event["role"]).toBe("synth")
    expect(event["attemptKind"]).toBe("primary")
    expect(event["model"]).toBe("deepseek-v4-flash:cloud")
    expect(event["outcome"]).toBe("ok")
    expect(event).not.toHaveProperty("failureReason")
  })

  it("includes failureReason only when outcome is not ok", () => {
    emitShadowAttempt(CTX, {
      role: "tests", attemptKind: "fallback", attemptIndex: 2,
      model: "deepseek-v4-flash:cloud", timeoutMs: 60_000,
      startedAtMs: 0, endedAtMs: 60_000, elapsedMs: 60_000,
      outcome: "timeout", failureReason: "per_attempt_timeout",
    })
    const event = lastLogged()
    expect(event["outcome"]).toBe("timeout")
    expect(event["failureReason"]).toBe("per_attempt_timeout")
  })
})

describe("emitShadowVerdictComparison", () => {
  it("emits a shadow-verdict-comparison event with all comparison fields", () => {
    const comp: ShadowVerdictComparison = {
      role: "synth",
      prodModel: "kimi-k2.6:cloud",
      shadowModel: "deepseek-v4-flash:cloud",
      prodVerdictOk: true,
      shadowVerdictOk: true,
      prodElapsedMs: 52_000,
      shadowElapsedMs: 41_000,
      prodAttemptsUsed: 1,
      shadowAttemptsUsed: 1,
      prodFindingsCount: 3,
      shadowFindingsCount: 4,
      overlapCount: 2,
      prodOnlyCount: 1,
      shadowOnlyCount: 2,
      prodScoreHistogram: { 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 },
      shadowScoreHistogram: { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0 },
      shadowFailureReason: null,
    }
    emitShadowVerdictComparison(CTX, comp)
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-verdict-comparison")
    expect(event["role"]).toBe("synth")
    expect(event["prodModel"]).toBe("kimi-k2.6:cloud")
    expect(event["shadowModel"]).toBe("deepseek-v4-flash:cloud")
    expect(event["overlapCount"]).toBe(2)
    expect(event["prodOnlyCount"]).toBe(1)
    expect(event["shadowOnlyCount"]).toBe(2)
    expect(event["prodScoreHistogram"]).toEqual({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 })
    expect(event["shadowFailureReason"]).toBeNull()
  })
})

describe("computeFindingsOverlap", () => {
  const f = (path: string, line: number, category: string, score: number) =>
    ({ path, line, category, score, headline: "", body: "" })

  it("returns zero overlap when one side has no findings", () => {
    expect(computeFindingsOverlap([], [f("a.ts", 1, "logic", 3)])).toEqual({
      overlapCount: 0, prodOnlyCount: 0, shadowOnlyCount: 1,
      prodScoreHistogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      shadowScoreHistogram: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
    })
    expect(computeFindingsOverlap([f("a.ts", 1, "logic", 3)], [])).toEqual({
      overlapCount: 0, prodOnlyCount: 1, shadowOnlyCount: 0,
      prodScoreHistogram: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
      shadowScoreHistogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    })
  })

  it("matches on (path, line, category) tuple — different category at same line is NOT a match", () => {
    const result = computeFindingsOverlap(
      [f("a.ts", 10, "logic", 4), f("b.ts", 5, "security", 5)],
      [f("a.ts", 10, "logic", 3), f("a.ts", 10, "performance", 4)],
    )
    expect(result.overlapCount).toBe(1) // only a.ts:10:logic matches
    expect(result.prodOnlyCount).toBe(1) // b.ts:5:security
    expect(result.shadowOnlyCount).toBe(1) // a.ts:10:performance
  })

  it("deduplicates by tuple so a model spamming the same line still scores 1 overlap", () => {
    const result = computeFindingsOverlap(
      [f("a.ts", 10, "logic", 4), f("a.ts", 10, "logic", 2)],
      [f("a.ts", 10, "logic", 3)],
    )
    expect(result.overlapCount).toBe(1)
    expect(result.prodOnlyCount).toBe(0)
    expect(result.shadowOnlyCount).toBe(0)
  })

  it("produces a 1..5 score histogram for an array of findings", () => {
    // exposed via the same module for orchestrator use; spec'd alongside overlap.
    const result = computeFindingsOverlap(
      [f("a.ts", 1, "logic", 2), f("a.ts", 2, "logic", 5), f("a.ts", 3, "logic", 5)],
      [],
    )
    expect(result.prodScoreHistogram).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 2 })
    expect(result.shadowScoreHistogram).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  })
})
