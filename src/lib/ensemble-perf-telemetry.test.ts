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
  computeSpecialistFanoutSummary,
  narrowSynthRetryOutcome,
} from "@/lib/ensemble-perf-telemetry"

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

  it("includes inputTokens/outputTokens when supplied (SIG-212 token usage)", () => {
    // SIG-212: pin that token usage round-trips through the emitter. The
    // monitoring app's cost dashboard joins on `(model, role,
    // attemptIndex, inputTokens, outputTokens)`, so a future refactor
    // that drops these fields would silently break the cost metric.
    emitModelAttempt(CTX, {
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
      inputTokens: 1234,
      outputTokens: 567,
    })
    const event = lastLogged()
    expect(event["inputTokens"]).toBe(1234)
    expect(event["outputTokens"]).toBe(567)
  })

  it("omits token fields when not supplied (optional-field round-trip)", () => {
    // Non-Ollama providers and exception-path attempts both legitimately
    // omit token counts. The JSON output MUST distinguish "absent" from
    // "zero" so downstream aggregators don't conflate them.
    emitModelAttempt(CTX, {
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
    })
    const event = lastLogged()
    expect(event).not.toHaveProperty("inputTokens")
    expect(event).not.toHaveProperty("outputTokens")
  })

  it("includes only the token field that was supplied (one-sided round-trip)", () => {
    // Defensive: Ollama could theoretically report `prompt_eval_count`
    // but not `eval_count` (or vice versa) on a degenerate response.
    // Each field is independently optional.
    emitModelAttempt(CTX, {
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
      inputTokens: 1234,
    })
    const event = lastLogged()
    expect(event["inputTokens"]).toBe(1234)
    expect(event).not.toHaveProperty("outputTokens")
  })

  it("stamps every field on the ModelAttemptEvent (CR PR #95 catch — pin full shape)", () => {
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
    // Per CR's PR #95 nit: assert ALL ModelAttemptEvent fields so a
    // future rename / drop breaks here, not silently in downstream
    // log analyzers.
    expect(event["event"]).toBe("model-attempt-completed")
    expect(event["phase"]).toBe("synth")
    expect(event["role"]).toBe("synth")
    expect(event["attemptKind"]).toBe("retry")
    expect(event["attemptIndex"]).toBe(2)
    expect(event["model"]).toBe("kimi-k2.6:cloud")
    expect(event["timeoutMs"]).toBe(160_000)
    expect(event["startedAtMs"]).toBe(1_000)
    expect(event["endedAtMs"]).toBe(1_120)
    expect(event["elapsedMs"]).toBe(120)
    expect(event["outcome"]).toBe("ok")
    // Correlation fields.
    expect(event["owner"]).toBe("Arc-and-Anchor")
    expect(event["repo"]).toBe("sigilix")
    expect(event["prNumber"]).toBe(94)
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
  it("emits every field on the DoReviewRunTiming event (CR PR #95 catch — pin timestamps too)", () => {
    const timing: DoReviewRunTiming = {
      runId: "run-uuid-here",
      pickedUpAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_566_000,
      consumerWallMs: 566_000,
      finalState: "completed",
    }
    emitDoReviewRunTiming(CTX, timing)
    const event = lastLogged()
    // Per CR's PR #95 nit: the test creates timestamps as input but
    // didn't assert them in the emitted event. Pin all timestamps so
    // downstream log analyzers can rely on them.
    expect(event["event"]).toBe("do-review-run-timing")
    expect(event["runId"]).toBe("run-uuid-here")
    expect(event["pickedUpAtMs"]).toBe(1_700_000_000_000)
    expect(event["finishedAtMs"]).toBe(1_700_000_566_000)
    expect(event["consumerWallMs"]).toBe(566_000)
    expect(event["finalState"]).toBe("completed")
  })
})

// ─── narrowSynthRetryOutcome ───────────────────────────────────────

describe("narrowSynthRetryOutcome (Sigilix PR #95 catch)", () => {
  it("returns null when retry never fired (retryUsed === false)", () => {
    // Retry outcome is meaningless when no retry happened — even a
    // bogus value here must coerce to null.
    expect(narrowSynthRetryOutcome(false, "n/a")).toBeNull()
    expect(narrowSynthRetryOutcome(false, "ok")).toBeNull()
    expect(narrowSynthRetryOutcome(false, "exhausted-budget")).toBeNull()
  })

  it("returns null on the `n/a` sentinel (defensive — should be unreachable when retryUsed===true)", () => {
    expect(narrowSynthRetryOutcome(true, "n/a")).toBeNull()
  })

  it("returns null on the `exhausted-budget` sentinel (orchestrator-internal, not a model outcome)", () => {
    expect(narrowSynthRetryOutcome(true, "exhausted-budget")).toBeNull()
  })

  it("passes through every real model outcome unchanged", () => {
    expect(narrowSynthRetryOutcome(true, "ok")).toBe("ok")
    expect(narrowSynthRetryOutcome(true, "timeout")).toBe("timeout")
    expect(narrowSynthRetryOutcome(true, "parse")).toBe("parse")
    expect(narrowSynthRetryOutcome(true, "provenance")).toBe("provenance")
  })
})

// ─── computeSpecialistFanoutSummary ────────────────────────────────

