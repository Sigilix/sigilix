// Validates the PTS continuity scorer, aggregation/CI math, the compactor seam, and the
// run loop WITHOUT a model — so the harness plumbing is regression-guarded in CI. The real
// baseline (which calls a live model) is `npm run pts-continuity-eval` with a provider key.

import { describe, it, expect, afterEach } from "vitest"
import {
  CONTINUITY_SCENARIOS,
  matchesAnyAnchor,
  scoreProbe,
  scoreTask,
  retentionScore,
  meanCI,
  aggregateCondition,
  deltaCI,
  type Probe,
  type RunMetrics,
} from "./pts-continuity-corpus"
import {
  runContinuitySession,
  identityCompactor,
  naiveSummaryCompactor,
  resolveTreatmentCompactor,
  registerTreatmentCompactor,
  standardConditions,
  __resetTreatmentCompactorsForTest,
  type ModelClient,
  type Compactor,
} from "./pts-continuity-harness"
import { buildScorecard, formatScorecard } from "./pts-continuity-scorecard"

const bugHunt = CONTINUITY_SCENARIOS.find((s) => s.id === "double-charge-bug-hunt")!
const callDrop = CONTINUITY_SCENARIOS.find((s) => s.id === "asterisk-32s-call-drop")!

// ─── anchor matching + probe/task scoring ───

describe("anchor matching", () => {
  it("matches case-insensitively on any anchor", () => {
    expect(matchesAnyAnchor("The IDEMPOTENCY key", ["idempoten"])).toBe(true)
    expect(matchesAnyAnchor("nothing here", ["idempoten"])).toBe(false)
    expect(matchesAnyAnchor("has event.id somewhere", ["missing", "event.id"])).toBe(true)
  })
})

describe("probe scoring", () => {
  const probe: Probe = {
    id: "p",
    kind: "constraint",
    question: "q",
    facts: [
      { id: "a", anchors: ["alpha"] },
      { id: "b", anchors: ["bravo", "b-word"] },
      { id: "c", anchors: ["charlie"] },
    ],
  }
  it("recalls a fact when any anchor is present, misses otherwise", () => {
    const s = scoreProbe(probe, "we ruled out alpha and the b-word entirely")
    expect(s.recalled).toBe(2)
    expect(s.total).toBe(3)
    expect(s.hitFactIds).toEqual(["a", "b"])
    expect(s.missedFactIds).toEqual(["c"])
  })
  it("zero recall on an empty answer", () => {
    expect(scoreProbe(probe, "").recalled).toBe(0)
  })
})

describe("task scoring", () => {
  it("success requires EVERY criterion group to land", () => {
    const good =
      "Root cause: missing idempotency check; on a retried webhook (event.id) it double-charges. Fix in webhook.ts."
    expect(scoreTask(bugHunt, good).success).toBe(true)
  })
  it("fails when a criterion group is missing", () => {
    // no fix-location anchor -> not all groups satisfied
    const partial = "Root cause is a missing idempotency check on a retried delivery."
    const r = scoreTask(bugHunt, partial)
    expect(r.success).toBe(false)
    expect(r.matched).toBeLessThan(r.total)
  })
})

