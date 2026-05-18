// ARC-284 — pin the event shape of the perf-telemetry emitters so a
// future refactor that drops a field (or renames one) gets caught
// here instead of breaking downstream log-analysis pipelines.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  type EnsembleRunCtx,
  type SpecialistFanoutSummary,
  type SynthSummary,
  type ModelAttemptEvent,
  type DoReviewRunTiming,
  emitPhaseCompleted,
  recordPhase,
  emitModelAttempt,
  emitSpecialistFanoutSummary,
  emitSynthSummary,
  emitDoReviewRunTiming,
} from "../src/lib/ensemble-perf-telemetry"

const CTX: EnsembleRunCtx = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 94,
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
}

let logSpy: ReturnType<typeof vi.spyOn>

function lastLogged(): Record<string, unknown> {
  const calls = logSpy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const last = calls[calls.length - 1]?.[0]
  expect(typeof last).toBe("string")
  return JSON.parse(last as string)
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  logSpy.mockRestore()
})

// ─── ensemble-phase-completed ────────────────────────────────────────

describe("emitPhaseCompleted", () => {
  it("emits a JSON-encoded payload with the expected fields + truncated headSha", () => {
    emitPhaseCompleted(CTX, "specialist_fanout", 1_000, 1_270)
    const event = lastLogged()
    expect(event["event"]).toBe("ensemble-phase-completed")
    expect(event["owner"]).toBe("Arc-and-Anchor")
    expect(event["repo"]).toBe("sigilix")
    expect(event["prNumber"]).toBe(94)
    // headSha is truncated to 7 chars at log time. This is a stable
    // contract — log analyzers join on this short SHA, not the full.
    expect(event["headSha"]).toBe("abcdef1")
    expect(event["phase"]).toBe("specialist_fanout")
    expect(event["startedAtMs"]).toBe(1_000)
    expect(event["endedAtMs"]).toBe(1_270)
    expect(event["durationMs"]).toBe(270)
  })

  it("defaults endedAtMs to Date.now() when not supplied", () => {
    const before = Date.now()
    emitPhaseCompleted(CTX, "synth", before)
    const event = lastLogged()
    expect(event["startedAtMs"]).toBe(before)
    expect(typeof event["endedAtMs"]).toBe("number")
    expect(event["durationMs"]).toBeGreaterThanOrEqual(0)
    // Sanity check: defaulted end can't precede the recorded start.
    expect(event["endedAtMs"] as number).toBeGreaterThanOrEqual(before)
  })
})

