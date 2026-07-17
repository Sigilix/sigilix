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
import {
  getAppInstallation,
  getInstallationToken,
  signGitHubAppJwt,
  resolveRepoInstallationId,
  listAppInstallationIds,
  listAppInstallations,
  listInstallationRepoFullNames,
  listInstallationRepoIds,
  listOrgMembers,
  listOrgMemberIds,
  listInstallationCollaborators,
} from "@/src/shared/adapters/github/github-app"

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

describe("getInstallationToken", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("aborts an in-flight GitHub token exchange on the caller signal", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        )
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace

    const pending = getInstallationToken({
      kv,
      appId: APP_ID,
      privateKey: PKCS8_PEM,
      installationId: 42,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(observedSignal?.aborted).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
  })
})

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
  const stubFetch = (impl: (...a: unknown[]) => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl))

  it("returns the installation id on 200", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: 12345 }), { status: 200 }))
    expect(await resolveRepoInstallationId("123", PKCS8_PEM, "Sigilix", "sigilix")).toBe(12345)
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
    stubFetch(async () => {
      throw new Error("network down")
    })
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url)
        const p = new URL(url).searchParams.get("page")
        if (p === "1") return resp(200, ids(100))
        if (p === "2") return resp(200, [{ id: 1000 }, { id: 1001 }])
        return resp(200, [])
      }),
    )
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(102)
    expect(seen).toHaveLength(2)
  })

  it("exactly-100-then-empty terminates as complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const p = new URL(url).searchParams.get("page")
        return p === "1" ? resp(200, ids(100)) : resp(200, [])
      }),
    )
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(100)
  })

  it("non-OK mid-pagination → partial items + complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const p = new URL(url).searchParams.get("page")
        return p === "1" ? resp(200, ids(100)) : resp(500, {})
      }),
    )
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(false)
    expect(r.items).toHaveLength(100)
  })

  it("fetch throw → complete:false, empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("net")
      }),
    )
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r).toEqual({ items: [], complete: false })
  })

  it("MAX_PAGES cap hit → complete:false (every page returns a full 100)", async () => {
    // If GitHub keeps returning full pages forever, the loop must exit at the
    // defensive cap and mark the result as incomplete (operator re-run signal).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(200, ids(100))),
    )
    const r = await listAppInstallationIds("123", PKCS8_PEM)
    expect(r.complete).toBe(false)
    expect(r.items.length).toBe(50 * 100) // MAX_PAGES × per_page
  })
})

describe("listAppInstallations (with account id/login/type)", () => {
  afterEach(() => vi.unstubAllGlobals())
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it("keeps account id, login and type; defaults missing account fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const p = new URL(url).searchParams.get("page")
        if (p === "1") {
          return resp(200, [
            { id: 1, account: { id: 9001, login: "Sigilix", type: "Organization" } },
            { id: 2, account: { login: "octocat", type: "User" } }, // missing account.id → 0
          ])
        }
        return resp(200, [])
      }),
    )
    const r = await listAppInstallations("123", PKCS8_PEM)
    expect(r.complete).toBe(true)
    expect(r.items).toEqual([
      { id: 1, accountId: 9001, accountLogin: "Sigilix", accountType: "Organization" },
      { id: 2, accountId: 0, accountLogin: "octocat", accountType: "User" },
    ])
  })

  it("fetch throw → complete:false, empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("net")
      }),
    )
    expect(await listAppInstallations("123", PKCS8_PEM)).toEqual({ items: [], complete: false })
  })
})