describe("anchor validity — a state-LOST re-derivation must NOT score retention (P1 guard)", () => {
  // The benchmark exists to measure working state LOST at compaction. If a model that
  // retained nothing can satisfy anchors by re-deriving the textbook fix, Control-B looks
  // like Control-A and the A-B delta (the headline number) collapses. This asserts the
  // anchors are session-specific: a plausible generic answer scores ~0 retention.
  const rederived =
    "The standard fix for double charges is to make the webhook handler idempotent and guard " +
    "before creating the charge; also be careful not to break refunds. Return a success ack so " +
    "the provider stops retrying. Key the operation on an idempotency key."
  it("a generic re-derived answer recalls no session-specific fact on any bug-hunt probe", () => {
    const scores = bugHunt.probes.map((pr) => scoreProbe(pr, rederived))
    // Not a single session-specific evidence phrase (one /api/pay, before any insert,
    // charge.refunded, setnx, event.id, ...) appears in a purely re-derived answer.
    expect(retentionScore(scores)).toBeLessThanOrEqual(0.1)
  })
  it("but the actual established evidence DOES recall its facts (anchors aren't dead)", () => {
    const grounded =
      "Ruled out: only one /api/pay fires per checkout even on rage-clicks; the charge.refunded " +
      "path must keep working; the guard is a setnx keyed on event.id."
    const scores = bugHunt.probes.map((pr) => scoreProbe(pr, grounded))
    expect(retentionScore(scores)).toBeGreaterThan(0.3)
  })

  // Same guard for the causal-trace scenario — its domain terms (rtp, nat, carrier, pjsip)
  // are the most re-derivable in the corpus, so it needs the tightest anti-cheat check.
  const rederivedCallDrop =
    "For a call dropping mid-session, I'd check for an RTP media timeout, a NAT keepalive " +
    "issue, a transport reset, or a dialplan hangup. Likely SIP session-timers — disable them " +
    "on the pjsip endpoint. The carrier probably drops the refresh."
  it("a generic re-derived answer recalls no session-specific fact on any call-drop probe", () => {
    const scores = callDrop.probes.map((pr) => scoreProbe(pr, rederivedCallDrop))
    expect(retentionScore(scores)).toBeLessThanOrEqual(0.1)
  })
  it("the established call-drop evidence DOES recall its facts", () => {
    const grounded =
      "Ruled out RTP: it flows continuously, rtptimeout is 60s. We send the BYE (no ICMP). No L " +
      "option on Dial(). We (the UAC) are the refresher; 32 is session-expires/2; the carrier " +
      "will not respond, so scope timers=no to the carrierX endpoint in pjsip.conf."
    const scores = callDrop.probes.map((pr) => scoreProbe(pr, grounded))
    expect(retentionScore(scores)).toBeGreaterThan(0.3)
  })
})

describe("retention score", () => {
  it("is recalled/total across all probes", () => {
    const scores = [
      { probeId: "x", kind: "constraint" as const, recalled: 2, total: 4, hitFactIds: [], missedFactIds: [] },
      { probeId: "y", kind: "decision" as const, recalled: 1, total: 2, hitFactIds: [], missedFactIds: [] },
    ]
    expect(retentionScore(scores)).toBeCloseTo(3 / 6, 6)
  })
  it("is 0 when there are no facts", () => {
    expect(retentionScore([])).toBe(0)
  })
})

// ─── stats: meanCI / aggregate / deltaCI ───

describe("meanCI", () => {
  it("point value with zero-width CI for n=1", () => {
    const c = meanCI([0.5])
    expect(c.mean).toBe(0.5)
    expect(c.lo).toBe(0.5)
    expect(c.hi).toBe(0.5)
    expect(c.n).toBe(1)
  })
  it("computes a symmetric normal-approx CI for n>1", () => {
    const c = meanCI([0, 1, 0, 1])
    expect(c.mean).toBeCloseTo(0.5, 6)
    expect(c.hi - c.mean).toBeCloseTo(c.mean - c.lo, 9)
    expect(c.lo).toBeLessThan(c.mean)
    expect(c.hi).toBeGreaterThan(c.mean)
  })
  it("empty -> all zero", () => {
    expect(meanCI([])).toEqual({ mean: 0, lo: 0, hi: 0, sd: 0, n: 0 })
  })
})

describe("aggregateCondition", () => {
  const mk = (over: Partial<RunMetrics>): RunMetrics => ({
    taskSuccess: false,
    retention: 0,
    tokens: 0,
    latencyMs: 0,
    probeScores: [],
    errored: false,
    ...over,
  })
  it("drops errored runs from the means but counts them", () => {
    const agg = aggregateCondition("control-a", [
      mk({ taskSuccess: true, retention: 1, tokens: 100 }),
      mk({ taskSuccess: true, retention: 1, tokens: 200 }),
      mk({ errored: true, retention: 0, tokens: 0 }),
    ])
    expect(agg.n).toBe(2)
    expect(agg.errored).toBe(1)
    expect(agg.retention.mean).toBe(1)
    expect(agg.taskSuccessRate.mean).toBe(1)
    expect(agg.tokens.mean).toBe(150)
  })
})