describe("recordPhase", () => {
  it("emits exactly one phase event when the inner fn resolves", async () => {
    const out = await recordPhase(CTX, "diff_pack", async () => "value")
    expect(out).toBe("value")
    expect(logSpy.mock.calls.length).toBe(1)
    expect(lastLogged()["phase"]).toBe("diff_pack")
  })

  it("emits the phase event even when the inner fn throws (then re-throws)", async () => {
    await expect(
      recordPhase(CTX, "submit", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(logSpy.mock.calls.length).toBe(1)
    const event = lastLogged()
    expect(event["event"]).toBe("ensemble-phase-completed")
    expect(event["phase"]).toBe("submit")
  })
})

// ─── model-attempt-completed ────────────────────────────────────────

describe("emitModelAttempt", () => {
  it("includes failureReason only when supplied", () => {
    const ok: ModelAttemptEvent = {
      phase: "specialist",
      role: "logic",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "deepseek-v4-pro:cloud",
      timeoutMs: 85_000,
      startedAtMs: 100,
      endedAtMs: 200,
      elapsedMs: 100,
      outcome: "ok",
    }
    emitModelAttempt(CTX, ok)
    expect(lastLogged()["failureReason"]).toBeUndefined()

    const failed: ModelAttemptEvent = {
      ...ok,
      outcome: "failed",
      failureReason: "HTTP 503",
    }
    emitModelAttempt(CTX, failed)
    expect(lastLogged()["failureReason"]).toBe("HTTP 503")
  })

  it("stamps the event name + correlation fields", () => {
    emitModelAttempt(CTX, {
      phase: "synth",
      role: "synth",
      attemptKind: "retry",
      attemptIndex: 2,
      model: "kimi-k2.6:cloud",
      timeoutMs: 160_000,
      startedAtMs: 1_000,
      endedAtMs: 1_120,
      elapsedMs: 120,
      outcome: "ok",
    })
    const event = lastLogged()
    expect(event["event"]).toBe("model-attempt-completed")
    expect(event["phase"]).toBe("synth")
    expect(event["role"]).toBe("synth")
    expect(event["attemptKind"]).toBe("retry")
    expect(event["attemptIndex"]).toBe(2)
    expect(event["headSha"]).toBe("abcdef1")
  })
})

// ─── specialist-fanout-summary ──────────────────────────────────────

describe("emitSpecialistFanoutSummary", () => {
  it("emits the expected fields with slowest role + per-role accounting", () => {
    const summary: SpecialistFanoutSummary = {
      dispatchedRoles: ["logic", "security", "performance", "tests"],
      succeededRoles: ["logic", "security", "tests"],
      failedRoles: ["performance"],
      fanoutElapsedMs: 269_500,
      slowestRole: "logic",
      slowestElapsedMs: 268_900,
      totalAttemptsUsed: 7,
      fallbacksUsed: 2,
    }
    emitSpecialistFanoutSummary(CTX, summary)
    const event = lastLogged()
    expect(event["event"]).toBe("specialist-fanout-summary")
    expect(event["dispatchedRoles"]).toEqual(["logic", "security", "performance", "tests"])
    expect(event["succeededRoles"]).toEqual(["logic", "security", "tests"])
    expect(event["failedRoles"]).toEqual(["performance"])
    expect(event["slowestRole"]).toBe("logic")
    expect(event["slowestElapsedMs"]).toBe(268_900)
    expect(event["totalAttemptsUsed"]).toBe(7)
    expect(event["fallbacksUsed"]).toBe(2)
  })

  it("accepts slowestRole = null when no roles were dispatched", () => {
    emitSpecialistFanoutSummary(CTX, {
      dispatchedRoles: [],
      succeededRoles: [],
      failedRoles: [],
      fanoutElapsedMs: 0,
      slowestRole: null,
      slowestElapsedMs: 0,
      totalAttemptsUsed: 0,
      fallbacksUsed: 0,
    })
    expect(lastLogged()["slowestRole"]).toBeNull()
  })
})

// ─── synth-summary ──────────────────────────────────────────────────

describe("emitSynthSummary", () => {
  it("emits all fields including retryOutcome=null when retry didn't fire", () => {
    const summary: SynthSummary = {
      elapsedMs: 92_000,
      attemptsUsed: 1,
      retryUsed: false,
      retryOutcome: null,
      inputSpecialistCount: 4,
      inputFindingCount: 9,
      outputFindingCount: 3,
      modelUsed: "kimi-k2.6:cloud",
    }
    emitSynthSummary(CTX, summary)
    const event = lastLogged()
    expect(event["event"]).toBe("synth-summary")
    expect(event["elapsedMs"]).toBe(92_000)
    expect(event["attemptsUsed"]).toBe(1)
    expect(event["retryUsed"]).toBe(false)
    expect(event["retryOutcome"]).toBeNull()
    expect(event["inputSpecialistCount"]).toBe(4)
    expect(event["inputFindingCount"]).toBe(9)
    expect(event["outputFindingCount"]).toBe(3)
    expect(event["modelUsed"]).toBe("kimi-k2.6:cloud")
  })

  it("emits retryOutcome when the synth retry fired", () => {
    emitSynthSummary(CTX, {
      elapsedMs: 215_000,
      attemptsUsed: 4,
      retryUsed: true,
      retryOutcome: "ok",
      inputSpecialistCount: 4,
      inputFindingCount: 12,
      outputFindingCount: 5,
      modelUsed: "kimi-k2.5:cloud",
    })
    expect(lastLogged()["retryOutcome"]).toBe("ok")
  })
})

// ─── do-review-run-timing ───────────────────────────────────────────

describe("emitDoReviewRunTiming", () => {
  it("emits the wall-clock breakdown around the ensemble run", () => {
    const timing: DoReviewRunTiming = {
      runId: "run-uuid-here",
      pickedUpAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_566_000,
      consumerWallMs: 566_000,
      finalState: "completed",
    }
    emitDoReviewRunTiming(CTX, timing)
    const event = lastLogged()
    expect(event["event"]).toBe("do-review-run-timing")
    expect(event["runId"]).toBe("run-uuid-here")
    expect(event["consumerWallMs"]).toBe(566_000)
    expect(event["finalState"]).toBe("completed")
  })
})
