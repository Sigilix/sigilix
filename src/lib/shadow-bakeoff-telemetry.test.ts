// tests/shadow-bakeoff-telemetry.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import {
  buildShadowVerdictComparison,
  emitShadowAttempt,
  emitShadowCutShort,
  emitShadowRunFailed,
  emitShadowVerdictComparison,
  computeFindingsOverlap,
  type ProdOutcomeForComparison,
  type ShadowAttemptEvent,
  type ShadowOutcomeForComparison,
  type ShadowVerdictComparison,
} from "@/src/lib/shadow-bakeoff-telemetry"

const CTX: EnsembleRunCtx = {
  owner: "Sigilix",
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
    expect(event["owner"]).toBe("Sigilix")
    expect(event["headSha"]).toBe("feedfac")
    expect(event["role"]).toBe("synth")
    expect(event["attemptKind"]).toBe("primary")
    expect(event["model"]).toBe("deepseek-v4-flash:cloud")
    expect(event["outcome"]).toBe("ok")
    expect(event).not.toHaveProperty("failureReason")
  })

  it("includes inputTokens/outputTokens when supplied (SIG-212 token usage)", () => {
    // SIG-212: shadow attempts mirror the prod `model-attempt-completed`
    // token-usage shape so a single monitoring-app aggregation can join
    // prod + shadow records on `(role, attemptKind, attemptIndex)` and
    // sum token cost across both paths.
    emitShadowAttempt(CTX, {
      role: "synth",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "deepseek-v4-flash:cloud",
      timeoutMs: 60_000,
      startedAtMs: 1_000,
      endedAtMs: 1_500,
      elapsedMs: 500,
      outcome: "ok",
      inputTokens: 2048,
      outputTokens: 256,
    })
    const event = lastLogged()
    expect(event["inputTokens"]).toBe(2048)
    expect(event["outputTokens"]).toBe(256)
  })

  it("omits token fields when not supplied (optional-field round-trip)", () => {
    emitShadowAttempt(CTX, {
      role: "synth",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "deepseek-v4-flash:cloud",
      timeoutMs: 60_000,
      startedAtMs: 1_000,
      endedAtMs: 1_500,
      elapsedMs: 500,
      outcome: "ok",
    })
    const event = lastLogged()
    expect(event).not.toHaveProperty("inputTokens")
    expect(event).not.toHaveProperty("outputTokens")
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

describe("emitShadowCutShort", () => {
  it("emits a shadow-cut-short event with role + elapsedAtCutMs + reason + correlation fields", () => {
    emitShadowCutShort(CTX, { role: "synth", elapsedAtCutMs: 5_000, reason: "grace_deadline" })
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-cut-short")
    expect(event["role"]).toBe("synth")
    expect(event["elapsedAtCutMs"]).toBe(5_000)
    expect(event["reason"]).toBe("grace_deadline")
    expect(event["owner"]).toBe("Sigilix")
    expect(event["repo"]).toBe("sigilix")
    expect(event["prNumber"]).toBe(99)
    expect(event["headSha"]).toBe("feedfac")
  })

  it("emits reason='orch_aborted' when the outer orchestrator aborted before grace fired", () => {
    emitShadowCutShort(CTX, { role: "logic", elapsedAtCutMs: 2_500, reason: "orch_aborted" })
    const event = lastLogged()
    expect(event["reason"]).toBe("orch_aborted")
  })
})

describe("emitShadowRunFailed", () => {
  // ARC-283 Phase B1b CR-1: split from emitShadowCutShort so a real
  // runner crash is visible in dashboards instead of being hidden in
  // the cut-short bucket.
  it("emits a shadow-run-failed event with role + message + correlation fields", () => {
    emitShadowRunFailed(CTX, { role: "synth", message: "TypeError: cannot read 'foo' of undefined" })
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-run-failed")
    expect(event["role"]).toBe("synth")
    expect(event["message"]).toBe("TypeError: cannot read 'foo' of undefined")
    expect(event["owner"]).toBe("Sigilix")
    expect(event["repo"]).toBe("sigilix")
    expect(event["prNumber"]).toBe(99)
    // headSha truncated to 7 chars (correlation-field invariant).
    expect(event["headSha"]).toBe("feedfac")
  })

  it("truncates headSha to 7 chars (correlation-field invariant)", () => {
    emitShadowRunFailed(
      { owner: "o", repo: "r", prNumber: 1, headSha: "0123456789abcdef" },
      { role: "logic", message: "boom" },
    )
    const event = lastLogged()
    expect(event["headSha"]).toBe("0123456")
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
      // SIG-86: score-3 finding doesn't contribute to score-4+ counts.
      score4PlusOverlapCount: 0,
      score4PlusProdOnlyCount: 0,
      score4PlusShadowOnlyCount: 0,
      score4PlusProdFindingsCount: 0,
      score4PlusShadowFindingsCount: 0,
    })
    expect(computeFindingsOverlap([f("a.ts", 1, "logic", 3)], [])).toEqual({
      overlapCount: 0, prodOnlyCount: 1, shadowOnlyCount: 0,
      prodScoreHistogram: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
      shadowScoreHistogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      score4PlusOverlapCount: 0,
      score4PlusProdOnlyCount: 0,
      score4PlusShadowOnlyCount: 0,
      score4PlusProdFindingsCount: 0,
      score4PlusShadowFindingsCount: 0,
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

  // SIG-86 (Codex Q4): score-4+ filtered overlap. The B1c aggregator's
  // main overlap-with-prod ratio is computed on score-4+ findings only.
  describe("SIG-86 score-4+ filtered overlap", () => {
    it("counts only score-4-and-above findings; ignores score 1-3", () => {
      const result = computeFindingsOverlap(
        [f("a.ts", 1, "logic", 5), f("a.ts", 2, "logic", 3), f("a.ts", 3, "logic", 4)],
        [f("a.ts", 1, "logic", 5), f("a.ts", 4, "logic", 2), f("a.ts", 5, "logic", 4)],
      )
      // Overall overlap: a.ts:1:logic (prod 5 / shadow 5) → 1.
      expect(result.overlapCount).toBe(1)
      // Score-4+ prod set: a.ts:1, a.ts:3. Score-4+ shadow set: a.ts:1, a.ts:5.
      // Overlap: a.ts:1 only → 1.
      expect(result.score4PlusOverlapCount).toBe(1)
      expect(result.score4PlusProdOnlyCount).toBe(1) // a.ts:3 in prod only
      expect(result.score4PlusShadowOnlyCount).toBe(1) // a.ts:5 in shadow only
      expect(result.score4PlusProdFindingsCount).toBe(2) // scores 5, 4
      expect(result.score4PlusShadowFindingsCount).toBe(2) // scores 5, 4
    })

    it("emits 0/0/0/0/0 when neither side has any score-4+ findings", () => {
      const result = computeFindingsOverlap(
        [f("a.ts", 1, "logic", 2), f("b.ts", 1, "logic", 3)],
        [f("c.ts", 1, "security", 1)],
      )
      // Main overlap still computed.
      expect(result.overlapCount).toBe(0)
      expect(result.prodOnlyCount).toBe(2)
      expect(result.shadowOnlyCount).toBe(1)
      // Score-4+ counts all zero — aggregator treats this PR as
      // "no decision-weight findings on this comparison".
      expect(result.score4PlusOverlapCount).toBe(0)
      expect(result.score4PlusProdOnlyCount).toBe(0)
      expect(result.score4PlusShadowOnlyCount).toBe(0)
      expect(result.score4PlusProdFindingsCount).toBe(0)
      expect(result.score4PlusShadowFindingsCount).toBe(0)
    })

    it("dedupes by tuple within the score-4+ subset (same line + category + 2 high scores → 1 entry)", () => {
      const result = computeFindingsOverlap(
        // Same tuple appears twice at score 4 and 5 — dedup to 1 set entry.
        [f("a.ts", 10, "logic", 4), f("a.ts", 10, "logic", 5)],
        [f("a.ts", 10, "logic", 4)],
      )
      expect(result.score4PlusOverlapCount).toBe(1)
      expect(result.score4PlusProdOnlyCount).toBe(0)
      expect(result.score4PlusShadowOnlyCount).toBe(0)
      // Findings-count is BEFORE tuple dedup — preserves "this model
      // is spammy on the same tuple" signal.
      expect(result.score4PlusProdFindingsCount).toBe(2)
      expect(result.score4PlusShadowFindingsCount).toBe(1)
    })

    it("score 4 finding in prod + score 3 finding in shadow on the same tuple is prod-only at score-4+", () => {
      const result = computeFindingsOverlap(
        [f("x.ts", 1, "logic", 4)],
        [f("x.ts", 1, "logic", 3)],
      )
      // Overall: same (path, line, category) → 1 overlap.
      expect(result.overlapCount).toBe(1)
      // Score-4+: prod side has it, shadow side does NOT.
      expect(result.score4PlusOverlapCount).toBe(0)
      expect(result.score4PlusProdOnlyCount).toBe(1)
      expect(result.score4PlusShadowOnlyCount).toBe(0)
    })
  })
})

describe("buildShadowVerdictComparison", () => {
  const finding = (path: string, line: number, category: string, score: number) =>
    ({ path, line, category, score })

  const okProd = (overrides: Partial<ProdOutcomeForComparison> = {}): ProdOutcomeForComparison => ({
    verdictOk: true,
    modelUsed: "kimi-k2.6:cloud",
    attemptsUsed: 1,
    elapsedMs: 52_000,
    findings: [finding("src/a.ts", 10, "logic", 4)],
    ...overrides,
  })

  const okShadow = (overrides: Partial<ShadowOutcomeForComparison> = {}): ShadowOutcomeForComparison => ({
    verdictOk: true,
    modelUsed: "deepseek-v4-flash:cloud",
    attemptsUsed: 1,
    elapsedMs: 41_000,
    findings: [finding("src/a.ts", 10, "logic", 4)],
    ...overrides,
  })

  it("builds an apples-to-apples comparison payload from prod + shadow outcomes", () => {
    const result = buildShadowVerdictComparison({
      role: "synth",
      prodModelDefault: "kimi-k2.6:cloud",
      prod: okProd({ findings: [finding("src/a.ts", 1, "logic", 3)] }),
      shadow: okShadow({ findings: [finding("src/a.ts", 1, "logic", 4)] }),
    })
    expect(result.role).toBe("synth")
    expect(result.prodModel).toBe("kimi-k2.6:cloud")
    expect(result.shadowModel).toBe("deepseek-v4-flash:cloud")
    expect(result.prodVerdictOk).toBe(true)
    expect(result.shadowVerdictOk).toBe(true)
    expect(result.overlapCount).toBe(1)
    expect(result.prodOnlyCount).toBe(0)
    expect(result.shadowOnlyCount).toBe(0)
    expect(result.shadowFailureReason).toBeNull()
  })

  it("passes through prod attempts + elapsed unchanged", () => {
    const result = buildShadowVerdictComparison({
      role: "logic",
      prodModelDefault: "deepseek-v4-pro:cloud",
      prod: okProd({ attemptsUsed: 3, elapsedMs: 180_000 }),
      shadow: okShadow({ attemptsUsed: 2, elapsedMs: 95_000 }),
    })
    expect(result.prodAttemptsUsed).toBe(3)
    expect(result.prodElapsedMs).toBe(180_000)
    expect(result.shadowAttemptsUsed).toBe(2)
    expect(result.shadowElapsedMs).toBe(95_000)
  })

  it("counts findings on both sides + computes histogram from un-deduped originals", () => {
    const result = buildShadowVerdictComparison({
      role: "security",
      prodModelDefault: "qwen3-coder-next:cloud",
      prod: okProd({
        findings: [
          finding("src/a.ts", 1, "security", 5),
          finding("src/a.ts", 1, "security", 5), // same tuple — dedup'd in overlap, NOT in histogram
          finding("src/b.ts", 2, "security", 2),
        ],
      }),
      shadow: okShadow({ findings: [] }),
    })
    expect(result.prodFindingsCount).toBe(3)
    expect(result.shadowFindingsCount).toBe(0)
    expect(result.prodOnlyCount).toBe(2) // 2 unique tuples in prod
    expect(result.shadowOnlyCount).toBe(0)
    expect(result.prodScoreHistogram).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 2 })
    expect(result.shadowScoreHistogram).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  })

  it("falls back to prodModelDefault when prod failed before modelUsed could be set", () => {
    const result = buildShadowVerdictComparison({
      role: "tests",
      prodModelDefault: "qwen3-coder-next:cloud",
      prod: {
        verdictOk: false,
        modelUsed: "", // empty — orchestrator collected before runSpecialist returned
        attemptsUsed: 0,
        elapsedMs: 0,
        findings: [],
      },
      shadow: okShadow({ findings: [] }),
    })
    expect(result.prodVerdictOk).toBe(false)
    expect(result.prodModel).toBe("qwen3-coder-next:cloud")
  })

  it("uses prod.modelUsed when present even on prod failure (records which model was last-attempted)", () => {
    const result = buildShadowVerdictComparison({
      role: "logic",
      prodModelDefault: "deepseek-v4-pro:cloud",
      prod: {
        verdictOk: false,
        modelUsed: "kimi-k2.5:cloud", // fallback fired but also failed
        attemptsUsed: 3,
        elapsedMs: 200_000,
        findings: [],
      },
      shadow: okShadow(),
    })
    expect(result.prodVerdictOk).toBe(false)
    expect(result.prodModel).toBe("kimi-k2.5:cloud")
  })

  it("populates shadowFailureReason from the shadow runner on shadow failure", () => {
    const result = buildShadowVerdictComparison({
      role: "synth",
      prodModelDefault: "kimi-k2.6:cloud",
      prod: okProd(),
      shadow: {
        verdictOk: false,
        modelUsed: "deepseek-v4-flash:cloud",
        attemptsUsed: 2,
        elapsedMs: 60_000,
        findings: [],
        failureReason: "per_attempt_timeout",
      },
    })
    expect(result.shadowVerdictOk).toBe(false)
    expect(result.shadowFailureReason).toBe("per_attempt_timeout")
    expect(result.shadowFindingsCount).toBe(0)
  })

  it("defaults shadowFailureReason to 'unknown' when shadow failed without a reason", () => {
    // Defensive — runWithRetryAndFallback always populates a reason
    // today, but the helper stays robust to future shape drift.
    const result = buildShadowVerdictComparison({
      role: "performance",
      prodModelDefault: "glm-5.1:cloud",
      prod: okProd(),
      shadow: {
        verdictOk: false,
        modelUsed: "glm-5.1:cloud",
        attemptsUsed: 1,
        elapsedMs: 30_000,
        findings: [],
      },
    })
    expect(result.shadowFailureReason).toBe("unknown")
  })

  it("returns null shadowFailureReason when shadow succeeded (event emitter treats null as success-signal)", () => {
    const result = buildShadowVerdictComparison({
      role: "synth",
      prodModelDefault: "kimi-k2.6:cloud",
      prod: okProd(),
      shadow: okShadow(),
    })
    expect(result.shadowFailureReason).toBeNull()
  })
})