describe("deltaCI", () => {
  it("delta is target-baseline with a widened CI", () => {
    const target = meanCI([1, 1, 1, 1])
    const baseline = meanCI([0, 0, 1, 0])
    const d = deltaCI(target, baseline)
    expect(d.delta).toBeCloseTo(1 - 0.25, 6)
    expect(d.hi).toBeGreaterThan(d.delta)
    expect(d.lo).toBeLessThan(d.delta)
  })
})

// ─── corpus shape ───

describe("corpus shape", () => {
  it("has >=2 scenarios spanning both kinds", () => {
    expect(CONTINUITY_SCENARIOS.length).toBeGreaterThanOrEqual(2)
    const kinds = new Set(CONTINUITY_SCENARIOS.map((s) => s.kind))
    expect(kinds.has("multi-file-bug-hunt")).toBe(true)
    expect(kinds.has("long-causal-trace")).toBe(true)
  })
  it("every scenario has probes across all three kinds and >=1 success criterion", () => {
    for (const s of CONTINUITY_SCENARIOS) {
      const kinds = new Set(s.probes.map((p) => p.kind))
      expect(kinds.has("ruled-out-hypothesis"), s.id).toBe(true)
      expect(kinds.has("constraint"), s.id).toBe(true)
      expect(kinds.has("decision"), s.id).toBe(true)
      expect(s.success.length, s.id).toBeGreaterThanOrEqual(1)
    }
  })
  it("build-up is large enough to force a real mid-task compaction", () => {
    for (const s of CONTINUITY_SCENARIOS) {
      const chars = s.buildup.reduce((n, b) => n + b.length, 0)
      expect(chars, s.id).toBeGreaterThanOrEqual(s.minBuildupChars)
    }
  })
  it("scenario + probe + fact ids are unique within each scenario", () => {
    expect(new Set(CONTINUITY_SCENARIOS.map((s) => s.id)).size).toBe(CONTINUITY_SCENARIOS.length)
    for (const s of CONTINUITY_SCENARIOS) {
      const probeIds = s.probes.map((p) => p.id)
      expect(new Set(probeIds).size, s.id).toBe(probeIds.length)
      for (const p of s.probes) {
        const factIds = p.facts.map((f) => f.id)
        expect(new Set(factIds).size, `${s.id}/${p.id}`).toBe(factIds.length)
      }
    }
  })
})

// ─── run loop (scripted model client — no network) ───

/** A deterministic client: `answerFor` maps the LAST user message to a reply; every call
 *  costs fixed tokens so the metering is checkable. */
function scriptedClient(answerFor: (lastUser: string) => string, calls?: { count: number }): ModelClient {
  return {
    async send(messages) {
      if (calls) calls.count++
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
      return { text: answerFor(lastUser), inputTokens: 10, outputTokens: 5, latencyMs: 3 }
    },
  }
}

/** Perfect-memory client: on a probe/final question it echoes every anchor of every fact +
 *  success criterion, so retention and task-success are 1 by construction. */
function perfectMemoryReply(scenarioId: string): (lastUser: string) => string {
  const s = CONTINUITY_SCENARIOS.find((x) => x.id === scenarioId)!
  const allAnchors = [
    ...s.probes.flatMap((p) => p.facts.map((f) => f.anchors[0])),
    ...s.success.map((c) => c.anchors[0]),
  ].join(" ; ")
  return () => `Recalled state: ${allAnchors}`
}

