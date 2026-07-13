// SIG-287/SIG-114 recall alarm — the smoke detector that would have caught the
// bare-approve regression in one cron tick instead of 12 PRs.

import { describe, it, expect } from "vitest"
import {
  detectRecallAlarm,
  recallOutcomeFromTelemetry,
  RECALL_LOGIC_DEGRADED_ALARM_STREAK,
  RECALL_SYNTH_ZERO_FINDING_ALARM_STREAK,
  type RecallReviewOutcome,
} from "@/src/lib/recall-alarm"

function o(prNumber: number, over: Partial<RecallReviewOutcome> = {}): RecallReviewOutcome {
  return { prNumber, logicMissing: false, synthFindingCount: 3, ...over }
}

describe("detectRecallAlarm", () => {
  it("pins the streak thresholds", () => {
    expect(RECALL_LOGIC_DEGRADED_ALARM_STREAK).toBe(3)
    expect(RECALL_SYNTH_ZERO_FINDING_ALARM_STREAK).toBe(5)
  })

  it("no alarm on healthy reviews", () => {
    const r = detectRecallAlarm([o(10), o(9), o(8), o(7), o(6)])
    expect(r.alarms).toHaveLength(0)
    expect(r.logicDegradedStreak).toBe(0)
    expect(r.synthZeroFindingStreak).toBe(0)
  })

  it("fires the logic-degraded alarm on a 3-PR streak (the SIG-287 signature)", () => {
    const r = detectRecallAlarm([
      o(12, { logicMissing: true, synthFindingCount: 0 }),
      o(11, { logicMissing: true, synthFindingCount: 0 }),
      o(10, { logicMissing: true, synthFindingCount: 1 }),
      o(9), // healthy — ends the streak
    ])
    const logic = r.alarms.find((a) => a.kind === "logic-degraded-streak")
    expect(logic).toBeDefined()
    expect(logic?.streak).toBe(3)
    expect(logic?.prNumbers).toEqual([12, 11, 10])
  })

  it("does NOT fire below the logic threshold (2 < 3)", () => {
    const r = detectRecallAlarm([
      o(12, { logicMissing: true }),
      o(11, { logicMissing: true }),
      o(10), // healthy
    ])
    expect(r.logicDegradedStreak).toBe(2)
    expect(r.alarms.find((a) => a.kind === "logic-degraded-streak")).toBeUndefined()
  })

  it("only counts the LEADING (newest) run — a healthy newest review clears the alarm", () => {
    const r = detectRecallAlarm([
      o(13), // newest healthy
      o(12, { logicMissing: true }),
      o(11, { logicMissing: true }),
      o(10, { logicMissing: true }),
    ])
    expect(r.logicDegradedStreak).toBe(0)
    expect(r.alarms).toHaveLength(0)
  })

  it("fires the synth-zero-finding alarm on a 5-PR shutout", () => {
    const r = detectRecallAlarm([
      o(20, { synthFindingCount: 0 }),
      o(19, { synthFindingCount: 0 }),
      o(18, { synthFindingCount: 0 }),
      o(17, { synthFindingCount: 0 }),
      o(16, { synthFindingCount: 0 }),
      o(15, { synthFindingCount: 2 }),
    ])
    const synth = r.alarms.find((a) => a.kind === "synth-zero-finding-streak")
    expect(synth?.streak).toBe(5)
    expect(synth?.prNumbers).toEqual([20, 19, 18, 17, 16])
  })

  it("can fire BOTH alarms at once (degraded + shutout)", () => {
    const outcomes = [0, 1, 2, 3, 4].map((i) => o(30 - i, { logicMissing: true, synthFindingCount: 0 }))
    const r = detectRecallAlarm(outcomes)
    expect(r.alarms.map((a) => a.kind).sort()).toEqual(["logic-degraded-streak", "synth-zero-finding-streak"])
  })

  it("respects config overrides", () => {
    const r = detectRecallAlarm([o(2, { logicMissing: true }), o(1, { logicMissing: true })], {
      logicDegradedStreak: 2,
    })
    expect(r.alarms.find((a) => a.kind === "logic-degraded-streak")?.streak).toBe(2)
  })
})

describe("recallOutcomeFromTelemetry", () => {
  it("maps a degraded (logic-missing) review with the synth's finding count", () => {
    expect(
      recallOutcomeFromTelemetry({
        prNumber: 218,
        synthesizer: { verdict: { findings: [] } },
        degradedCoverage: { rolesMissing: ["logic"] },
      }),
    ).toEqual({ prNumber: 218, logicMissing: true, synthFindingCount: 0 })
  })

  it("maps a healthy full-coverage review (no degradedCoverage)", () => {
    expect(
      recallOutcomeFromTelemetry({
        prNumber: 206,
        synthesizer: { verdict: { findings: [{}, {}, {}] } },
        degradedCoverage: null,
      }),
    ).toEqual({ prNumber: 206, logicMissing: false, synthFindingCount: 3 })
  })

  it("skips non-reviews (merge-guard / bail records with no synth verdict) → null", () => {
    expect(recallOutcomeFromTelemetry({ prNumber: 216, synthesizer: null })).toBeNull()
    expect(recallOutcomeFromTelemetry({ prNumber: 216 })).toBeNull()
    expect(recallOutcomeFromTelemetry({ synthesizer: { verdict: { findings: [] } } })).toBeNull()
  })

  it("accepts legacy GitHub rows but excludes explicit GitLab telemetry", () => {
    const base = { prNumber: 216, synthesizer: { verdict: { findings: [] } } }
    expect(recallOutcomeFromTelemetry(base)).not.toBeNull()
    expect(recallOutcomeFromTelemetry({ ...base, scmProvider: "github" })).not.toBeNull()
    expect(recallOutcomeFromTelemetry({ ...base, scmProvider: "gitlab" })).toBeNull()
  })

  it("treats a non-logic missing role as not-logic-degraded", () => {
    expect(
      recallOutcomeFromTelemetry({
        prNumber: 7,
        synthesizer: { verdict: { findings: [{}] } },
        degradedCoverage: { rolesMissing: ["tests"] },
      }),
    ).toMatchObject({ logicMissing: false, synthFindingCount: 1 })
  })
})
