// src/do/provider-cooldown.test.ts
import { describe, it, expect } from "vitest"
import { ProviderCooldownDO } from "@/src/do/provider-cooldown"
import type { Env } from "@/src/shared/types/env"

function makeState() {
  const store = new Map<string, unknown>()
  const ctx = {
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
    },
    id: { toString: () => "provider:openai" },
  }
  return { ctx }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function postRaw(path: string, body: string): Request {
  return new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

function get(path: string): Request {
  return new Request(`https://do.internal${path}`, { method: "GET" })
}

type SetReply = { cooldownUntil: number }
type GetReply = { remainingMs: number }

describe("ProviderCooldownDO", () => {
  it("set then get returns remainingMs close to the requested cooldown", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const setRes = await do_.fetch(post("/set", { cooldownMs: 30_000 }))
    expect(setRes.status).toBe(200)
    const setBody = (await setRes.json()) as SetReply
    expect(setBody.cooldownUntil).toBeGreaterThan(Date.now())

    const getRes = await do_.fetch(get("/get"))
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as GetReply
    // Allow a few ms of drift between set and get
    expect(getBody.remainingMs).toBeGreaterThan(29_000)
    expect(getBody.remainingMs).toBeLessThanOrEqual(30_000)
  })

  it("max-merge: a shorter later cooldown never shrinks a longer active one", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/set", { cooldownMs: 30_000 }))
    await do_.fetch(post("/set", { cooldownMs: 5_000 }))

    const getRes = await do_.fetch(get("/get"))
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as GetReply
    // Must still be close to 30s, not shrunk to 5s
    expect(body.remainingMs).toBeGreaterThan(29_000)
  })

  it("cap: a very large cooldownMs is capped at MAX_COOLDOWN_MS (300_000)", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/set", { cooldownMs: 999_999_999 }))

    const getRes = await do_.fetch(get("/get"))
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as GetReply
    expect(body.remainingMs).toBeLessThanOrEqual(300_000)
    expect(body.remainingMs).toBeGreaterThan(0)
  })

  it("get on empty state returns remainingMs 0", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const getRes = await do_.fetch(get("/get"))
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as GetReply
    expect(body.remainingMs).toBe(0)
  })

  it("get returns 0 when cooldownUntil is in the past", async () => {
    const { ctx } = makeState()
    // Directly write a past cooldownUntil to simulate an expired cooldown
    await ctx.storage.put("cooldown", { cooldownUntil: Date.now() - 5_000 })
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const getRes = await do_.fetch(get("/get"))
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as GetReply
    expect(body.remainingMs).toBe(0)
  })

  it("returns 400 for missing cooldownMs field", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/set", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-number cooldownMs", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/set", { cooldownMs: "notanumber" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for negative cooldownMs", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/set", { cooldownMs: -1 }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-JSON body on /set", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(postRaw("/set", "not-json"))
    expect(res.status).toBe(400)
  })

  it("returns 404 for unknown routes", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/unknown", {}))
    expect(res.status).toBe(404)
  })

  it("returns 400 for null JSON body on /set", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(postRaw("/set", "null"))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-object JSON body on /set (string)", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(postRaw("/set", '"x"'))
    expect(res.status).toBe(400)
  })

  it("POST to /get returns 404 (route requires GET)", async () => {
    const { ctx } = makeState()
    const do_ = new ProviderCooldownDO(ctx as unknown as DurableObjectState, {} as Env)
    const res = await do_.fetch(post("/get", {}))
    expect(res.status).toBe(404)
  })
})
