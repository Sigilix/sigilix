// SIG-119 — ValidationMetricsDO: rolling per-gate validator telemetry.
//
// Same harness as the RepoGraphDO tests: a real in-memory SQLite engine
// (NodeSqliteStorage, Node 22 node:sqlite) wired into a hand-built storage
// stub; public methods called directly (no HTTP fetch).

import { describe, expect, it } from "vitest"
import { ValidationMetricsDO } from "../src/do/validation-metrics"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

function makeDoInstance() {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<boolean> { return false },
      async setAlarm(timestamp: number): Promise<void> { alarmAt = timestamp },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "global", name: "global" },
  }
  return new ValidationMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

const pr = { owner: "o", repo: "r", prNumber: 1, headSha: "deadbeef" }

describe("ValidationMetricsDO.recordBatch + query", () => {
  it("shadow event (dropped:false) increments wouldDrop AND kept", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      ...pr,
      occurredAt: "2026-05-22T12:00:00.000Z",
      events: [{ kind: "gate-rejection", gate: "security", reason: "fabricated-evidence-id", dropped: false }],
    })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.counts.security["fabricated-evidence-id"]).toEqual({ wouldDrop: 1, kept: 1 })
  })

  it("enforce event (dropped:true) increments wouldDrop only", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      ...pr,
      occurredAt: "2026-05-22T12:00:00.000Z",
      events: [{ kind: "gate-rejection", gate: "tests", reason: "vague-insufficient-test", dropped: true }],
    })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.counts.tests["vague-insufficient-test"]).toEqual({ wouldDrop: 1, kept: 0 })
  })

  it("accumulates same (day,gate,reason) across batches", async () => {
    const do_ = makeDoInstance()
    const at = "2026-05-22T08:00:00.000Z"
    await do_.recordBatch({ ...pr, occurredAt: at, events: [{ kind: "gate-rejection", gate: "logic", reason: "unanchored-logic-claim", dropped: false }] })
    await do_.recordBatch({ ...pr, occurredAt: at, events: [{ kind: "gate-rejection", gate: "logic", reason: "unanchored-logic-claim", dropped: true }] })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.counts.logic["unanchored-logic-claim"]).toEqual({ wouldDrop: 2, kept: 1 })
  })

  it("excludes days outside the requested window", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({ ...pr, occurredAt: "2026-05-01T00:00:00.000Z", events: [{ kind: "gate-rejection", gate: "perf", reason: "path-not-changed", dropped: false }] })
    await do_.recordBatch({ ...pr, occurredAt: "2026-05-22T00:00:00.000Z", events: [{ kind: "gate-rejection", gate: "perf", reason: "path-not-changed", dropped: false }] })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    // Only the 2026-05-22 event is within the 7-day window ending 2026-05-22.
    expect(out.counts.perf["path-not-changed"]).toEqual({ wouldDrop: 1, kept: 1 })
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-16", endDay: "2026-05-22" })
  })

  it("is gate-agnostic — an unknown gate is recorded like any other", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({ ...pr, occurredAt: "2026-05-22T00:00:00.000Z", events: [{ kind: "gate-rejection", gate: "coverage", reason: "uncited-gap", dropped: false }] })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.counts.coverage["uncited-gap"]).toEqual({ wouldDrop: 1, kept: 1 })
  })

  it("tracks last-seen head SHA per PR (latest wins)", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({ owner: "o", repo: "r", prNumber: 5, headSha: "aaa", occurredAt: "2026-05-22T10:00:00.000Z", events: [{ kind: "gate-rejection", gate: "tests", reason: "missing-path", dropped: false }] })
    await do_.recordBatch({ owner: "o", repo: "r", prNumber: 5, headSha: "bbb", occurredAt: "2026-05-22T11:00:00.000Z", events: [{ kind: "gate-rejection", gate: "tests", reason: "missing-path", dropped: false }] })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    const head = out.lastSeenPrHeads.find((h) => h.owner === "o" && h.repo === "r" && h.prNumber === 5)
    expect(head?.headSha).toBe("bbb")
    expect(head?.lastSeenAt).toBe("2026-05-22T11:00:00.000Z")
  })

  it("empty events is a no-op", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({ ...pr, occurredAt: "2026-05-22T00:00:00.000Z", events: [] })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.counts).toEqual({})
    expect(out.lastSeenPrHeads).toEqual([])
  })
})