describe("computeSpecialistFanoutSummary (Sigilix PR #95 catch)", () => {
  // Sample model lineup mirrors the production shape: each role has
  // a fallback model that's different from its primary. Tests use
  // synthetic model names so the helper's behavior is independent of
  // the real SPECIALIST_CONFIGS lineup.
  const inputs = [
    { role: "logic", verdictOk: true, attemptsUsed: 1, modelUsed: "logic-primary", fallbackModel: "logic-fallback" },
    { role: "security", verdictOk: true, attemptsUsed: 2, modelUsed: "security-fallback", fallbackModel: "security-fallback" }, // hit fallback
    { role: "performance", verdictOk: false, attemptsUsed: 3, modelUsed: "performance-fallback", fallbackModel: "performance-fallback" }, // hit fallback + failed
    { role: "tests", verdictOk: true, attemptsUsed: 1, modelUsed: "tests-primary", fallbackModel: "tests-fallback" },
  ]
  const dispatched = ["logic", "security", "performance", "tests"]
  const FANOUT_START = 1_000_000
  const FANOUT_END = 1_269_500

  it("identifies the slowest role by per-role elapsed", () => {
    const starts = new Map([
      ["logic", 1_000_500],
      ["security", 1_001_000],
      ["performance", 1_000_100],
      ["tests", 1_000_200],
    ])
    const ends = new Map([
      ["logic", 1_269_400],  // ~269s — slowest
      ["security", 1_120_000], // ~119s
      ["performance", 1_180_000], // ~180s
      ["tests", 1_050_000],  // ~50s
    ])
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: dispatched,
      inputs,
      perRoleStartMs: starts,
      perRoleEndMs: ends,
      fanoutStartMs: FANOUT_START,
      fanoutEndMs: FANOUT_END,
    })
    expect(summary.slowestRole).toBe("logic")
    expect(summary.slowestElapsedMs).toBe(268_900)
  })

  it("falls back to fanoutEndMs when a role aborted before recording its end", () => {
    // `logic` got aborted on the outer signal — no end recorded. The
    // helper treats that as "ended at the fanout end" so the role's
    // elapsed is an over-estimate, never an under-estimate.
    const starts = new Map([["logic", 1_000_500], ["tests", 1_000_200]])
    const ends = new Map([["tests", 1_050_000]])
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: ["logic", "tests"],
      inputs: [
        { role: "logic", verdictOk: false, attemptsUsed: 1, modelUsed: undefined, fallbackModel: null },
        { role: "tests", verdictOk: true, attemptsUsed: 1, modelUsed: "tests-primary", fallbackModel: "tests-fallback" },
      ],
      perRoleStartMs: starts,
      perRoleEndMs: ends,
      fanoutStartMs: FANOUT_START,
      fanoutEndMs: FANOUT_END,
    })
    // logic: fanout_end - logic_start = 1_269_500 - 1_000_500 = 269_000
    // tests: 1_050_000 - 1_000_200 = 49_800
    expect(summary.slowestRole).toBe("logic")
    expect(summary.slowestElapsedMs).toBe(269_000)
  })

  it("counts totalAttemptsUsed across all dispatched roles, defaulting to 1 when undefined", () => {
    const starts = new Map(dispatched.map((r) => [r, FANOUT_START]))
    const ends = new Map(dispatched.map((r) => [r, FANOUT_END]))
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: dispatched,
      inputs,
      perRoleStartMs: starts,
      perRoleEndMs: ends,
      fanoutStartMs: FANOUT_START,
      fanoutEndMs: FANOUT_END,
    })
    // 1 + 2 + 3 + 1 = 7
    expect(summary.totalAttemptsUsed).toBe(7)
  })

  it("counts fallbacksUsed as the number of roles whose modelUsed === fallbackModel", () => {
    const starts = new Map(dispatched.map((r) => [r, FANOUT_START]))
    const ends = new Map(dispatched.map((r) => [r, FANOUT_END]))
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: dispatched,
      inputs,
      perRoleStartMs: starts,
      perRoleEndMs: ends,
      fanoutStartMs: FANOUT_START,
      fanoutEndMs: FANOUT_END,
    })
    // security + performance both hit fallback.
    expect(summary.fallbacksUsed).toBe(2)
  })

  it("splits roles into succeededRoles / failedRoles by verdictOk", () => {
    const starts = new Map(dispatched.map((r) => [r, FANOUT_START]))
    const ends = new Map(dispatched.map((r) => [r, FANOUT_END]))
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: dispatched,
      inputs,
      perRoleStartMs: starts,
      perRoleEndMs: ends,
      fanoutStartMs: FANOUT_START,
      fanoutEndMs: FANOUT_END,
    })
    expect(summary.succeededRoles).toEqual(["logic", "security", "tests"])
    expect(summary.failedRoles).toEqual(["performance"])
  })

  it("returns slowestRole=null when no roles were dispatched", () => {
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: [],
      inputs: [],
      perRoleStartMs: new Map(),
      perRoleEndMs: new Map(),
      fanoutStartMs: 0,
      fanoutEndMs: 0,
    })
    expect(summary.slowestRole).toBeNull()
    expect(summary.slowestElapsedMs).toBe(0)
    expect(summary.totalAttemptsUsed).toBe(0)
    expect(summary.fallbacksUsed).toBe(0)
  })

  it("does not count a role as a fallback when modelUsed matches but fallbackModel is null", () => {
    const summary = computeSpecialistFanoutSummary({
      dispatchedRoles: ["logic"],
      inputs: [{ role: "logic", verdictOk: true, attemptsUsed: 1, modelUsed: "logic-primary", fallbackModel: null }],
      perRoleStartMs: new Map([["logic", 0]]),
      perRoleEndMs: new Map([["logic", 100]]),
      fanoutStartMs: 0,
      fanoutEndMs: 100,
    })
    expect(summary.fallbacksUsed).toBe(0)
  })
})