describe("runContinuitySession (scripted client)", () => {
  it("identity compactor + perfect-memory client -> retention 1, success, no error", async () => {
    const calls = { count: 0 }
    const model = { ...scriptedClient(perfectMemoryReply(bugHunt.id), calls) }
    const m = await runContinuitySession({ scenario: bugHunt, compactor: identityCompactor, model })
    expect(m.errored).toBe(false)
    expect(m.retention).toBe(1)
    expect(m.taskSuccess).toBe(true)
    // build-up turns (task + N observations) + probes + final = every call metered
    const expectedCalls = 1 + bugHunt.buildup.length + bugHunt.probes.length + 1
    expect(calls.count).toBe(expectedCalls)
    expect(m.tokens).toBe(expectedCalls * 15)
    expect(m.latencyMs).toBe(expectedCalls * 3)
  })

  it("naive-summary compactor adds exactly one metered model call", async () => {
    const calls = { count: 0 }
    const model = scriptedClient(perfectMemoryReply(bugHunt.id), calls)
    await runContinuitySession({ scenario: bugHunt, compactor: naiveSummaryCompactor, model })
    const expectedCalls = 1 + bugHunt.buildup.length + 1 /* summary */ + bugHunt.probes.length + 1
    expect(calls.count).toBe(expectedCalls)
  })

  it("an empty-recall client scores retention 0 and task failure", async () => {
    const model = scriptedClient(() => "I don't recall the earlier details.")
    const m = await runContinuitySession({ scenario: bugHunt, compactor: identityCompactor, model })
    expect(m.retention).toBe(0)
    expect(m.taskSuccess).toBe(false)
    expect(m.errored).toBe(false)
  })

  it("a throwing client marks the run errored (never a false zero)", async () => {
    const model: ModelClient = {
      async send() {
        throw new Error("boom")
      },
    }
    const m = await runContinuitySession({ scenario: bugHunt, compactor: identityCompactor, model })
    expect(m.errored).toBe(true)
  })
})

// ─── treatment registry ───

describe("treatment compactor registry", () => {
  afterEach(() => __resetTreatmentCompactorsForTest())
  it("resolves null until a treatment is registered, then resolves it", () => {
    expect(resolveTreatmentCompactor()).toBeNull()
    const stub: Compactor = { id: "test-cartridge", compact: async (i) => i.transcript }
    registerTreatmentCompactor(stub)
    expect(resolveTreatmentCompactor()?.id).toBe("test-cartridge")
    expect(resolveTreatmentCompactor("test-cartridge")?.id).toBe("test-cartridge")
    expect(resolveTreatmentCompactor("nope")).toBeNull()
  })
  it("standardConditions includes treatment only when supplied", () => {
    expect(standardConditions(null).map((c) => c.id)).toEqual(["control-a", "control-b"])
    const t: Compactor = { id: "kv", compact: async (i) => i.transcript }
    expect(standardConditions(t).map((c) => c.id)).toEqual(["control-a", "control-b", "treatment"])
  })
})

// ─── scorecard ───

describe("scorecard", () => {
  const runs = (retention: number, success: number, tokens: number): RunMetrics[] =>
    Array.from({ length: 4 }, (_, i) => ({
      taskSuccess: i < success,
      retention,
      tokens,
      latencyMs: 100,
      probeScores: [],
      errored: false,
    }))
  it("builds delta columns vs the baseline and renders a table", () => {
    const aggregates = [
      aggregateCondition("control-a", runs(0.9, 4, 5000)),
      aggregateCondition("control-b", runs(0.5, 2, 3000)),
    ]
    const sc = buildScorecard({
      model: "test-model",
      scenarioIds: ["s1"],
      runsPerCondition: 4,
      baselineId: "control-b",
      aggregates,
    })
    const a = sc.rows.find((r) => r.condition === "control-a")!
    const b = sc.rows.find((r) => r.condition === "control-b")!
    expect(b.retention.deltaVsBaseline).toBeNull() // baseline row has no delta
    expect(a.retention.deltaVsBaseline!.delta).toBeCloseTo(0.4, 6) // 0.9 - 0.5
    expect(a.tokens.deltaVsBaseline!.delta).toBeCloseTo(2000, 6)
    const table = formatScorecard(sc)
    expect(table).toContain("PTS DEEP-WORK CONTINUITY SCORECARD")
    expect(table).toContain("control-a")
    expect(table).toContain("+40pp")
  })
})
