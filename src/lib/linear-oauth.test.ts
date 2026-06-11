// Linear OAuth client_credentials token fetch + KV caching. The Worker
// hits the token endpoint at most once per 25 days (30-day TTL minus the
// 5-day refresh-ahead buffer). These tests cover cache hit, cache miss,
// near-expiry refresh, and the failure modes that would otherwise be
// silently swallowed in prod.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { getAppActorToken } from "@/src/lib/linear-oauth"

interface FakeKV {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
}

function makeKV(initial: Record<string, string> = {}): FakeKV {
  const store = new Map(Object.entries(initial))
  return {
    get: vi.fn(async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

describe("getAppActorToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the cached token when not near expiry", async () => {
    const kv = makeKV({
      "oauth:app-actor-token": JSON.stringify({
        accessToken: "cached-token",
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const token = await getAppActorToken(kv as unknown as KVNamespace, "id", "secret")

    expect(token).toBe("cached-token")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("fetches a fresh token when KV is empty", async () => {
    const kv = makeKV()
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "new-token", expires_in: 2_592_000 }),
    }))
    vi.stubGlobal("fetch", fetchSpy)

    const token = await getAppActorToken(kv as unknown as KVNamespace, "id", "secret")

    expect(token).toBe("new-token")
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.linear.app/oauth/token")
    expect(init.method).toBe("POST")
    expect(String(init.body)).toContain("grant_type=client_credentials")
    expect(String(init.body)).toContain("client_id=id")
    expect(String(init.body)).toContain("client_secret=secret")
    expect(kv.put).toHaveBeenCalledOnce()
  })

  it("refreshes when the cached token is within the refresh-ahead window", async () => {
    // 4 days from now — inside the 5-day refresh-ahead buffer, so we should
    // mint a new token instead of returning the about-to-expire one.
    const kv = makeKV({
      "oauth:app-actor-token": JSON.stringify({
        accessToken: "stale-token",
        expiresAt: Date.now() + 4 * 24 * 60 * 60 * 1000,
      }),
    })
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "fresh-token", expires_in: 2_592_000 }),
    }))
    vi.stubGlobal("fetch", fetchSpy)

    const token = await getAppActorToken(kv as unknown as KVNamespace, "id", "secret")

    expect(token).toBe("fresh-token")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("refreshes when the cached value is malformed", async () => {
    const kv = makeKV({
      "oauth:app-actor-token": JSON.stringify({ wrong: "shape" }),
    })
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "recovered-token", expires_in: 2_592_000 }),
    }))
    vi.stubGlobal("fetch", fetchSpy)

    const token = await getAppActorToken(kv as unknown as KVNamespace, "id", "secret")

    expect(token).toBe("recovered-token")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("throws when the token endpoint returns a non-2xx", async () => {
    const kv = makeKV()
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_client"}',
    }))
    vi.stubGlobal("fetch", fetchSpy)

    await expect(getAppActorToken(kv as unknown as KVNamespace, "wrong", "wrong")).rejects.toThrow(/401/)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("throws when the token response is missing required fields", async () => {
    const kv = makeKV()
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token_type: "bearer" }),
    }))
    vi.stubGlobal("fetch", fetchSpy)

    await expect(getAppActorToken(kv as unknown as KVNamespace, "id", "secret")).rejects.toThrow(/missing fields/)
    expect(kv.put).not.toHaveBeenCalled()
  })
})
