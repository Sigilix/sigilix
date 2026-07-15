// sig-cli-login — tests for the `sigilix login` Worker endpoints
// (cli-login-route.ts): the loopback authorize→exchange happy path, PKCE/state
// verification, single-use + expiry of the one-time code, the unauthenticated
// authorize bounce, and the bearer-authed /v1/cli/me plan + cli_byok entitlement.
//
// Session auth uses real encrypted KV records. D1 uses the real-SQLite shim
// with the account_tenant/api_key (0003) + name (0009) + tenant (0001)
// schema, plus managed org access (0022) only in the tests that exercise it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleCliAuthorizeRoute, handleCliExchangeRoute, handleCliMeRoute } from "@/src/lib/cli-login-route"
import { purgeUserAccount } from "@/src/lib/account-store"
import { linkAccountTenant } from "@/src/lib/api-key-store"
import { resolveApiKey } from "@/src/lib/api-key-resolver"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { removeOrgWorkspaceAccess } from "@/src/features/org-membership"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
// 32-byte AES-256 key (base64url) — the production secret shape. Every
// authenticated test uses createSession so the central exact-install guard can
// decrypt and refresh the same realistic session shape production sees.
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))

const APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDPU6dL7pYqPYf2ihBoPf5DzpBUS8q1CHDcEKt/2W/bCOGpItIS/5hkBgGwvR6Mhzj3fgYg0LOctJVSRITY5KxVxtWcM2DCcRMpPp3Dd9vIfL2uzBjv4HUFPXzHGZbE9spoBPiRtT9eaALPUbqXZcv2idz/V5L3Zd6BcK/iE71HE6WG7DsnPJQgUjWl9wUgIzPe7PSHkBEMPB7gAIwhOIgxBL/UWv/BWAajCLSa0mDqq7Tg0SO1jCsutJv33sGKb/uVzs2tlSEBs9b6PyT74ihbhPATzyCD+nfDzg/8b7P6EDTKDBVTOgC+fizSnpDLpc3eS0wsBQKNeyRu6oIKBIDTAgMBAAECggEAJPXL4O9bDrzlh+BwK5yEZVe9XyZvsHmSdghlb5C1NFmd8gIOWY9QNh7G6CSffUlrcM83A5N0agT+e8Lax6KjIs8tTZc/+6yi3qpJyjmTm+aNy4ynoUdvkB4UVy5K0CuU6qoRmigMpyeDzFFGT6qAvFmLLNgbIc0wrWJlLU2g5j3wWWXKgGuwm78W9tu2spKSi70uXTuxTCO4yZH2kPsFUF5DzNL7S0K+9MwMlOOmgs9IXmeWHpcsfaxqcNTmNKJxSZUIHXGyXFOOGnCT/EcLSO4r8O4zBCbE5oCeEtrt3tSDHeAmwKpvWkKr2ekTbvzu7NAXYeKidTnZxfmaQjW4MQKBgQD5gaG0eevtVeqAvmFVHDVVsXmrxaOKHwoeJDYxJKB8/YQE5QsKt3pQzQ8AcLoTeB4uRrMBZWG0mc15rEUlNtnMEcwo2MTS0JEAvfrUMbMcR2KjuKkXHOhCGkA1bGJ45a6dWJK3tbSU3epLFP2+ZOg3aZKkIQR0d36C8iY1Yh7H8wKBgQDUuTWHDGSvBzcSNRGsfUK+sXGB1m/pZAjgZ21PCbTAJ87GsWICmpbtv2QwOzTLOL4vmIuPoTfuIRHSMzgncXf29jxDU9kFKnJqJ6Fa28UGLTvIQs3nUKWpeQmO6ms2MWBHsOoKpUdlkVMdR6S1tYsZIJjsIThs9uNRRfDJn28EYQKBgFLSVNqYRiufEQWrVeyW/NNuU1G4bRC9ulXJsqxr06lDJU3XutIOlcBtuVwJOCPMtgwHL9WrK9IS2dVcm04agnSwiK0nVc4rUTxHhxr7sttQhE5QEmFWH9D63iN0a0GvB28GTlpAH+xtN64ad6QOGcVYS8XSCQfXsqVaDRSFFzBLAoGAdj4dJG8l9rB/HojlvsM3OLYK7aA7y+KXUXNlw84cM3Fk5QVwfxaZJg2wRC+jl+FX8aD9NVDIrTqQXhZA89EEQg5bDr/r5FPfLFLZ7ksoOFi+aIrNOHM9amNmbaArfdACVoPHK2eTOsiHkrbT+kEQwdFJhi8jzMRuiGeIpHRQ0aECgYEAvOZfcF3cVEqEOXXgsybrZ/Q0FEJU+R0jZfiRq0J+7MS5I7NU/SnK8InhTzDPaPWpc6dD7nhyf0GbxsmdzSDPCGqDb+pJeS0+t3ToB7Ql8q4n7FlafZmW8R7q40RJn0RqKaG2YyCoIPjnRf1mqXQOVJ2u1IhcD24WrhOpFGFtUbY=
-----END PRIVATE KEY-----`

interface TestKV extends KVNamespace {
  __raw(key: string): string | null
}

// A KV shim that honors expirationTtl for realistic encrypted sessions. CLI
// grants deliberately never use KV; __raw proves authorize did not persist one.
function makeKV(): TestKV {
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
    __raw: (key: string) => store.get(key)?.value ?? null,
  } as unknown as TestKV
}

async function seedSession(
  db: D1Database,
  kv: KVNamespace,
  sessionId: string,
  githubUserId: number,
  login = "octocat",
): Promise<string> {
  const userId = crypto.randomUUID()
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO user_identity" +
        " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(userId, String(githubUserId), JSON.stringify(["github"]), now, now)
    .run()
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    userId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
  return userId
}

interface StubInstallation {
  id: number
  account?: { login: string; type: "Organization" | "User" }
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

/**
 * Stub the two user-token endpoints consumed by the central exact-installation
 * guard. The default is a plain member of every listed organization.
 */
function stubGitHub(
  installations: StubInstallation[],
  options: { liveRole?: "admin" | "member"; status?: number } = {},
): ReturnType<typeof vi.fn> {
  const status = options.status ?? 200
  const normalized = installations.map((installation) => ({
    id: installation.id,
    account: installation.account ?? { login: `org-${installation.id}`, type: "Organization" as const },
  }))
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes("/user/installations")) {
      if (status !== 200) return new Response("unauthorized", { status })
      return jsonRes({ total_count: normalized.length, installations: normalized })
    }
    if (url.includes("/user/memberships/orgs")) {
      if (status !== 200) return new Response("unauthorized", { status })
      const memberships = normalized
        .filter((installation) => installation.account.type === "Organization")
        .map((installation) => ({
          role: options.liveRole ?? "member",
          state: "active",
          organization: { login: installation.account.login },
        }))
      return jsonRes(memberships)
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.useRealTimers()
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
  "0004_create_usage_events.sql",
  "0005_create_user_profile.sql",
  "0006_create_user_identity.sql",
  "0008_create_email_verification_token.sql",
  "0009_add_api_key_name.sql",
  "0010_add_gitlab_id_to_user_identity.sql",
  "0020_create_stripe_seat_reconciliation.sql",
  "0021_create_app_memory.sql",
]

const ORG_ACCESS_SCHEMA_FILES = [
  "0022_create_org_workspace_access.sql",
  "0023_add_org_seat_billing_operation_context.sql",
  "0028_create_org_workspace_seat_assignment.sql",
]

async function applySchema(db: D1Database): Promise<void> {
  for (const f of SCHEMA_FILES) {
    await db.exec(readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8"))
  }
}

async function applyOrgAccessSchema(db: D1Database): Promise<void> {
  for (const file of ORG_ACCESS_SCHEMA_FILES) {
    await db.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"))
  }
}

async function seedStoredAccess(
  db: D1Database,
  options: {
    installationId?: number
    githubUserId?: string
    role?: "admin" | "member"
    revokedAt?: string | null
  } = {},
): Promise<void> {
  const installationId = options.installationId ?? 42
  const githubUserId = options.githubUserId ?? "111"
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      installationId,
      githubUserId,
      options.role ?? "member",
      now,
      now,
      options.revokedAt ?? null,
      "test-seed",
      `seed-${installationId}-${githubUserId}`,
      "member_added_or_regranted",
    )
    .run()
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store")
}

function expectNoPersistedGrant(kv: TestKV, code: string): void {
  expect(kv.__raw(`cli_login_code:${code}`)).toBeNull()
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
  let kv: TestKV
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
  })

  it("401 (bounces to login) when unauthenticated", async () => {
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(jsonPost("https://x/v1/cli/authorize", null, { state, challenge }), env)
    expect(res.status).toBe(401)
    expectPrivateNoStore(res)
  })

  it("415 (CSRF guard) when Content-Type is not application/json", async () => {
    await seedSession(db, kv, "sess-1", 111)
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
    await seedSession(db, kv, "sess-1", 111)
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state: "short", challenge: "" }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("409 when the session's user has no linked installation", async () => {
    await seedSession(db, kv, "sess-1", 111)
    stubGitHub([])
    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state, challenge }),
      env,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_installation")
    expectPrivateNoStore(res)
  })

  it("requires a durable account identity before issuing a stateless grant", async () => {
    await createSession({
      kv,
      sessionId: "legacy-session",
      login: "octocat",
      githubUserId: 111,
      accessToken: "ghu_test_token",
      encryptionKeyB64url: ENC_KEY,
    })
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }])
    const { challenge, state } = await pkce()

    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "legacy-session", { state, challenge }),
      env,
    )
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: "account_identity_required" })
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("returns only a sealed non-secret grant and defers key creation until exchange", async () => {
    await seedSession(db, kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }])
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
    expectPrivateNoStore(res)

    // Authorize returns an opaque sealed grant. It must not store either side
    // of the credential or any CLI-code record before PKCE exchange.
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    expectNoPersistedGrant(kv, body.code)
    expect(body.code).not.toContain("sigilix_live_")
    expect(body.code).not.toContain("keyPlaintext")
    expect(body.code).not.toContain("keyHash")
    expect(body.code).not.toContain("sess-1")
    expect(body.code).not.toContain("octocat")
  })

  it("resolves an ORG-only installation live (org owner, no D1 link) and mints against it", async () => {
    // The regression: the founder is an OWNER of an org that HAS the App
    // installed (installation 134811639), but has NO personal install and NO
    // account_tenant link — /setup only ever links a PERSONAL installer. Before
    // the fix this 409'd ("no installed GitHub App"); now the route resolves the
    // org install live from GitHub's `GET /user/installations` and persists it.
    await seedSession(db, kv, "sess-org", 4242, "damartinezjulio")
    stubGitHub([{ id: 134811639 }])

    const { verifier, challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-org", { state, challenge }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; login: string }
    expect(body.code).toBeTruthy()
    expect(body.login).toBe("damartinezjulio")

    // The compatibility link is persisted, while credential creation remains
    // deferred until exchange.
    const link = await db
      .prepare("SELECT installation_id FROM account_tenant WHERE github_user_id = ?")
      .bind("4242")
      .first<{ installation_id: number }>()
    expect(link?.installation_id).toBe(134811639)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    expectNoPersistedGrant(kv, body.code)
    const exchange = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code: body.code, verifier, state }),
      env,
    )
    expect(exchange.status).toBe(200)
    await expect(
      db.prepare("SELECT installation_id FROM api_key WHERE created_by = '4242'").first<{ installation_id: number }>(),
    ).resolves.toEqual({ installation_id: 134811639 })
  })

  it("guards a legacy linked candidate against the caller's fresh exact GitHub scope before minting", async () => {
    await seedSession(db, kv, "sess-stale", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    // The legacy link says 42, but the fresh user token can see only 99.
    stubGitHub([{ id: 99 }])

    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-stale", { state, challenge }),
      env,
    )
    expect(res.status).toBe(403)
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("honors an explicitly selected exact installation instead of the first legacy link", async () => {
    await seedSession(db, kv, "sess-explicit", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }, { id: 84 }])

    const { verifier, challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-explicit", { state, challenge, installationId: 84 }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; key?: string }
    expect(body.code).toBeTruthy()
    expect(body.key).toBeUndefined()
    expectNoPersistedGrant(kv, body.code)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    await expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM account_tenant WHERE github_user_id = '111' AND installation_id = 84")
        .first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
    const exchange = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code: body.code, verifier, state }),
      env,
    )
    expect(exchange.status).toBe(200)
    await expect(
      db.prepare("SELECT installation_id FROM api_key WHERE created_by = '111'").first<{ installation_id: number }>(),
    ).resolves.toEqual({ installation_id: 84 })
  })

  it("rejects a malformed explicit installationId before GitHub, link, or key writes", async () => {
    await seedSession(db, kv, "sess-invalid", 111)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { challenge, state } = await pkce()

    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-invalid", {
        state,
        challenge,
        installationId: "42oops",
      }),
      env,
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "invalid_installation_id" })
    expectPrivateNoStore(res)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("403s a foreign explicit installation instead of silently substituting a visible legacy link", async () => {
    await seedSession(db, kv, "sess-foreign", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }])
    const { challenge, state } = await pkce()

    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-foreign", { state, challenge, installationId: 84 }),
      env,
    )
    expect(res.status).toBe(403)
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    await expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM account_tenant WHERE github_user_id = '111' AND installation_id = 84")
        .first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 })
  })

  it("rollout-on denies a live legacy candidate without exact active stored access", async () => {
    await applyOrgAccessSchema(db)
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"
    await seedSession(db, kv, "sess-managed", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }])
    const { challenge, state } = await pkce()

    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-managed", { state, challenge }),
      env,
    )
    expect(res.status).toBe(403)
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("rollout-on lets an active stored member mint only for the explicit exact installation", async () => {
    await applyOrgAccessSchema(db)
    await seedStoredAccess(db, { installationId: 84 })
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"
    await seedSession(db, kv, "sess-managed-exact", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: 42 }, { id: 84 }])
    const { verifier, challenge, state } = await pkce()

    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-managed-exact", { state, challenge, installationId: 84 }),
      env,
    )
    expect(res.status).toBe(200)
    const { code } = (await res.json()) as { code: string }
    expectNoPersistedGrant(kv, code)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    const exchange = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(exchange.status).toBe(200)
    await expect(
      db.prepare("SELECT installation_id FROM api_key WHERE created_by = '111'").first<{ installation_id: number }>(),
    ).resolves.toEqual({ installation_id: 84 })
  })

  it("never uses the App server roster as an authorization fallback for a dead user token", async () => {
    await seedSession(db, kv, "sess-dead", 145802438, "damartinezjulio")
    const appEnv = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
    } as unknown as Env
    const fetchMock = stubGitHub([], { status: 401 })

    const { challenge, state } = await pkce()
    const res = await handleCliAuthorizeRoute(
      jsonPost("https://x/v1/cli/authorize", "sess-dead", { state, challenge }),
      appEnv,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_installation")
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input as RequestInfo | URL))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/app/")]),
    )
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })
})

describe("handleCliExchangeRoute (POST /v1/cli/exchange)", () => {
  let db: D1Database
  let kv: TestKV
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
    await seedSession(db, kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
  })

  /** Run authorize and return the issued code + the CLI-side pkce triple. */
  async function authorize(): Promise<{ code: string; verifier: string; challenge: string; state: string }> {
    stubGitHub([{ id: 42 }])
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
    expectNoPersistedGrant(kv, code)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })

    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { key: string; login: string; installationId: number }
    expect(body.key).toMatch(/^sigilix_live_/)
    expect(body.login).toBe("octocat")
    expect(body.installationId).toBe(42)
    expectPrivateNoStore(res)

    // Exchange creates one row whose hash matches the newly generated
    // plaintext returned once to this caller.
    const row = await db
      .prepare("SELECT id, key_hash, installation_id, created_by, name FROM api_key WHERE revoked_at IS NULL")
      .first<{
        id: string
        key_hash: string
        installation_id: number
        created_by: string
        name: string
      }>()
    expect(row).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      key_hash: await sha256Hex(body.key),
      installation_id: 42,
      created_by: "111",
      name: "Sigilix CLI",
    })
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
    expectPrivateNoStore(second)
  })

  it("serializes concurrent exchanges so exactly one response receives a key and one row exists", async () => {
    const { code, verifier, state } = await authorize()
    expectNoPersistedGrant(kv, code)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })

    const exchange = () =>
      handleCliExchangeRoute(jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }), env)
    const responses = await Promise.all([exchange(), exchange()])
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      error?: string
      key?: string
    }>
    const winners = responses
      .map((response, index) => ({ response, body: bodies[index]! }))
      .filter(({ response }) => response.status === 200)
    const losers = responses
      .map((response, index) => ({ response, body: bodies[index]! }))
      .filter(({ response }) => response.status !== 200)

    expect(winners).toHaveLength(1)
    expect(winners[0]!.body.key).toMatch(/^sigilix_live_/)
    expect(losers).toHaveLength(1)
    expect(losers[0]!.body.key).toBeUndefined()
    expectPrivateNoStore(winners[0]!.response)
    expectPrivateNoStore(losers[0]!.response)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 1 })
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

  it("rejects a sealed grant older than five minutes", async () => {
    vi.useFakeTimers()
    const issuedAt = Date.now()
    vi.setSystemTime(issuedAt)
    const { code, verifier, state } = await authorize()
    expectNoPersistedGrant(kv, code)
    vi.setSystemTime(issuedAt + 300_001)
    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_or_expired_code")
    expectPrivateNoStore(res)
  })

  it("fails closed on a tampered sealed grant without inserting a key", async () => {
    const { code, verifier, state } = await authorize()
    const last = code.at(-1)
    const tampered = `${code.slice(0, -1)}${last === "A" ? "B" : "A"}`

    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code: tampered, verifier, state }),
      env,
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "invalid_or_expired_code" })
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("fails closed without inserting when exact org access is removed between authorize and exchange", async () => {
    await applyOrgAccessSchema(db)
    await seedStoredAccess(db)
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"
    stubGitHub([{ id: 42 }])
    const p = await pkce()

    const authorizeRes = await worker.fetch(
      jsonPost("https://x/v1/cli/authorize", "sess-1", { state: p.state, challenge: p.challenge }),
      env,
      CTX,
    )
    expect(authorizeRes.status).toBe(200)
    const { code } = (await authorizeRes.json()) as { code: string }
    expectNoPersistedGrant(kv, code)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: 42,
        githubUserId: "111",
        nowIso: "2026-07-13T01:00:00.000Z",
        updatedBy: "test:admin",
        rosterSnapshot: { memberIds: ["111"], sqlTokenSet: "|111|" },
      }),
    ).resolves.toEqual({ status: "removed" })

    const exchangeReq = () =>
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier: p.verifier, state: p.state })
    const exchangeRes = await worker.fetch(exchangeReq(), env, CTX)
    expect(exchangeRes.status).toBe(403)
    const denied = (await exchangeRes.json()) as { error: string; key?: string }
    expect(denied).toEqual({ error: "access_revoked" })
    expect(denied.key).toBeUndefined()
    expectPrivateNoStore(exchangeRes)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("cannot redeem an old grant after the account is deleted and recreated", async () => {
    await applyOrgAccessSchema(db)
    const { code, verifier, state } = await authorize()
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 1,
    })

    await expect(
      purgeUserAccount(db, {
        userId: null,
        githubUserId: "111",
        login: "octocat",
        provider: "github",
      }),
    ).resolves.toMatchObject({ accountTenant: 1, apiKey: 0 })

    // A later login may recreate the same GitHub identity and exact link, but
    // it owns a NEW durable account UUID. The old grant stays bound to the
    // deleted UUID and must not become valid again.
    const recreatedUserId = crypto.randomUUID()
    const now = "2026-07-13T03:00:00.000Z"
    await db
      .prepare(
        "INSERT INTO user_identity" +
          " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(recreatedUserId, "111", JSON.stringify(["github"]), now, now)
      .run()
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: now,
    })

    const res = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: "access_revoked" })
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("returns an inserted key once, then exact access removal makes that bearer unusable", async () => {
    await applyOrgAccessSchema(db)
    await seedStoredAccess(db)
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"
    const { code, verifier, state } = await authorize()
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })

    const exchangeRes = await handleCliExchangeRoute(
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier, state }),
      env,
    )
    expect(exchangeRes.status).toBe(200)
    const { key } = (await exchangeRes.json()) as { key: string }
    expect(key).toMatch(/^sigilix_live_/)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 1 })

    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: 42,
        githubUserId: "111",
        nowIso: "2026-07-13T02:00:00.000Z",
        updatedBy: "test:admin",
        rosterSnapshot: { memberIds: ["111"], sqlTokenSet: "|111|" },
      }),
    ).resolves.toEqual({ status: "removed" })
    await expect(
      resolveApiKey(new Request("https://x/v1/cli/me", { headers: { authorization: `Bearer ${key}` } }), env),
    ).resolves.toBeNull()
    await expect(db.prepare("SELECT revoked_at FROM api_key").first<{ revoked_at: string | null }>()).resolves.toEqual({
      revoked_at: "2026-07-13T02:00:00.000Z",
    })
  })

  it("ignores a legacy plaintext KV record and never returns its plaintext", async () => {
    const p = await pkce()
    const code = base64urlEncode(crypto.getRandomValues(new Uint8Array(48)))
    await kv.put(
      `cli_login_code:${code}`,
      JSON.stringify({
        keyPlaintext: `sigilix_live_${"a".repeat(43)}`,
        login: "octocat",
        installationId: 42,
        state: p.state,
        challenge: p.challenge,
        createdAt: Date.now(),
      }),
      { expirationTtl: 300 },
    )

    const exchangeReq = () =>
      jsonPost("https://x/v1/cli/exchange", null, { code, verifier: p.verifier, state: p.state })
    const res = await handleCliExchangeRoute(exchangeReq(), env)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; key?: string }
    expect(body).toEqual({ error: "invalid_or_expired_code" })
    expect(body.key).toBeUndefined()
    expectPrivateNoStore(res)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })
})

describe("handleCliMeRoute (GET /v1/cli/me)", () => {
  let db: D1Database
  let kv: TestKV
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applySchema(db)
    kv = makeKV()
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
  })

  /** Mint a key via authorize→exchange and return its plaintext + installationId. */
  async function loginKey(installationId: number): Promise<string> {
    await seedSession(db, kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub([{ id: installationId }])
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
    const res = await handleCliMeRoute(meReq(null), env)
    expect(res.status).toBe(401)
    expectPrivateNoStore(res)
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
    expectPrivateNoStore(res)
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