describe("getAppInstallation", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("binds the requested installation id to its validated immutable account", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/app/installations/42")
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /)
      return new Response(
        JSON.stringify({
          id: 42,
          account: { id: 9001, login: "Sigilix", type: "Organization" },
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(getAppInstallation("123", PKCS8_PEM, 42)).resolves.toEqual({
      id: 42,
      accountId: 9001,
      accountLogin: "Sigilix",
      accountType: "Organization",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns null only when the exact installation does not exist for the App", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    )
    await expect(getAppInstallation("123", PKCS8_PEM, 42)).resolves.toBeNull()
  })

  it.each([
    ["provider failure", 503, { message: "unavailable" }],
    ["mismatched installation id", 200, { id: 43, account: { id: 9001, login: "Sigilix", type: "Organization" } }],
    [
      "unsafe installation id",
      200,
      { id: Number.MAX_SAFE_INTEGER + 1, account: { id: 9001, login: "Sigilix", type: "Organization" } },
    ],
    ["missing immutable account id", 200, { id: 42, account: { login: "Sigilix", type: "Organization" } }],
    [
      "unsafe immutable account id",
      200,
      { id: 42, account: { id: Number.MAX_SAFE_INTEGER + 1, login: "Sigilix", type: "Organization" } },
    ],
    ["empty account login", 200, { id: 42, account: { id: 9001, login: "", type: "Organization" } }],
    ["unknown account type", 200, { id: 42, account: { id: 9001, login: "Sigilix", type: "Bot" } }],
  ])("rejects %s instead of returning an untrusted installation", async (_case, status, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )
    await expect(getAppInstallation("123", PKCS8_PEM, 42)).rejects.toThrow()
  })

  it("rejects an invalid requested installation id before calling GitHub", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(getAppInstallation("123", PKCS8_PEM, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("listOrgMemberIds", () => {
  afterEach(() => vi.unstubAllGlobals())
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  } as unknown as KVNamespace

  it("returns the immutable numeric member ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // First call mints the installation token, then the members page.
        if (url.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }), {
            status: 200,
          })
        }
        const p = new URL(url).searchParams.get("page")
        if (p === "1") return new Response(JSON.stringify([{ id: 555 }, { id: 145802438 }]), { status: 200 })
        return new Response(JSON.stringify([]), { status: 200 })
      }),
    )
    const r = await listOrgMemberIds(kv, "123", PKCS8_PEM, 42, "Sigilix")
    expect(r.complete).toBe(true)
    expect(r.items).toEqual([555, 145802438])
  })

  it("403 (App lacks Members read) → empty + complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }), {
            status: 200,
          })
        }
        return new Response("forbidden", { status: 403 })
      }),
    )
    expect(await listOrgMemberIds(kv, "123", PKCS8_PEM, 42, "Sigilix")).toEqual({ items: [], complete: false })
  })
})

describe("listInstallationRepoFullNames", () => {
  afterEach(() => vi.unstubAllGlobals())
  const kv = { get: async () => null, put: async () => {} } as unknown as Parameters<
    typeof listInstallationRepoFullNames
  >[0]

  it("returns full_names (token fetch + repos page, uses `token` auth scheme)", async () => {
    const authSchemes: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.includes("/access_tokens")) {
          return new Response(
            JSON.stringify({
              token: "tkn",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201 },
          )
        }
        if (url.includes("/installation/repositories")) {
          if (init?.headers?.authorization) authSchemes.push(init.headers.authorization)
          const p = new URL(url).searchParams.get("page")
          return p === "1"
            ? new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] }), {
                status: 200,
              })
            : new Response(JSON.stringify({ repositories: [] }), { status: 200 })
        }
        return new Response("{}", { status: 404 })
      }),
    )
    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r).toEqual({ items: ["o/a", "o/b"], complete: true })
    expect(authSchemes[0]).toBe("token tkn") // installation token uses `token`, not `Bearer`
  })

  it("non-OK on the repos page → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) {
          return new Response(
            JSON.stringify({
              token: "tkn",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201 },
          )
        }
        return new Response("forbidden", { status: 403 })
      }),
    )
    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(false)
  })

  it("non-array repositories in a 200 response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response(JSON.stringify({ repositories: { full_name: "o/a" } }), { status: 200 })
      }),
    )

    expect(await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)).toEqual({
      items: [],
      complete: false,
    })
  })

  it("invalid repository rows make an otherwise successful page incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response(
          JSON.stringify({ repositories: [{ full_name: "o/valid" }, { full_name: "" }, { name: "missing" }] }),
          { status: 200 },
        )
      }),
    )

    expect(await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)).toEqual({
      items: ["o/valid"],
      complete: false,
    })
  })

  it("preserves prior repository pages when a later row is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        const page = new URL(url).searchParams.get("page")
        if (page === "1") {
          return new Response(
            JSON.stringify({
              repositories: Array.from({ length: 100 }, (_, index) => ({ full_name: `org/repo-${index + 1}` })),
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ repositories: [{ full_name: "org/repo-101" }, { name: "invalid" }] }), {
          status: 200,
        })
      }),
    )

    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(false)
    expect(r.items).toHaveLength(101)
  })

  it("invalid JSON in a 200 repositories response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response("{", { status: 200 })
      }),
    )

    expect(await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)).toEqual({
      items: [],
      complete: false,
    })
  })

  it("keeps valid full-page repository pagination complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        const page = new URL(url).searchParams.get("page")
        if (page === "1") {
          return new Response(
            JSON.stringify({
              repositories: Array.from({ length: 100 }, (_, index) => ({ full_name: `org/repo-${index + 1}` })),
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ repositories: [{ full_name: "org/repo-101" }] }), { status: 200 })
      }),
    )

    const r = await listInstallationRepoFullNames(kv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(101)
  })

  it("returns immutable ids only after one exact installation listing completes", async () => {
    const authorization: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.includes("/access_tokens")) return okToken()
        if (init?.headers?.authorization) authorization.push(init.headers.authorization)
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [
              { id: 101, full_name: "Acme/api" },
              { id: 202, full_name: "Acme/worker" },
            ],
          }),
          { status: 200 },
        )
      }),
    )

    await expect(listInstallationRepoIds(kv, "123", PKCS8_PEM, 999)).resolves.toEqual({
      items: [101, 202],
      complete: true,
    })
    expect(authorization).toEqual(["token tkn"])
  })

  it("fails closed when GitHub's total does not prove the returned id set complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response(JSON.stringify({ total_count: 2, repositories: [{ id: 101, full_name: "Acme/api" }] }), {
          status: 200,
        })
      }),
    )

    await expect(listInstallationRepoIds(kv, "123", PKCS8_PEM, 999)).resolves.toEqual({
      items: [101],
      complete: false,
    })
  })
})

