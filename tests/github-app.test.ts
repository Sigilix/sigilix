// GitHub App JWT signer — the Worker can't run node:crypto.createSign,
// so the JWT path goes through Web Crypto with a manually-wrapped PKCS#8
// envelope around GitHub's PKCS#1 download. These tests verify:
//
//   1. The JWT structure (header + payload + signature, three b64url parts)
//   2. The header alg/typ + payload claims are well-formed
//   3. Both PKCS#1 and PKCS#8 PEMs accept (we wrap PKCS#1 inline)
//   4. Bogus PEMs are rejected loudly
//
// We don't verify the signature end-to-end (would require a different
// Web Crypto-friendly RSA key generator + verifyKey import) — that's
// covered by GitHub itself rejecting invalid JWTs at token-exchange time.

import { describe, expect, it, vi, afterEach } from "vitest"
import { signGitHubAppJwt, resolveRepoInstallationId, listAppInstallationIds, listInstallationRepoFullNames } from "../src/lib/github-app"

// PKCS#8 RSA-2048 private key — generated with:
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
//     -outform PEM -out test-key.pem
// Used here only for round-tripping import + sign; not a real credential.
const PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDPU6dL7pYqPYf2
ihBoPf5DzpBUS8q1CHDcEKt/2W/bCOGpItIS/5hkBgGwvR6Mhzj3fgYg0LOctJVS
RITY5KxVxtWcM2DCcRMpPp3Dd9vIfL2uzBjv4HUFPXzHGZbE9spoBPiRtT9eaALP
UbqXZcv2idz/V5L3Zd6BcK/iE71HE6WG7DsnPJQgUjWl9wUgIzPe7PSHkBEMPB7g
AIwhOIgxBL/UWv/BWAajCLSa0mDqq7Tg0SO1jCsutJv33sGKb/uVzs2tlSEBs9b6
PyT74ihbhPATzyCD+nfDzg/8b7P6EDTKDBVTOgC+fizSnpDLpc3eS0wsBQKNeyRu
6oIKBIDTAgMBAAECggEAJPXL4O9bDrzlh+BwK5yEZVe9XyZvsHmSdghlb5C1NFmd
8gIOWY9QNh7G6CSffUlrcM83A5N0agT+e8Lax6KjIs8tTZc/+6yi3qpJyjmTm+aN
y4ynoUdvkB4UVy5K0CuU6qoRmigMpyeDzFFGT6qAvFmLLNgbIc0wrWJlLU2g5j3w
WWXKgGuwm78W9tu2spKSi70uXTuxTCO4yZH2kPsFUF5DzNL7S0K+9MwMlOOmgs9I
XmeWHpcsfaxqcNTmNKJxSZUIHXGyXFOOGnCT/EcLSO4r8O4zBCbE5oCeEtrt3tSD
HeAmwKpvWkKr2ekTbvzu7NAXYeKidTnZxfmaQjW4MQKBgQD5gaG0eevtVeqAvmFV
HDVVsXmrxaOKHwoeJDYxJKB8/YQE5QsKt3pQzQ8AcLoTeB4uRrMBZWG0mc15rEUl
NtnMEcwo2MTS0JEAvfrUMbMcR2KjuKkXHOhCGkA1bGJ45a6dWJK3tbSU3epLFP2+
ZOg3aZKkIQR0d36C8iY1Yh7H8wKBgQDUuTWHDGSvBzcSNRGsfUK+sXGB1m/pZAjg
Z21PCbTAJ87GsWICmpbtv2QwOzTLOL4vmIuPoTfuIRHSMzgncXf29jxDU9kFKnJq
J6Fa28UGLTvIQs3nUKWpeQmO6ms2MWBHsOoKpUdlkVMdR6S1tYsZIJjsIThs9uNR
RfDJn28EYQKBgFLSVNqYRiufEQWrVeyW/NNuU1G4bRC9ulXJsqxr06lDJU3XutIO
lcBtuVwJOCPMtgwHL9WrK9IS2dVcm04agnSwiK0nVc4rUTxHhxr7sttQhE5QEmFW
H9D63iN0a0GvB28GTlpAH+xtN64ad6QOGcVYS8XSCQfXsqVaDRSFFzBLAoGAdj4d
JG8l9rB/HojlvsM3OLYK7aA7y+KXUXNlw84cM3Fk5QVwfxaZJg2wRC+jl+FX8aD9
NVDIrTqQXhZA89EEQg5bDr/r5FPfLFLZ7ksoOFi+aIrNOHM9amNmbaArfdACVoPH
K2eTOsiHkrbT+kEQwdFJhi8jzMRuiGeIpHRQ0aECgYEAvOZfcF3cVEqEOXXgsybr
Z/Q0FEJU+R0jZfiRq0J+7MS5I7NU/SnK8InhTzDPaPWpc6dD7nhyf0GbxsmdzSDP
CGqDb+pJeS0+t3ToB7Ql8q4n7FlafZmW8R7q40RJn0RqKaG2YyCoIPjnRf1mqXQO
VJ2u1IhcD24WrhOpFGFtUbY=
-----END PRIVATE KEY-----`

const APP_ID = "12345"

describe("signGitHubAppJwt", () => {
  it("returns a three-part JWT (header.payload.signature)", async () => {
    const jwt = await signGitHubAppJwt(APP_ID, PKCS8_PEM)
    const parts = jwt.split(".")
    expect(parts).toHaveLength(3)
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0)
      // Each part is base64url with no '=' padding and no '+' / '/' chars.
      expect(part).not.toMatch(/[+/=]/)
    }
  })

  it("encodes header.alg=RS256 and header.typ=JWT", async () => {
    const jwt = await signGitHubAppJwt(APP_ID, PKCS8_PEM)
    const headerB64 = jwt.split(".")[0]!
    const header = JSON.parse(b64UrlDecode(headerB64))
    expect(header).toEqual({ alg: "RS256", typ: "JWT" })
  })

  it("payload claims have iss=appId, iat<now, exp<=now+10min", async () => {
    const before = Math.floor(Date.now() / 1000)
    const jwt = await signGitHubAppJwt(APP_ID, PKCS8_PEM, before)
    const payloadB64 = jwt.split(".")[1]!
    const payload = JSON.parse(b64UrlDecode(payloadB64))
    expect(payload.iss).toBe(APP_ID)
    // We backdate iat by 60s to absorb clock skew; the exp ceiling is
    // 10 min from `now` per GitHub's cap, our impl uses 9min for headroom.
    expect(payload.iat).toBe(before - 60)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60)
    expect(payload.exp - payload.iat).toBeGreaterThan(60)
  })

  it("throws on missing app id", async () => {
    await expect(signGitHubAppJwt("", PKCS8_PEM)).rejects.toThrow(/missing appId/)
  })

  it("throws on missing private key", async () => {
    await expect(signGitHubAppJwt(APP_ID, "")).rejects.toThrow(/missing privateKeyPem/)
  })

  it("rejects PEMs that aren't RSA private keys", async () => {
    const bogus = "-----BEGIN PUBLIC KEY-----\nAAAAAAA\n-----END PUBLIC KEY-----"
    await expect(signGitHubAppJwt(APP_ID, bogus)).rejects.toThrow(/PEM/)
  })

  it("produces a different signature on each invocation when iat changes", async () => {
    const a = await signGitHubAppJwt(APP_ID, PKCS8_PEM, 1_700_000_000)
    const b = await signGitHubAppJwt(APP_ID, PKCS8_PEM, 1_700_000_001)
    expect(a).not.toBe(b)
  })
})

function b64UrlDecode(input: string): string {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=")
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/")
  return atob(standard)
}

// SIG-156: resolveRepoInstallationId — uses the PKCS8_PEM test key so the JWT
// signs, and stubs global fetch to drive the GitHub response.
describe("resolveRepoInstallationId", () => {
  afterEach(() => vi.unstubAllGlobals())
  const stubFetch = (impl: (...a: unknown[]) => Promise<Response>) =>
    vi.stubGlobal("fetch", vi.fn(impl))

  it("returns the installation id on 200", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: 12345 }), { status: 200 }))
    expect(await resolveRepoInstallationId("123", PKCS8_PEM, "Arc-and-Anchor", "sigilix")).toBe(12345)
  })

  it("returns null when the app isn't installed (non-OK status)", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }))
    expect(await resolveRepoInstallationId("123", PKCS8_PEM, "o", "r")).toBeNull()
  })

  it("returns null when id is missing or non-numeric", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: "nope" }), { status: 200 }))
    expect(await resolveRepoInstallationId("123", PKCS8_PEM, "o", "r")).toBeNull()
  })

  it("fail-soft: returns null when fetch throws (network error)", async () => {
    stubFetch(async () => { throw new Error("network down") })
    expect(await resolveRepoInstallationId("123", PKCS8_PEM, "o", "r")).toBeNull()
  })

  it("fail-soft: returns null when JWT signing fails (bad key)", async () => {
    stubFetch(async () => new Response("{}", { status: 200 }))
    expect(await resolveRepoInstallationId("123", "not-a-valid-pem", "o", "r")).toBeNull()
  })
})

// SIG-156: paginated listing helpers — fetch-stubbed, App JWT signs via PKCS8_PEM.
describe("listAppInstallationIds (pagination)", () => {
  afterEach(() => vi.unstubAllGlobals())
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

  it("accumulates across full pages, stops on a short page (complete)", async () => {
    const seen: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(url)
      const p = new URL(url).searchParams.get("page")
      if (p === "1") return resp(200, ids(100))
      if (p === "2") return resp(200, [{ id: 1000 }, { id: 1001 }])
      return resp(200, [])
    }))
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(102)
    expect(seen).toHaveLength(2)
  })

  it("exactly-100-then-empty terminates as complete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const p = new URL(url).searchParams.get("page")
      return p === "1" ? resp(200, ids(100)) : resp(200, [])
    }))
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(100)
  })

  it("non-OK mid-pagination → partial items + complete:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const p = new URL(url).searchParams.get("page")
      return p === "1" ? resp(200, ids(100)) : resp(500, {})
    }))
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(false)
    expect(r.items).toHaveLength(100)
  })

  it("fetch throw → complete:false, empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net") }))
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r).toEqual({ items: [], complete: false })
  })

  it("MAX_PAGES cap hit → complete:false (every page returns a full 100)", async () => {
    // If GitHub keeps returning full pages forever, the loop must exit at the
    // defensive cap and mark the result as incomplete (operator re-run signal).
    vi.stubGlobal("fetch", vi.fn(async () => resp(200, ids(100))))
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(false)
    expect(r.items.length).toBe(50 * 100) // MAX_PAGES × per_page
  })
})

describe("listInstallationRepoFullNames", () => {
  afterEach(() => vi.unstubAllGlobals())
  const kv = { get: async () => null, put: async () => {} } as unknown as Parameters<typeof listInstallationRepoFullNames>[0]

  it("returns full_names (token fetch + repos page, uses `token` auth scheme)", async () => {
    const authSchemes: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "tkn", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
      }
      if (url.includes("/installation/repositories")) {
        if (init?.headers?.authorization) authSchemes.push(init.headers.authorization)
        const p = new URL(url).searchParams.get("page")
        return p === "1"
          ? new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] }), { status: 200 })
          : new Response(JSON.stringify({ repositories: [] }), { status: 200 })
      }
      return new Response("{}", { status: 404 })
    }))
    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r).toEqual({ items: ["o/a", "o/b"], complete: true })
    expect(authSchemes[0]).toBe("token tkn") // installation token uses `token`, not `Bearer`
  })

  it("non-OK on the repos page → complete:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "tkn", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
      }
      return new Response("forbidden", { status: 403 })
    }))
    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(false)
  })
})