describe("ValidationMetricsDO.alarm (retention GC)", () => {
  it("prunes daily counts + PR heads older than the retention window", async () => {
    const do_ = makeDoInstance()
    // Ancient event (well beyond 35-day retention) + a fresh one.
    await do_.recordBatch({ owner: "o", repo: "r", prNumber: 9, headSha: "old", occurredAt: "2020-01-01T00:00:00.000Z", events: [{ kind: "gate-rejection", gate: "security", reason: "evidence-out-of-range", dropped: false }] })
    const fresh = new Date().toISOString()
    await do_.recordBatch({ owner: "o", repo: "r", prNumber: 10, headSha: "new", occurredAt: fresh, events: [{ kind: "gate-rejection", gate: "security", reason: "evidence-out-of-range", dropped: false }] })

    await do_.alarm()

    // A wide window still excludes the GC'd ancient day; the fresh one stays.
    const out = await do_.query({ windowDays: 30, nowIso: fresh })
    expect(out.lastSeenPrHeads.some((h) => h.prNumber === 9)).toBe(false)
    expect(out.lastSeenPrHeads.some((h) => h.prNumber === 10)).toBe(true)

    // Direct retention check independent of the query window.
    expect(await do_.debugDayCount("2020-01-01", "security", "evidence-out-of-range")).toBeNull()
  })
})

// SIG-173 — `dismissal-reason` event + queryDismissals rollup.

describe("ValidationMetricsDO dismissal-reason events", () => {
  it("queryDismissals starts every reason at zero", async () => {
    const do_ = makeDoInstance()
    const out = await do_.queryDismissals({ windowDays: 30, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reasonCounts).toEqual({
      "not-a-bug": 0,
      "bad-anchor": 0,
      "already-covered": 0,
      "too-minor": 0,
      "wrong-context": 0,
      "unlabeled": 0,
    })
    expect(out.window).toEqual({ days: 30, startDay: "2026-04-23", endDay: "2026-05-22" })
  })

  it("counts a dismissal-reason event under its canonical label", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      owner: "", repo: "", prNumber: 0, headSha: "",
      occurredAt: "2026-05-22T12:00:00.000Z",
      events: [{ kind: "dismissal-reason", reason: "too-minor" }],
    })
    const out = await do_.queryDismissals({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reasonCounts["too-minor"]).toBe(1)
    expect(out.reasonCounts["not-a-bug"]).toBe(0)
  })

  it("accumulates dismissals across batches", async () => {
    const do_ = makeDoInstance()
    const at = "2026-05-22T08:00:00.000Z"
    for (const reason of ["too-minor", "too-minor", "not-a-bug", "unlabeled"] as const) {
      await do_.recordBatch({
        owner: "", repo: "", prNumber: 0, headSha: "",
        occurredAt: at,
        events: [{ kind: "dismissal-reason", reason }],
      })
    }
    const out = await do_.queryDismissals({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reasonCounts["too-minor"]).toBe(2)
    expect(out.reasonCounts["not-a-bug"]).toBe(1)
    expect(out.reasonCounts["unlabeled"]).toBe(1)
    expect(out.reasonCounts["bad-anchor"]).toBe(0)
  })

  it("excludes dismissals outside the window", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      owner: "", repo: "", prNumber: 0, headSha: "",
      occurredAt: "2026-05-01T00:00:00.000Z",
      events: [{ kind: "dismissal-reason", reason: "too-minor" }],
    })
    await do_.recordBatch({
      owner: "", repo: "", prNumber: 0, headSha: "",
      occurredAt: "2026-05-22T00:00:00.000Z",
      events: [{ kind: "dismissal-reason", reason: "too-minor" }],
    })
    const out = await do_.queryDismissals({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reasonCounts["too-minor"]).toBe(1)
  })

  it("does NOT pollute the validator-gate rollup or last-seen tracker", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      owner: "x", repo: "y", prNumber: 99, headSha: "shouldnotappear",
      occurredAt: "2026-05-22T12:00:00.000Z",
      events: [{ kind: "dismissal-reason", reason: "bad-anchor" }],
    })
    const gates = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    // The synthetic "dismissal" gate is filtered out of the validator query.
    expect(gates.counts).toEqual({})
    // And `last_seen_pr` is left untouched (no head SHA to attribute).
    expect(gates.lastSeenPrHeads).toEqual([])
  })

  it("mixes both event kinds in one batch — each routes to its own surface", async () => {
    const do_ = makeDoInstance()
    await do_.recordBatch({
      owner: "o", repo: "r", prNumber: 1, headSha: "abc",
      occurredAt: "2026-05-22T12:00:00.000Z",
      events: [
        { kind: "gate-rejection", gate: "security", reason: "fabricated-evidence-id", dropped: true },
        { kind: "dismissal-reason", reason: "wrong-context" },
      ],
    })
    const gates = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    const dismissals = await do_.queryDismissals({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(gates.counts.security?.["fabricated-evidence-id"]).toEqual({ wouldDrop: 1, kept: 0 })
    expect(dismissals.reasonCounts["wrong-context"]).toBe(1)
  })
})