// sig-org-members — the roster listings the org page merges in.
const rosterKv = { get: async () => null, put: async () => {} } as unknown as Parameters<typeof listOrgMembers>[0]
const okToken = () =>
  new Response(JSON.stringify({ token: "tkn", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
    status: 201,
  })

describe("listOrgMembers", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("returns stable IDs and dedupes org members by immutable GitHub user ID", async () => {
    const authSchemes: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/orgs/acme/members")) {
          if (init?.headers?.authorization) authSchemes.push(init.headers.authorization)
          const p = new URL(url).searchParams.get("page")
          return p === "1"
            ? new Response(
                JSON.stringify([
                  { id: 101, login: "alice", avatar_url: "https://avatars/alice" },
                  { id: 101, login: "alice-renamed", avatar_url: "https://avatars/alice-renamed" },
                  { id: 102, login: "bob", avatar_url: "https://avatars/bob" },
                  { id: 103, login: "alice", avatar_url: "https://avatars/another-alice" },
                ]),
                { status: 200 },
              )
            : new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response("{}", { status: 404 })
      }),
    )
    const r = await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")
    expect(r).toEqual({
      items: [
        { githubUserId: "101", login: "alice", avatarUrl: "https://avatars/alice" },
        { githubUserId: "102", login: "bob", avatarUrl: "https://avatars/bob" },
        { githubUserId: "103", login: "alice", avatarUrl: "https://avatars/another-alice" },
      ],
      complete: true,
    })
    expect(authSchemes[0]).toBe("token tkn") // installation token → `token`, not `Bearer`
  })

  it("keeps valid rows but marks invalid member rows incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/orgs/acme/members")) {
          return new Response(
            JSON.stringify([
              { id: 201, login: "valid", avatar_url: "https://avatars/valid" },
              { login: "missing" },
              { id: "202", login: "string-id" },
              { id: 0, login: "zero" },
              { id: -1, login: "negative" },
              { id: 1.5, login: "fractional" },
              { id: Number.MAX_SAFE_INTEGER + 1, login: "unsafe" },
              { id: 202, login: "" },
            ]),
            { status: 200 },
          )
        }
        return new Response("{}", { status: 404 })
      }),
    )

    const r = await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")
    expect(r).toEqual({
      items: [{ githubUserId: "201", login: "valid", avatarUrl: "https://avatars/valid" }],
      complete: false,
    })
  })

  it("preserves prior member pages when a later row is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        const page = new URL(url).searchParams.get("page")
        if (page === "1") {
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({ id: index + 1, login: `member-${index + 1}` })),
            ),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify([{ id: 101, login: "member-101" }, { login: "invalid" }]), {
          status: 200,
        })
      }),
    )

    const r = await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")
    expect(r.complete).toBe(false)
    expect(r.items).toHaveLength(101)
  })

  it("non-array members in a 200 response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response(JSON.stringify({ id: 201, login: "not-an-array" }), { status: 200 })
      }),
    )

    expect(await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")).toEqual({
      items: [],
      complete: false,
    })
  })

  it("invalid JSON in a 200 members response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response("{", { status: 200 })
      }),
    )

    expect(await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")).toEqual({
      items: [],
      complete: false,
    })
  })

  it("keeps valid full-page pagination complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        const page = new URL(url).searchParams.get("page")
        if (page === "1") {
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({ id: index + 1, login: `member-${index + 1}` })),
            ),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify([{ id: 101, login: "member-101" }]), { status: 200 })
      }),
    )

    const r = await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(101)
  })

  it("403 (App lacks Members permission) → empty + complete:false (fail-soft, never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        return new Response("forbidden", { status: 403 })
      }),
    )
    const r = await listOrgMembers(rosterKv, "123", PKCS8_PEM, 999, "acme")
    expect(r).toEqual({ items: [], complete: false })
  })
})

