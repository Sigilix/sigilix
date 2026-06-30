// SIG-545 — the keyless Vertex token mint: the assertion JWT (header+claims,
// verifiable against the public JWK) + the cached/single-flighted SA-token flow.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  signAssertionJwt,
  getVertexAccessToken,
  __resetVertexTokenCacheForTests,
} from "@/src/lib/boreas-gateway/vertex-token"
import { getOrCreateSigningKey, __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import { STS_TOKEN_URL, GENERATE_ACCESS_TOKEN_URL } from "@/src/lib/boreas-gateway/constants"
import { makeEnv, makeCtx } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"

const ISSUER = "https://gw.example"
const T0 = 1_700_000_000_000 // epoch ms
const NOW_SEC = 1_700_000_000 // epoch seconds

beforeEach(() => {
  __resetVertexTokenCacheForTests()
  __resetSigningKeyCacheForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── base64url decode helpers (JWT segments) ─────────────────────────────────
// Both return a FRESH ArrayBuffer-backed view (`Uint8Array<ArrayBuffer>`) — a plain
// `TextEncoder.encode()` / `new Uint8Array(n)` is typed `Uint8Array<ArrayBufferLike>`,
// which the strict Workers `BufferSource` rejects for crypto.subtle (mirrors
// runner-oidc/verify.ts).
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")
  const bin = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function decodeSegment(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as Record<string, unknown>
}
function utf8(s: string): Uint8Array<ArrayBuffer> {
  const e = new TextEncoder().encode(s)
  const out = new Uint8Array(new ArrayBuffer(e.length))
  out.set(e)
  return out
}

const jsonHeaders = { headers: { "content-type": "application/json" } }

/** Stub global fetch to answer STS + iamcredentials by URL. Returns the spy. */
function stubGcpFetch(impersonate: { accessToken: string; expireTime: string }): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u === STS_TOKEN_URL) return new Response(JSON.stringify({ access_token: "fed-token" }), jsonHeaders)
    if (u === GENERATE_ACCESS_TOKEN_URL) return new Response(JSON.stringify(impersonate), jsonHeaders)
    throw new Error(`unexpected fetch: ${u}`)
  })
  vi.stubGlobal("fetch", f)
  return f
}
function stsCalls(f: ReturnType<typeof vi.fn>): number {
  return f.mock.calls.filter((c) => String(c[0]) === STS_TOKEN_URL).length
}
function rfc3339(ms: number): string {
  return new Date(ms).toISOString()
}

describe("signAssertionJwt", () => {
  it("emits a header with kid + claims (backdated iat, ~5min exp) verifiable against the public JWK", async () => {
    const env = makeEnv()
    const sk = await getOrCreateSigningKey(env.OPENCLAW_STATE, env.OPENCLAW_SESSION_ENCRYPTION_KEY)
    const jwt = await signAssertionJwt({ privateKey: sk.privateKey, kid: sk.kid, issuer: ISSUER, now: NOW_SEC })

    const [headerB64, payloadB64, sigB64] = jwt.split(".") as [string, string, string]
    const header = decodeSegment(headerB64)
    const payload = decodeSegment(payloadB64)

    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: sk.kid })
    expect(payload.iss).toBe(ISSUER)
    expect(payload.sub).toBe("sigilix-gateway")
    expect(payload.aud).toBe("sigilix-vertex-gateway")
    expect(payload.iat).toBe(NOW_SEC - 60) // backdated
    expect(payload.exp).toBe(NOW_SEC + 300) // ~5min

    // The signature verifies against the served public JWK.
    const pub = await crypto.subtle.importKey(
      "jwk",
      { kty: sk.publicJwk.kty, n: sk.publicJwk.n, e: sk.publicJwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pub,
      b64urlToBytes(sigB64),
      utf8(`${headerB64}.${payloadB64}`),
    )
    expect(ok).toBe(true)
  })
})

describe("getVertexAccessToken", () => {
  it("mints once then reuses the cached token within the window", async () => {
    const f = stubGcpFetch({ accessToken: "sa-token", expireTime: rfc3339(T0 + 3600_000) })
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const now = () => T0

    const a = await getVertexAccessToken(env, ctx, { now, jitterMs: 0 })
    const b = await getVertexAccessToken(env, ctx, { now, jitterMs: 0 })

    expect(a).toBe("sa-token")
    expect(b).toBe("sa-token")
    expect(stsCalls(f)).toBe(1) // second call reused the memo — no second mint
  })

  it("refreshes once the token is inside the expireTime-5min window", async () => {
    const f = stubGcpFetch({ accessToken: "sa-token", expireTime: rfc3339(T0 + 4 * 60_000) }) // 4min < 5min refresh
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const now = () => T0

    await getVertexAccessToken(env, ctx, { now, jitterMs: 0 })
    await getVertexAccessToken(env, ctx, { now, jitterMs: 0 })

    expect(stsCalls(f)).toBe(2) // a 4-min token is already inside the refresh window → re-mint
  })

  it("collapses concurrent cold calls into a single mint (single-flight)", async () => {
    const f = stubGcpFetch({ accessToken: "sa-token", expireTime: rfc3339(T0 + 3600_000) })
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const now = () => T0

    const [a, b] = await Promise.all([
      getVertexAccessToken(env, ctx, { now, jitterMs: 0 }),
      getVertexAccessToken(env, ctx, { now, jitterMs: 0 }),
    ])

    expect(a).toBe("sa-token")
    expect(b).toBe("sa-token")
    expect(stsCalls(f)).toBe(1) // both awaited the same pending mint
  })

  it("throws (→ caller 502) when the issuer is unset", async () => {
    stubGcpFetch({ accessToken: "sa-token", expireTime: rfc3339(T0 + 3600_000) })
    const env = makeEnv() // no OPENCLAW_GATEWAY_ISSUER
    const { ctx } = makeCtx()
    await expect(getVertexAccessToken(env, ctx, { now: () => T0, jitterMs: 0 })).rejects.toThrow()
  })
})
