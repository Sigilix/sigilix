import { describe, it, expect } from "vitest"
import {
  setProviderCooldown,
  getProviderCooldownRemainingMs,
} from "@/src/shared/adapters/model/provider-cooldown-client"
import type { Env } from "@/src/shared/types/env"

function envWith(fetchImpl: (req: Request) => Promise<Response>): Env {
  return {
    PROVIDER_COOLDOWN: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({ fetch: (req: Request) => fetchImpl(req) }),
    },
  } as unknown as Env
}

describe("setProviderCooldown", () => {
  it("POSTs /set with the cooldownMs body", async () => {
    let capturedUrl: string | null = null
    let capturedBody: unknown = null
    const env = envWith(async (req) => {
      capturedUrl = req.url
      capturedBody = await req.json()
      return new Response(null, { status: 200 })
    })
    await setProviderCooldown(env, 5000)
    expect(capturedUrl).toBe("https://do.internal/set")
    expect(capturedBody).toEqual({ cooldownMs: 5000 })
  })

  it("never throws when the DO throws", async () => {
    const env = envWith(async () => {
      throw new Error("DO down")
    })
    await expect(setProviderCooldown(env, 5000)).resolves.toBeUndefined()
  })

  it("never throws on a non-200 response", async () => {
    const env = envWith(async () => new Response("nope", { status: 500 }))
    await expect(setProviderCooldown(env, 5000)).resolves.toBeUndefined()
  })
})

describe("getProviderCooldownRemainingMs", () => {
  it("GETs /get with no body (idempotent)", async () => {
    let capturedMethod: string | null = null
    let capturedUrl: string | null = null
    const env = envWith(async (req) => {
      capturedMethod = req.method
      capturedUrl = req.url
      return new Response(JSON.stringify({ remainingMs: 0 }), { status: 200 })
    })
    await getProviderCooldownRemainingMs(env)
    expect(capturedMethod).toBe("GET")
    expect(capturedUrl).toBe("https://do.internal/get")
  })

  it("returns remainingMs from a 200 body", async () => {
    const env = envWith(async () => new Response(JSON.stringify({ remainingMs: 12000 }), { status: 200 }))
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(12000)
  })

  it("returns 0 when the DO throws", async () => {
    const env = envWith(async () => {
      throw new Error("DO down")
    })
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(0)
  })

  it("returns 0 on non-200", async () => {
    const env = envWith(async () => new Response("nope", { status: 500 }))
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(0)
  })

  it("returns 0 when remainingMs is missing from body", async () => {
    const env = envWith(async () => new Response(JSON.stringify({}), { status: 200 }))
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(0)
  })

  it("returns 0 when remainingMs is a non-number", async () => {
    const env = envWith(async () => new Response(JSON.stringify({ remainingMs: "not-a-number" }), { status: 200 }))
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(0)
  })

  it("returns 0 for a non-JSON body", async () => {
    const env = envWith(async () => new Response("not json", { status: 200 }))
    const result = await getProviderCooldownRemainingMs(env)
    expect(result).toBe(0)
  })
})
