// SIG-228 Phase 3c — synth-bypass eligibility predicate.
//
// Narrow unit tests on the pure helper extracted from
// `triage-pr-review-ensemble.ts`. The orchestrator's inline bypass
// branch reads the same predicate; these tests pin the gate semantics
// without spinning up the full ensemble integration harness.
//
// Bypass fires iff:
//   1. `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"` (case-insensitive, trimmed)
//   2. Dispatcher narrowed to exactly 1 specialist (`dispatchedCount === 1`)
//   3. Exactly 1 specialist returned a non-null verdict
//   4. None of that specialist's findings have `score >= 4`
// All four must hold simultaneously. Any falsy condition routes to the
// legacy synth path so the synth LLM still runs.

import { describe, expect, it } from "vitest"
import { isSynthBypassEligible, isSynthBypassEnabled } from "@/src/lib/triage-pr-review-ensemble"
import type { Env } from "@/src/shared/types/env"

function envWith(flag: string | undefined): Env {
  // The helpers only read OPENCLAW_SYNTH_BYPASS_ENABLED off Env; the
  // rest of the Env surface area is irrelevant to this predicate.
  const env: Partial<Env> = {}
  if (flag !== undefined) env.OPENCLAW_SYNTH_BYPASS_ENABLED = flag
  return env as Env
}

function findings(...scores: number[]) {
  return [{
    verdict: { findings: scores.map((score) => ({ score })) },
  }]
}

describe("isSynthBypassEnabled — env flag parsing", () => {
  it("returns true for the exact \"on\" value", () => {
    expect(isSynthBypassEnabled(envWith("on"))).toBe(true)
  })

  it("accepts case-insensitive + whitespace-tolerant \"on\"", () => {
    expect(isSynthBypassEnabled(envWith("ON"))).toBe(true)
    expect(isSynthBypassEnabled(envWith("  on  "))).toBe(true)
    expect(isSynthBypassEnabled(envWith("On"))).toBe(true)
  })

  it("returns false when the flag is absent", () => {
    expect(isSynthBypassEnabled(envWith(undefined))).toBe(false)
  })

  it("returns false for \"off\" / any non-\"on\" value", () => {
    expect(isSynthBypassEnabled(envWith("off"))).toBe(false)
    expect(isSynthBypassEnabled(envWith("shadow"))).toBe(false)
    expect(isSynthBypassEnabled(envWith("true"))).toBe(false)
    expect(isSynthBypassEnabled(envWith(""))).toBe(false)
    expect(isSynthBypassEnabled(envWith("1"))).toBe(false)
  })
})

describe("isSynthBypassEligible — bypass gate semantics", () => {
  describe("happy path — bypass fires", () => {
    it("returns true on 1 specialist + all score < 4 findings", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings(1, 2, 3))).toBe(true)
    })

    it("returns true on 1 specialist + zero findings (clean review)", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings())).toBe(true)
    })

    it("returns true on 1 specialist + boundary case (all findings score === 3)", () => {
      // score === 3 is the highest non-major value (matches the
      // `f.score < 4` strict gate).
      expect(isSynthBypassEligible(envWith("on"), 1, findings(3, 3, 3))).toBe(true)
    })
  })

  describe("flag-off paths — bypass disabled regardless of input", () => {
    it("returns false when the flag is absent, even on the otherwise-happy path", () => {
      expect(isSynthBypassEligible(envWith(undefined), 1, findings(1, 2, 3))).toBe(false)
    })

    it("returns false when the flag is \"off\"", () => {
      expect(isSynthBypassEligible(envWith("off"), 1, findings(1, 2))).toBe(false)
    })

    it("returns false when the flag has any other value (e.g. shadow)", () => {
      expect(isSynthBypassEligible(envWith("shadow"), 1, findings(1))).toBe(false)
    })
  })

  describe("succeeded-count paths — bypass requires exactly 1 verdict", () => {
    it("returns false on 0 succeeded verdicts (empty candidate list)", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, [])).toBe(false)
    })

    it("returns false when dispatched=2 + 2 succeeded (legitimate multi-specialist)", () => {
      expect(isSynthBypassEligible(envWith("on"), 2, [
        { verdict: { findings: [{ score: 2 }] } },
        { verdict: { findings: [{ score: 3 }] } },
      ])).toBe(false)
    })

    it("returns false when dispatched=4 + 4 succeeded (full fan-out)", () => {
      expect(isSynthBypassEligible(envWith("on"), 4, [
        { verdict: { findings: [{ score: 1 }] } },
        { verdict: { findings: [{ score: 2 }] } },
        { verdict: { findings: [{ score: 3 }] } },
        { verdict: { findings: [] } },
      ])).toBe(false)
    })
  })

  describe("dispatched-count paths — bypass requires dispatcher narrowed to 1", () => {
    // CodeRabbit phase-end catch: bypassing on `succeeded.length === 1`
    // alone silently demotes a degraded-coverage run (dispatched=3,
    // succeeded=1 after 2 specialist failures) to "the 1 survivor is
    // the whole review." The dispatched-count gate prevents that.
    it("returns false when dispatched=3 + 1 succeeded (degraded coverage, NOT hot path)", () => {
      // Customer expected 3 perspectives; we got 1 due to fan-out
      // failures. MUST run synth so it can render the [DEGRADED
      // COVERAGE] block. Without this gate the bypass would silently
      // promote the sole survivor to "the whole review."
      expect(isSynthBypassEligible(envWith("on"), 3, findings(1, 2))).toBe(false)
    })

    it("returns false when dispatched=2 + 1 succeeded (sole-survivor partial failure)", () => {
      expect(isSynthBypassEligible(envWith("on"), 2, findings(3))).toBe(false)
    })

    it("returns false when dispatched=0 (degenerate: empty router)", () => {
      // Empty-router path already short-circuits before reaching the
      // bypass check, but the helper guards defensively.
      expect(isSynthBypassEligible(envWith("on"), 0, findings(2))).toBe(false)
    })
  })

  describe("severity paths — any score >= 4 kills the bypass", () => {
    it("returns false on 1 specialist with a single score === 4 finding", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings(4))).toBe(false)
    })

    it("returns false on 1 specialist with a single score === 5 finding (critical)", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings(5))).toBe(false)
    })

    it("returns false on 1 specialist with mixed findings where one is score === 4", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings(1, 2, 4))).toBe(false)
    })

    it("returns false on 1 specialist with all score === 5 (every finding critical)", () => {
      expect(isSynthBypassEligible(envWith("on"), 1, findings(5, 5))).toBe(false)
    })
  })

  describe("null-verdict paths — bypass requires a real verdict", () => {
    it("returns false when the sole candidate has verdict === null", () => {
      // The orchestrator's bypass path constructs synthOutput from
      // `sole.verdict` directly — if it's null the bypass would crash.
      // Predicate guards against this so the synth path runs instead.
      expect(isSynthBypassEligible(envWith("on"), 1, [{ verdict: null }])).toBe(false)
    })
  })
})
