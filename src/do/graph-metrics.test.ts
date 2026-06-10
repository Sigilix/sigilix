// SIG-152 — GraphMetricsDO: rolling per-day aggregates of the
// pr-review-graph-retrieval shadow sample. Same node:sqlite shim harness
// as RepoGraphDO / ValidationMetricsDO.

import { describe, expect, it } from "vitest"
import { GraphMetricsDO, type GraphRetrievalSample } from "@/src/do/graph-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

function makeDoInstance() {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> { return false },
      async setAlarm(t: number): Promise<void> { alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "global", name: "global" },
  }
  return new GraphMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

const sample = (over: Partial<GraphRetrievalSample> = {}): GraphRetrievalSample => ({
  mode: "shadow",
  jaccard: 0.5,
  addedCount: 2,
  nodeCount: 6,
  cappedNodeCount: 4,
  blastCallerCount: 3,
  blastDependentCount: 1,
  ...over,
})

const pr = { owner: "o", repo: "r", prNumber: 1, headSha: "abc" }

describe("GraphMetricsDO.recordSample + query", () => {
  it("averages numeric metrics across same-day samples", async () => {
    const do_ = makeDoInstance()
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T08:00:00.000Z", sample: sample({ jaccard: 0.4, addedCount: 1 }) })
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T09:00:00.000Z", sample: sample({ jaccard: 0.6, addedCount: 3 }) })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reviews).toBe(2)
    expect(out.averages.jaccard).toBeCloseTo(0.5)
    expect(out.averages.addedCount).toBeCloseTo(2)
    expect(out.averages.cappedNodeCount).toBeCloseTo(4)
  })

  it("breaks reviews down by mode", async () => {
    const do_ = makeDoInstance()
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T08:00:00.000Z", sample: sample({ mode: "shadow" }) })
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T09:00:00.000Z", sample: sample({ mode: "shadow" }) })
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T10:00:00.000Z", sample: sample({ mode: "post" }) })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.modeReviews).toEqual({ shadow: 2, post: 1 })
  })

  it("excludes samples outside the window", async () => {
    const do_ = makeDoInstance()
    await do_.recordSample({ ...pr, occurredAt: "2026-05-01T00:00:00.000Z", sample: sample() })
    await do_.recordSample({ ...pr, occurredAt: "2026-05-22T00:00:00.000Z", sample: sample() })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reviews).toBe(1)
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-16", endDay: "2026-05-22" })
  })

  it("zero reviews → zeroed averages, no NaN", async () => {
    const do_ = makeDoInstance()
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    expect(out.reviews).toBe(0)
    expect(out.averages.jaccard).toBe(0)
    expect(out.averages.addedCount).toBe(0)
    expect(out.modeReviews).toEqual({})
    expect(out.lastSeenPrHeads).toEqual([])
  })

  it("tracks last-seen head SHA per PR (latest wins)", async () => {
    const do_ = makeDoInstance()
    await do_.recordSample({ owner: "o", repo: "r", prNumber: 5, headSha: "aaa", occurredAt: "2026-05-22T10:00:00.000Z", sample: sample() })
    await do_.recordSample({ owner: "o", repo: "r", prNumber: 5, headSha: "bbb", occurredAt: "2026-05-22T11:00:00.000Z", sample: sample() })
    const out = await do_.query({ windowDays: 7, nowIso: "2026-05-22T12:00:00.000Z" })
    const head = out.lastSeenPrHeads.find((h) => h.prNumber === 5)
    expect(head?.headSha).toBe("bbb")
  })
})

describe("GraphMetricsDO.alarm (retention GC)", () => {
  it("prunes daily aggregates + PR heads older than retention", async () => {
    const do_ = makeDoInstance()
    await do_.recordSample({ owner: "o", repo: "r", prNumber: 9, headSha: "old", occurredAt: "2020-01-01T00:00:00.000Z", sample: sample() })
    const fresh = new Date().toISOString()
    await do_.recordSample({ owner: "o", repo: "r", prNumber: 10, headSha: "new", occurredAt: fresh, sample: sample() })
    await do_.alarm()
    const out = await do_.query({ windowDays: 30, nowIso: fresh })
    expect(out.reviews).toBe(1)
    expect(out.lastSeenPrHeads.some((h) => h.prNumber === 9)).toBe(false)
    expect(out.lastSeenPrHeads.some((h) => h.prNumber === 10)).toBe(true)
  })
})
