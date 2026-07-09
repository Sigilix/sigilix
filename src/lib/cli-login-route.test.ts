// sig-cli-login — tests for the `sigilix login` Worker endpoints
// (cli-login-route.ts): the loopback authorize→exchange happy path, PKCE/state
// verification, single-use + expiry of the one-time code, the unauthenticated
// authorize bounce, and the bearer-authed /v1/cli/me plan + cli_byok entitlement.
//
// Session auth via a seeded fake KV (auth-session.ts's SessionRecord shape); D1
// via the real-SQLite shim with the account_tenant/api_key (0003) + name (0009)
// + tenant (0001) schema applied.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleCliAuthorizeRoute, handleCliExchangeRoute, handleCliMeRoute } from "@/src/lib/cli-login-route"
import { linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
// 32-byte AES-256 key (base64url) — the production secret shape. Only the
// org-install fallback tests decrypt a token, so they seed a REAL encrypted
// session (createSession) under this key; the other tests use the token-less
// seedSession above.
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))

// A valid RSA PKCS#8 test key so `signGitHubAppJwt` can sign a real JWT in the
// app-server-to-server fallback test (same key github-app.test.ts uses).
const APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
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

// A KV shim that HONORS expirationTtl so the expiry test is real: an entry
// written with { expirationTtl } older than now is treated as absent.
function makeKV(): KVNamespace {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  return {
    get: async (key: string, type?: "json") => {
      const entry = store.get(key)
      if (!entry) return null
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        store.delete(key)
        return null
      }
      return type === "json" ? JSON.parse(entry.value) : entry.value
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null
      store.set(key, { value, expiresAt })
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    // Test-only escape hatch to force-expire an entry (see the expiry test).
    __expire: (key: string) => {
      const entry = store.get(key)
      if (entry) entry.expiresAt = Date.now() - 1
    },
  } as unknown as KVNamespace & { __expire: (key: string) => void }
}

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number, login = "octocat"): Promise<void> {
  const record: SessionRecord = {
    login,
    githubUserId,
    encryptedAccessToken: "unused-in-these-tests",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  await kv.put(`auth_session:${sessionId}`, JSON.stringify(record))
}

/** Seed a REAL encrypted session (so the org-install fallback can decrypt the GitHub token). */
async function seedRealSession(kv: KVNamespace, sessionId: string, githubUserId: number, login: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

/** Stub `GET /user/installations` to return exactly the given installation ids. */
function stubUserInstallations(ids: number[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  )
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * Route GitHub calls for the app-server-to-server fallback test, mirroring the
 * REAL production failure: the user-to-server token is DEAD (`/user/installations`
 * 401s), so resolution must go through the App's own JWT + org-members roster.
 */
function stubAppFallback(opts: {
  installations: Array<{ id: number; accountId: number; login: string; type: string }>
  /** org login → the IMMUTABLE numeric ids of its members (matched, not the login). */
  orgMembers: Record<string, number[]>
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      // 1) user-token path is dead → 401 (the production symptom).
      if (url.includes("/user/installations")) return new Response("unauthorized", { status: 401 })
      // 2) App JWT lists installations WITH account info (id + login + type).
      if (url.includes("/app/installations?")) {
        return jsonRes(
          opts.installations.map((i) => ({ id: i.id, account: { id: i.accountId, login: i.login, type: i.type } })),
        )
      }
      // 3) installation access-token mint (for the org-members roster call).
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        return jsonRes({ token: "inst-tok", expires_at: new Date(Date.now() + 3600_000).toISOString() })
      }
      // 4) org member roster via the installation token — matched on member id.
      const m = /\/orgs\/([^/]+)\/members/.exec(url)
      if (m) {
        const ids = opts.orgMembers[decodeURIComponent(m[1]!)] ?? []
        return jsonRes(ids.map((id) => ({ id })))
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function reqWithSession(url: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { ...init, headers })
}

function jsonPost(url: string, sessionId: string | null, body: unknown): Request {
  return reqWithSession(url, sessionId, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const SCHEMA_FILES = [
  "0001_create_tenant_repo_usage.sql",
  "0003_create_account_tenant_and_api_key.sql",
  "0009_add_api_key_name.sql",
]

async function applySchema(db: D1Database): Promise<void> {
  for (const f of SCHEMA_FILES) {
    await db.exec(readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8"))
  }
}

/** PKCE S256 challenge for a verifier — the exact transform the Worker verifies. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64urlEncode(new Uint8Array(digest))
}

/** A fresh CLI-side (verifier, challenge, state) triple. */
async function pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
  return { verifier, challenge: await s256(verifier), state }
}

describe("handleCliAuthorizeRoute (POST /v1/cli/authorize)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
  })

  it("401 (bounces to login) when unauthenticated", async () => {
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(jsonPost("https://x/v1/cli/authorize", null, { state, challenge }), env)
    expect(res.status).toBe(401)
  })

  it("415 (CSRF guard) when Content-Type is not application/json", async () => {
    await seedSession(kv, "sess-1", 111)
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      reqWithSession("https://x/v1/cli/authorize", "sess-1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ state, challenge }),
      }),
      env,
    )
    expect(res.status).toBe(415)
  })

  it("400 on a missing/short state or challenge", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state: "short", challenge: "" }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("409 when the session's user has no linked installation", async () => {
    await seedSession(kv, "sess-1", 111)
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state, challenge }),
      env,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_installation")
  })

  it("mints a key bound to a one-time code and returns ONLY the code (never the key)", async () => {
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state, challenge }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; login: string; key?: string }
    expect(body.code).toBeTruthy()
    expect(body.login).toBe("octocat")
    expect(body.key).toBeUndefined() // the key never leaves via authorize

    // A hashed key row was persisted; the plaintext is not in the response.
    const row = await db.prepare("SELECT installation_id, name FROM api_key WHERE created_by = ?").bind("111").first<{
      installation_id: number
      name: string
    }>()
    expect(row?.installation_id).toBe(42)
    expect(row?.name).toBe("Sigilix CLI")
  })

  it("resolves an ORG-only installation live (org owner, no D1 link) and mints against it", async () => {
    // The regression: the founder is an OWNER of an org that HAS the App
    // installed (installation 134811639), but has NO personal install and NO
    // account_tenant link — /setup only ever links a PERSONAL installer. Before
    // the fix this 409'd ("no installed GitHub App"); now the route resolves the
    // org install live from GitHub's `GET /user/installations` and persists it.
    await seedRealSession(kv, "sess-org", 4242, "damartinezjulio")
    const orgEnv = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
    stubUserInstallations([134811639]) // an ORG install the user is an owner of

    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-org", { state, challenge }),
      orgEnv,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; login: string }
    expect(body.code).toBeTruthy()
    expect(body.login).toBe("damartinezjulio")

    // The account_tenant trust link is now persisted (fast path next time), and
    // the minted key is bound to the ORG installation.
    const link = await db
      .prepare("SELECT installation_id FROM account_tenant WHERE github_user_id = ?")
      .bind("4242")
      .first<{ installation_id: number }>()
    expect(link?.installation_id).toBe(134811639)
    const key = await db
      .prepare("SELECT installation_id FROM api_key WHERE created_by = ?")
      .bind("4242")
      .first<{ installation_id: number }>()
    expect(key?.installation_id).toBe(134811639)
  })

  it("resolves an org install via the APP server-to-server path when the user token is DEAD", async () => {
    // The REAL production failure: the founder (org owner) reused a browser
    // session whose short-lived GitHub App user token had expired without
    // refresh material, so `GET /user/installations` 401s and the user-token
    // path finds nothing. Resolution must fall back to the App's OWN credentials
    // (JWT → /app/installations → org member roster), which don't depend on the
    // caller's token being fresh.
    await seedRealSession(kv, "sess-dead", 145802438, "damartinezjulio")
    const appEnv = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
    } as unknown as Env
    stubAppFallback({
      installations: [{ id: 134811639, accountId: 9001, login: "Sigilix", type: "Organization" }],
      orgMembers: { Sigilix: [555, 145802438] }, // the founder's immutable id is a member
    })

    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-dead", { state, challenge }),
      appEnv,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; login: string }
    expect(body.code).toBeTruthy()

    // The trust link + key are bound to the org install resolved server-side.
    const link = await db
      .prepare("SELECT installation_id FROM account_tenant WHERE github_user_id = ?")
      .bind("145802438")
      .first<{ installation_id: number }>()
    expect(link?.installation_id).toBe(134811639)
    const key = await db
      .prepare("SELECT installation_id FROM api_key WHERE created_by = ?")
      .bind("145802438")
      .first<{ installation_id: number }>()
    expect(key?.installation_id).toBe(134811639)
  })

  it("still 409s when the user token is dead AND the caller is not an org member", async () => {
    await seedRealSession(kv, "sess-nomember", 999, "stranger")
    const appEnv = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
    } as unknown as Env
    // The org install exists, but id 999 is NOT in its member roster.
    stubAppFallback({
      installations: [{ id: 134811639, accountId: 9001, login: "Sigilix", type: "Organization" }],
      orgMembers: { Sigilix: [145802438] },
    })

    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-nomember", { state, challenge }),
      appEnv,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_installation")
  })
})

