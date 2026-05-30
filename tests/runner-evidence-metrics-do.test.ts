// SIG-184 PR 5b — RunnerEvidenceMetricsDO: rolling runner-evidence presence
// telemetry. Same harness as the ValidationMetricsDO tests (real in-memory
// node:sqlite); public methods called directly.

import { describe, expect, it } from "vitest"
import { RunnerEvidenceMetricsDO } from "../src/do/runner-evidence-metrics"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

function makeDoInstance(): { do_: RunnerEvidenceMetricsDO; getAlarm: () => number | null } {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<boolean> { return false },
      async setAlarm(t: number): Promise<void> { alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "global", name: "global" },
  }
  return { do_: new RunnerEvidenceMetricsDO(state as unknown as DurableObjectState, {} as Env), getAlarm: () => alarmAt }
}

const base = { owner: "Sigilix", repo: "sigilix", prNumber: 7 }
const T = "2026-05-30T12:00:00.000Z"

describe("RunnerEvidenceMetricsDO.record + query", () => {
  it("counts verified / runner-absent under the empty reason key", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ ...base, state: "verified", occurredAt: T })
    await do_.record({ ...base, prNumber: 8, state: "runner-absent", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.counts.verified[""]).toBe(1)
    expect(out.counts["runner-absent"][""]).toBe(1)
  })

  it("buckets evidence-pending by its reason", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ ...base, state: "evidence-pending", reason: "merge-sha-unavailable", occurredAt: T })
    await do_.record({ ...base, prNumber: 8, state: "evidence-pending", reason: "merge-sha-mismatch", occurredAt: T })
    await do_.record({ ...base, prNumber: 9, state: "evidence-pending", reason: "merge-sha-mismatch", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.counts["evidence-pending"]["merge-sha-unavailable"]).toBe(1)
    expect(out.counts["evidence-pending"]["merge-sha-mismatch"]).toBe(2)
  })

  it("collapses a stray reason on verified/runner-absent to the empty key (never a phantom reason bucket)", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ ...base, state: "verified", reason: "should-be-ignored", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.counts.verified[""]).toBe(1)
    expect(out.counts.verified["should-be-ignored"]).toBeUndefined()
  })

  it("tracks the per-repo LATEST state (a newer observation supersedes)", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ ...base, state: "evidence-pending", reason: "merge-sha-unavailable", occurredAt: "2026-05-30T10:00:00.000Z" })
    await do_.record({ ...base, state: "verified", occurredAt: "2026-05-30T11:00:00.000Z" })
    // An out-of-order (older) write must NOT regress the latest state.
    await do_.record({ ...base, state: "runner-absent", occurredAt: "2026-05-30T09:00:00.000Z" })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    const row = out.repoPresence.find((p) => p.owner === "Sigilix" && p.repo === "sigilix")
    expect(row).toMatchObject({ lastState: "verified", lastReason: "" })
  })

  it("does not create a repo_presence row when owner/repo are empty", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ owner: "", repo: "", prNumber: 0, state: "runner-absent", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.repoPresence).toHaveLength(0)
    // …but the daily count is still recorded.
    expect(out.counts["runner-absent"][""]).toBe(1)
  })

  it("excludes counts outside the trailing window", async () => {
    const { do_ } = makeDoInstance()
    await do_.record({ ...base, state: "verified", occurredAt: "2026-05-20T12:00:00.000Z" }) // 10 days before
    await do_.record({ ...base, prNumber: 8, state: "verified", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.counts.verified[""]).toBe(1) // only the in-window one
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-24", endDay: "2026-05-30" })
  })

  it("arms a daily GC alarm after the first record", async () => {
    const { do_, getAlarm } = makeDoInstance()
    expect(getAlarm()).toBeNull()
    await do_.record({ ...base, state: "verified", occurredAt: T })
    expect(getAlarm()).not.toBeNull()
  })

  it("alarm GC drops buckets + repo rows older than the retention window", async () => {
    const { do_ } = makeDoInstance()
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    await do_.record({ ...base, state: "verified", occurredAt: old })
    await do_.record({ ...base, prNumber: 8, state: "verified", occurredAt: new Date().toISOString() })
    await do_.alarm()
    expect(await do_.debugDayCount(old.slice(0, 10), "verified", "")).toBeNull()
    expect(await do_.debugDayCount(new Date().toISOString().slice(0, 10), "verified", "")).not.toBeNull()
  })
})
