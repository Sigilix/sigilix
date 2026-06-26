// src/do/tenant-concurrency.test.ts
import { describe, it, expect } from "vitest"
import { TenantConcurrencyDO } from "@/src/do/tenant-concurrency"
import type { Env } from "@/src/shared/types/env"

function makeState() {
  const store = new Map<string, unknown>()
  let alarmAt: number | null = null
  const ctx = {
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
      setAlarm: async (t: number) => void (alarmAt = t),
      getAlarm: async () => alarmAt,
      deleteAlarm: async () => void (alarmAt = null),
    },
    id: { toString: () => "tenant:42" },
  }
  return { ctx, getAlarm: () => alarmAt }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

type AcquireReply = { granted: boolean; retryAfterMs: number }

describe("TenantConcurrencyDO", () => {
  it("grants up to cap, then denies with a backoff", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    const a = (await (await do_.fetch(post("/acquire", { leaseId: "a", cap: 2 }))).json()) as AcquireReply
    const b = (await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 2 }))).json()) as AcquireReply
    const c = (await (await do_.fetch(post("/acquire", { leaseId: "c", cap: 2 }))).json()) as AcquireReply
    expect(a.granted).toBe(true)
    expect(b.granted).toBe(true)
    expect(c.granted).toBe(false)
    expect(c.retryAfterMs).toBeGreaterThan(0)
  })

  it("release frees a slot", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/acquire", { leaseId: "a", cap: 1 }))
    const denied = (await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 1 }))).json()) as AcquireReply
    expect(denied.granted).toBe(false)
    await do_.fetch(post("/release", { leaseId: "a" }))
    const granted = (await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 1 }))).json()) as AcquireReply
    expect(granted.granted).toBe(true)
  })

  it("arms a reaper alarm while leases are held", async () => {
    const { ctx, getAlarm } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/acquire", { leaseId: "a", cap: 2 }))
    expect(getAlarm()).not.toBeNull()
  })

  it("alarm() reaps expired leases", async () => {
    const { ctx } = makeState()
    await ctx.storage.put("fairness", {
      schemaVersion: 1,
      leases: [{ leaseId: "old", acquiredAtMs: 0, expiresAtMs: 1 }],
      denyCounts: {},
    })
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.alarm()
    const state = await ctx.storage.get<{ leases: unknown[] }>("fairness")
    expect(state?.leases.length).toBe(0)
  })

  it("returns 400 when /acquire body is missing fields", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/acquire", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 when /release body is missing leaseId", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/release", {}))
    expect(res.status).toBe(400)
  })
})