describe("handleCliExchangeRoute (POST /v1/cli/exchange)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
  })

  /** Run authorize and return the issued code + the CLI-side pkce triple. */
  async function authorize(): Promise<{ code: string; verifier: string; challenge: string; state: string }> {
    const p = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state: p.state, challenge: p.challenge }),
      env,
    )
    const body = (await res.json()) as { code: string }
    return { code: body.code, ...p }
  }

  it("happy path: matching state + PKCE verifier returns the plaintext key exactly once", async () => {
    const { code, verifier, state } = await authorize()
    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { key: string; login: string; installationId: number }
    expect(body.key).toMatch(/^sigilix_live_/)
    expect(body.login).toBe("octocat")
    expect(body.installationId).toBe(42)

    // The returned key authenticates: its hash matches a live api_key row.
    const row = await db
      .prepare("SELECT id FROM api_key WHERE key_hash = ? AND revoked_at IS NULL")
      .bind(await sha256Hex(body.key))
      .first<{ id: string }>()
    expect(row?.id).toBeTruthy()
  })

  it("rejects a reused one-time code (single-use)", async () => {
    const { code, verifier, state } = await authorize()
    const first = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(first.status).toBe(200)
    const second = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(second.status).toBe(400)
    expect(((await second.json()) as { error: string }).error).toBe("invalid_or_expired_code")
  })

  it("rejects a state mismatch", async () => {
    const { code, verifier } = await authorize()
    const wrongState = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state: wrongState }),
      env,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("state_mismatch")
  })

  it("rejects a PKCE verifier that does not hash to the challenge", async () => {
    const { code, state } = await authorize()
    const wrongVerifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier: wrongVerifier, state }),
      env,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("pkce_verification_failed")
  })

  it("rejects an expired code", async () => {
    const { code, verifier, state } = await authorize()
    ;(kv as unknown as { __expire: (k: string) => void }).__expire(`cli_login_code:${code}`)
    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_or_expired_code")
  })
})

