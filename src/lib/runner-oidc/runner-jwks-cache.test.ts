// SIG-184 PR 2 — the in-isolate cached JWKS fetcher: TTL, single-flight,
// throttled force-refetch (rotation safety without a DoS lever), failure retry.

import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCachedFetchJwks, forcedRefetchAvailable, __resetJwksCacheForTests } from "@/src/lib/runner-oidc/jwks-cache"
import type { Jwk } from "@/src/lib/runner-oidc/types"

const JWK: Jwk = { kid: "k1", kty: "RSA", n: "n", e: "AQAB", alg: "RS256", use: "sig" }
// Realistic epoch ms so the cooldown math (now - lastForcedRefetch) behaves as in
// prod (a cold isolate's lastForcedRefetch starts at 0).
const T0 = 1_700_000_000_000

function stubJwksFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [JWK] }), {
        headers: { "content-type": "application/json" },
      }),
  )
  vi.stubGlobal("fetch", f)
  return f
}

afterEach(() => {
  __resetJwksCacheForTests()
  vi.unstubAllGlobals()
})

describe("makeCachedFetchJwks", () => {
  it("fetches once, then serves the cache within the TTL", async () => {
    const f = stubJwksFetch()
    let t = T0
    const now = () => t
    expect(await makeCachedFetchJwks({ now })()).toEqual([JWK])
    t += 60_000 // well within the 10-min TTL
    expect(await makeCachedFetchJwks({ now })()).toEqual([JWK])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("refetches once the TTL has expired", async () => {
    const f = stubJwksFetch()
    let t = T0
    const now = () => t
    await makeCachedFetchJwks({ now })()
    t += 11 * 60_000 // past the 10-min TTL
    await makeCachedFetchJwks({ now })()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it("forceRefetch refetches, then THROTTLES within the cooldown, then fires again", async () => {
    const f = stubJwksFetch()
    let t = T0
    const now = () => t
    await makeCachedFetchJwks({ now })() // (1) cold fetch
    await makeCachedFetchJwks({ now, forceRefetch: true })() // (2) forced — fires
    expect(f).toHaveBeenCalledTimes(2)
    t += 30_000 // < 60s cooldown
    await makeCachedFetchJwks({ now, forceRefetch: true })() // throttled — serves cache
    expect(f).toHaveBeenCalledTimes(2)
    t += 31_000 // now 61s since the last forced refetch
    await makeCachedFetchJwks({ now, forceRefetch: true })() // fires again
    expect(f).toHaveBeenCalledTimes(3)
  })

  it("coalesces concurrent cold calls into a single fetch (single-flight)", async () => {
    let resolve!: (r: Response) => void
    const f = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    vi.stubGlobal("fetch", f)
    const now = () => T0
    const p1 = makeCachedFetchJwks({ now })()
    const p2 = makeCachedFetchJwks({ now })()
    resolve(
      new Response(JSON.stringify({ keys: [JWK] }), {
        headers: { "content-type": "application/json" },
      }),
    )
    expect(await p1).toEqual([JWK])
    expect(await p2).toEqual([JWK])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("a forced refetch coalesces with an in-flight normal fetch (single-flight preserved)", async () => {
    let resolve!: (r: Response) => void
    const f = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    vi.stubGlobal("fetch", f)
    const now = () => T0
    const p1 = makeCachedFetchJwks({ now })() // cold normal fetch → pending
    const p2 = makeCachedFetchJwks({ now, forceRefetch: true })() // forced — must coalesce
    resolve(
      new Response(JSON.stringify({ keys: [JWK] }), {
        headers: { "content-type": "application/json" },
      }),
    )
    expect(await p1).toEqual([JWK])
    expect(await p2).toEqual([JWK])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("forcedRefetchAvailable tracks the cooldown (cold → available, just-forced → throttled)", async () => {
    stubJwksFetch()
    let t = T0
    const now = () => t
    expect(forcedRefetchAvailable(now)).toBe(true) // cold isolate: lastForced = 0
    await makeCachedFetchJwks({ now, forceRefetch: true })()
    expect(forcedRefetchAvailable(now)).toBe(false) // within the 60s cooldown
    t += 61_000
    expect(forcedRefetchAvailable(now)).toBe(true) // cooldown elapsed
  })

  it("a fetch failure rejects (verify maps it) and clears the cache so the next call retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network")
      }),
    )
    const now = () => T0
    await expect(makeCachedFetchJwks({ now })()).rejects.toThrow()
    // cache cleared → a fresh fetch succeeds
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [JWK] }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    expect(await makeCachedFetchJwks({ now })()).toEqual([JWK])
  })
})
