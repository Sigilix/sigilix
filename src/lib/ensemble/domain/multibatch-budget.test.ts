// SIG-418 Phase 2 (Design B′) — pure multi-batch budget + flag tests:
//   - the off|shadow|on mode parser (default off, normalize),
//   - the synth-budgeted next-batch launch decision (reserves the synth tail,
//     refuses a batch that wouldn't leave synth room, clamps batchTimeout to
//     whatever pre-synth time is left).

import { describe, expect, it } from "vitest"
import {
  ORCHESTRATOR_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
} from "@/src/lib/ensemble/domain/budget"
import {
  decideNextBatchLaunch,
  decideNextBatchLaunchWithBudget,
  parseMultiBatchMode,
  type NextBatchLaunchInput,
} from "@/src/lib/ensemble/domain/multibatch-budget"

describe("parseMultiBatchMode", () => {
  it("defaults to off and normalizes (trim + lowercase)", () => {
    expect(parseMultiBatchMode(undefined)).toBe("off")
    expect(parseMultiBatchMode("")).toBe("off")
    expect(parseMultiBatchMode("   ")).toBe("off")
    expect(parseMultiBatchMode("bogus")).toBe("off")
    expect(parseMultiBatchMode("off")).toBe("off")
    expect(parseMultiBatchMode(" Shadow ")).toBe("shadow")
    expect(parseMultiBatchMode("ON")).toBe("on")
  })
})

describe("decideNextBatchLaunch (synth-budgeted wall-clock guard)", () => {
  // A small, exact budget so the arithmetic is checkable by hand.
  const budget = {
    specialistMs: 100,
    synthesizerMs: 50,
    reservedHeadroomMs: 20,
    orchestratorMs: 200,
  }
  // tailReserveMs = 50 + 20 = 70; preSynthDeadline = startMs + 200 - 70 = startMs + 130.
  const startMs = 1_000
  const input = (over: Partial<NextBatchLaunchInput> = {}): NextBatchLaunchInput => ({
    ...budget,
    startMs,
    now: startMs,
    minUsefulBatchMs: 30,
    ...over,
  })

  it("reserves the synth tail in preSynthDeadline (synth + headroom subtracted)", () => {
    const d = decideNextBatchLaunch(input())
    // startMs(1000) + orchestratorMs(200) - (synth 50 + headroom 20) = 1130.
    expect(d.preSynthDeadline).toBe(1_130)
  })

  it("launches early in the wall: remaining is ample, timeout clamps to one specialist wave", () => {
    // now = startMs → remaining = 130, which is > specialistMs(100).
    const d = decideNextBatchLaunch(input({ now: startMs }))
    expect(d.canLaunchNextBatch).toBe(true)
    // Capped at one wave even though 130ms is available.
    expect(d.batchTimeoutMs).toBe(budget.specialistMs)
  })

  it("clamps batchTimeoutMs DOWN to the pre-synth time left when less than a full wave remains", () => {
    // Put `now` so remaining = 130 - 70 = 60 (< specialistMs 100, >= minUseful 30).
    const d = decideNextBatchLaunch(input({ now: startMs + 70 }))
    expect(d.canLaunchNextBatch).toBe(true)
    expect(d.batchTimeoutMs).toBe(60)
  })

  it("refuses a batch that would not leave the synth tail its room (remaining < minUsefulBatchMs)", () => {
    // remaining = 130 - 105 = 25 < minUseful 30 → do not launch.
    const d = decideNextBatchLaunch(input({ now: startMs + 105 }))
    expect(d.canLaunchNextBatch).toBe(false)
  })

  it("treats remaining == minUsefulBatchMs as launchable (inclusive boundary)", () => {
    // remaining = 130 - 100 = 30 == minUseful 30 → launch.
    const d = decideNextBatchLaunch(input({ now: startMs + 100 }))
    expect(d.canLaunchNextBatch).toBe(true)
    expect(d.batchTimeoutMs).toBe(30)
  })

  it("never returns a negative timeout once past the pre-synth deadline", () => {
    // now well past preSynthDeadline → remaining negative.
    const d = decideNextBatchLaunch(input({ now: startMs + 500 }))
    expect(d.canLaunchNextBatch).toBe(false)
    expect(d.batchTimeoutMs).toBe(0)
  })

  it("stays un-launchable past the deadline even if minUsefulBatchMs is non-positive (robust to a bad caller)", () => {
    // remaining negative; a non-positive floor must NOT make a 0 ms-timeout
    // launch look viable — the `> 0` guard keeps it un-launchable.
    const dPastNeg = decideNextBatchLaunch(input({ now: startMs + 500, minUsefulBatchMs: -10 }))
    expect(dPastNeg.canLaunchNextBatch).toBe(false)
    expect(dPastNeg.batchTimeoutMs).toBe(0)
    // Exactly at the deadline (remaining == 0) is also not launchable.
    const dAtDeadline = decideNextBatchLaunch(input({ now: startMs + 130, minUsefulBatchMs: 0 }))
    expect(dAtDeadline.canLaunchNextBatch).toBe(false)
    expect(dAtDeadline.batchTimeoutMs).toBe(0)
  })

  it("never lets a launched batch + the reserved synth tail exceed the orchestrator wall", () => {
    // For any launchable `now`, (now - startMs) + batchTimeoutMs + tailReserve must
    // stay within the orchestrator budget. Sweep the whole window.
    const tailReserve = budget.synthesizerMs + budget.reservedHeadroomMs
    for (let offset = 0; offset <= budget.orchestratorMs; offset += 5) {
      const d = decideNextBatchLaunch(input({ now: startMs + offset }))
      if (!d.canLaunchNextBatch) continue
      const worstCaseEnd = offset + d.batchTimeoutMs + tailReserve
      expect(worstCaseEnd).toBeLessThanOrEqual(budget.orchestratorMs)
    }
  })
})

describe("decideNextBatchLaunchWithBudget (real budget.ts constants)", () => {
  it("uses the real timeout constants for the reserve + the one-wave cap", () => {
    const startMs = 10_000
    const d = decideNextBatchLaunchWithBudget({ startMs, now: startMs, minUsefulBatchMs: 1 })
    const expectedDeadline = startMs + ORCHESTRATOR_TIMEOUT_MS - (SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS)
    expect(d.preSynthDeadline).toBe(expectedDeadline)
    // At t0 the full pre-synth window exceeds one specialist wave, so it caps.
    expect(d.canLaunchNextBatch).toBe(true)
    expect(d.batchTimeoutMs).toBe(SPECIALIST_TIMEOUT_MS)
  })

  it("refuses once the real wall is past the pre-synth deadline", () => {
    const startMs = 10_000
    // now exactly at the (real) pre-synth deadline + 1ms → remaining < any positive minUseful.
    const deadline = startMs + ORCHESTRATOR_TIMEOUT_MS - (SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS)
    const d = decideNextBatchLaunchWithBudget({ startMs, now: deadline + 1, minUsefulBatchMs: 1 })
    expect(d.canLaunchNextBatch).toBe(false)
    expect(d.batchTimeoutMs).toBe(0)
  })
})