describe("listInstallationCollaborators", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("does not traverse repositories when repository enumeration is malformed", async () => {
    const collaboratorRequests: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { name: "missing-full-name" }] }), {
            status: 200,
          })
        }
        collaboratorRequests.push(url)
        return new Response(JSON.stringify([{ id: 301, login: "must-not-be-read" }]), { status: 200 })
      }),
    )

    expect(await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)).toEqual({
      items: [],
      complete: false,
    })
    expect(collaboratorRequests).toEqual([])
  })

  it("dedupes renamed collaborators by immutable ID and keeps distinct IDs with the same login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          const p = new URL(url).searchParams.get("page")
          return p === "1"
            ? new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] }), {
                status: 200,
              })
            : new Response(JSON.stringify({ repositories: [] }), { status: 200 })
        }
        if (url.includes("/repos/o/a/collaborators")) {
          const p = new URL(url).searchParams.get("page")
          return p === "1"
            ? new Response(JSON.stringify([{ id: 301, login: "Dana", avatar_url: "https://avatars/dana" }]), {
                status: 200,
              })
            : new Response(JSON.stringify([]), { status: 200 })
        }
        if (url.includes("/repos/o/b/collaborators")) {
          const p = new URL(url).searchParams.get("page")
          // Same immutable account after a rename + a distinct account that
          // currently has the same display login.
          return p === "1"
            ? new Response(
                JSON.stringify([
                  { id: 301, login: "dana-renamed", avatar_url: "https://avatars/dana2" },
                  { id: 302, login: "Dana", avatar_url: "https://avatars/other-dana" },
                ]),
                { status: 200 },
              )
            : new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response("{}", { status: 404 })
      }),
    )
    const r = await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(true)
    // First-seen display fields win for a stable identity.
    expect(r.items).toEqual([
      { githubUserId: "301", login: "Dana", avatarUrl: "https://avatars/dana" },
      { githubUserId: "302", login: "Dana", avatarUrl: "https://avatars/other-dana" },
    ])
  })

  it("keeps valid rows but marks invalid collaborator rows incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }] }), { status: 200 })
        }
        return new Response(
          JSON.stringify([{ id: 303, login: "valid", avatar_url: "https://avatars/valid" }, { login: "missing-id" }]),
          { status: 200 },
        )
      }),
    )

    expect(await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)).toEqual({
      items: [{ githubUserId: "303", login: "valid", avatarUrl: "https://avatars/valid" }],
      complete: false,
    })
  })

  it("preserves prior repositories when a later collaborator row is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] }), {
            status: 200,
          })
        }
        if (url.includes("/repos/o/a/collaborators")) {
          return new Response(JSON.stringify([{ id: 301, login: "first-repo" }]), { status: 200 })
        }
        return new Response(JSON.stringify([{ id: 302, login: "second-repo" }, { login: "invalid" }]), {
          status: 200,
        })
      }),
    )

    const r = await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(false)
    expect(r.items.map((item) => item.githubUserId)).toEqual(["301", "302"])
  })

  it("non-array collaborators in a 200 response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }] }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 303, login: "not-an-array" }), { status: 200 })
      }),
    )

    expect(await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)).toEqual({
      items: [],
      complete: false,
    })
  })

  it("invalid JSON in a 200 collaborators response → complete:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }] }), { status: 200 })
        }
        return new Response("{", { status: 200 })
      }),
    )

    expect(await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)).toEqual({
      items: [],
      complete: false,
    })
  })

  it("keeps valid full-page collaborator pagination complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }] }), { status: 200 })
        }
        const page = new URL(url).searchParams.get("page")
        if (page === "1") {
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({ id: index + 1, login: `collaborator-${index + 1}` })),
            ),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify([{ id: 101, login: "collaborator-101" }]), { status: 200 })
      }),
    )

    const r = await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(true)
    expect(r.items).toHaveLength(101)
  })

  it("a collaborators page error marks complete:false but keeps what it got", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access_tokens")) return okToken()
        if (url.includes("/installation/repositories")) {
          const p = new URL(url).searchParams.get("page")
          return p === "1"
            ? new Response(JSON.stringify({ repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] }), {
                status: 200,
              })
            : new Response(JSON.stringify({ repositories: [] }), { status: 200 })
        }
        if (url.includes("/repos/o/a/collaborators")) {
          return new Response(JSON.stringify([{ id: 401, login: "kept", avatar_url: "https://avatars/kept" }]), {
            status: 200,
          })
        }
        return new Response("forbidden", { status: 403 }) // the later repo fails
      }),
    )
    const r = await listInstallationCollaborators(rosterKv, "123", PKCS8_PEM, 999)
    expect(r.complete).toBe(false)
    expect(r.items).toEqual([{ githubUserId: "401", login: "kept", avatarUrl: "https://avatars/kept" }])
  })
})