describe("handleCliMeRoute (GET /v1/cli/me)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
  })

  /** Mint a key via authorize→exchange and return its plaintext + installationId. */
  async function loginKey(installationId: number): Promise<string> {
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const p = await pkce()
    const authRes = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state: p.state, challenge: p.challenge }),
      env,
    )
    const { code } = (await authRes.json()) as { code: string }
    const exRes = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier: p.verifier, state: p.state }),
      env,
    )
    return ((await exRes.json()) as { key: string }).key
  }

  function meReq(key: string | null): Request {
    const headers = new Headers()
    if (key) headers.set("authorization", `Bearer ${key}`)
    return new Request("https://x/v1/cli/me", { headers })
  }

  it("401 without a bearer key", async () => {
    expect((await handleCliMeRoute(meReq(null), env)).status).toBe(401)
  })

  it("free tier: cli_byok is NOT entitled", async () => {
    // Insert a tenant row with a free tier for installation 42.
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, 'free', ?, ?)")
      .bind(42, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
    const key = await loginKey(42)
    const res = await handleCliMeRoute(meReq(key), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      plan: string
      entitlements: { cli_byok: boolean }
      upsell: { cli_byok: string }
    }
    expect(body.plan).toBe("free")
    expect(body.entitlements.cli_byok).toBe(false)
    expect(body.upsell.cli_byok).toContain("Pro feature")
  })

  it("pro tier: cli_byok IS entitled", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, 'pro', ?, ?)")
      .bind(43, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
    const key = await loginKey(43)
    const res = await handleCliMeRoute(meReq(key), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plan: string; entitlements: { cli_byok: boolean } }
    expect(body.plan).toBe("pro")
    expect(body.entitlements.cli_byok).toBe(true)
  })

  it("unknown plan (no tenant row): cli_byok fails closed to NOT entitled", async () => {
    const key = await loginKey(99) // no tenant row for installation 99
    const res = await handleCliMeRoute(meReq(key), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plan: string | null; entitlements: { cli_byok: boolean } }
    expect(body.plan).toBeNull()
    expect(body.entitlements.cli_byok).toBe(false)
  })
})
