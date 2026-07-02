// sig-usage — GET /v1/usage tests.
// Mirrors org-overview-route.test.ts's harness: makeD1 + migration SQL, KV
// session seeding, GitHub /user/installations stubbing, and api-key D1 seeding.
// The CORS-preflight test drives the real worker entrypoint to prove the path is
// registered in index.ts's isPortalCorsPath.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleUsageRoute, type UsageResponse } from "@/src/lib/usage-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const GLOBAL_KEY = "global-shared-secret-token"

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_USAGE_SQL)
  await db.exec(MIGRATION_API_KEY_SQL)
  return db
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

async function insertTenant(db: D1Database, installationId: number, accountLogin: string | null = null) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, created_at, updated_at)" +
        " VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" +
        " ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login",
    )
    .bind(installationId, accountLogin)
    .run()
}

async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    authorLogin: string | null
    createdAt: string
    modelCalls?: number
    tokens?: number
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      args.installationId,
      args.repoId,
      args.prNumber,
      args.headSha,
      args.modelCalls ?? 1,
      args.tokens ?? 100,
      args.authorLogin,
      args.createdAt,
    )
    .run()
}

function reqWithSession(sessionId: string | null, query = ""): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://x/v1/usage${query}`, { headers })
}

function reqWithBearer(token: string, query = ""): Request {
  return new Request(`https://x/v1/usage${query}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Stub GET /user/installations → the caller's owned installation ids. */
function stubInstallations(installations: Array<{ id: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(JSON.stringify({ total_count: installations.length, installations }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

/**
 * Stub BOTH GitHub calls the route + resolveUserRole make (installations with
 * account metadata + org memberships) so the admin/member gate on `?scope=org`
 * and `?author=` can be exercised. A `User`-type install whose login matches
 * the session login makes the caller an admin; otherwise member.
 */
function stubGitHubRole(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships?: Array<{ role: string; state: string; organization: { login: string } }>
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({ total_count: opts.installations.length, installations: opts.installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify(opts.memberships ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleUsageRoute (GET /v1/usage)", () => {
  it("401 with neither a session nor a bearer api key", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    const res = await handleUsageRoute(reqWithSession(null), env)
    expect(res.status).toBe(401)
  })

  it("session path: per-developer session bar reflects real in-window reviews and the enforced cap", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_RATE_LIMIT_MODE: "shadow",
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")

    // Two reviews INSIDE the 5h window by the caller (casing differs — the write
    // path stores pr.user.login verbatim; the read matches on author_login).
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "Octocat",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-2",
      authorLogin: "Octocat",
      createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
    })
    // One OLD review outside the 5h window — counts for weekly, not for session.
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 3,
      headSha: "sha-3",
      authorLogin: "Octocat",
      createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as UsageResponse

    expect(body.scope).toBe("user")
    expect(body.plan).toBe("free")
    expect(body.account).toBe("octocat")
    expect(body.mode).toBe("shadow")

    expect(body.session).not.toBeNull()
    expect(body.session!.key).toBe("pr_reviews")
    expect(body.session!.used).toBe(2)
    expect(body.session!.limit).toBe(2) // DEFAULT_RATE_LIMIT_CAP (the enforced cap)
    expect(body.session!.pct).toBe(100)
    expect(body.session!.window_label).toBe("5h")
    expect(body.session!.resets_at).not.toBeNull()

    // Weekly counts all three in-7d reviews; no weekly cap → null limit/pct.
    expect(body.weekly).not.toBeNull()
    expect(body.weekly!.used).toBe(3)
    expect(body.weekly!.limit).toBeNull()
    expect(body.weekly!.pct).toBeNull()

    // Org-grain raw totals (trailing 7d) are real.
    expect(body.totals.reviews).toBe(3)
    expect(body.totals.model_calls).toBe(3)
    expect(body.totals.tokens).toBe(300)
  })

  it("session path: zero usage → honest empty state (used 0, no reset), never a fake number", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 7 }])
    await insertTenant(db, 7, "acme")

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.session!.used).toBe(0)
    expect(body.session!.pct).toBe(0)
    expect(body.session!.resets_at).toBeNull()
    expect(body.weekly!.used).toBe(0)
    expect(body.totals.reviews).toBe(0)
  })

  it("cross-installation isolation: another installation's reviews never count", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }]) // caller owns installation 1 only
    await insertTenant(db, 1, "octocat")
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })
    // Same author login, DIFFERENT installation — must never count.
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-b",
      authorLogin: "octocat",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.session!.used).toBe(1)
    expect(body.weekly!.used).toBe(1)
  })

  it("api-key path with ?author= → per-developer scope for that login", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    } as unknown as Env
    const plaintext = "sigilix_live_usage_key"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "cli-user",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithBearer(plaintext, "?author=cli-user"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    expect(body.session!.used).toBe(1)
    expect(body.session!.limit).toBe(2)
  })

  it("api-key path without author → org scope: installation-wide usage, no per-user cap", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    } as unknown as Env
    const plaintext = "sigilix_live_usage_org"
    await insertApiKey(db, {
      id: "key-2",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "dev-a",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-b",
      authorLogin: "dev-b",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithBearer(plaintext), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("org")
    expect(body.session!.used).toBe(2) // both devs' reviews in the 5h window
    expect(body.session!.limit).toBeNull() // org grain → no single per-developer cap
    expect(body.totals.reviews).toBe(2)
  })

  it("admin session with ?scope=org → org-wide usage, no per-developer cap", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Personal install owned by the session user → admin.
    stubGitHubRole({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })
    await insertTenant(db, 1, "octocat")
    const now = Date.now()
    for (const [login, i] of [
      ["dev-a", 1],
      ["dev-b", 2],
      ["dev-c", 3],
    ] as const) {
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: i,
        headSha: `sha-${i}`,
        authorLogin: login,
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      })
    }

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=org"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("org")
    expect(body.session!.used).toBe(3) // all three devs' reviews in the 5h window
    expect(body.session!.limit).toBeNull() // org grain → no single per-developer cap
    expect(body.totals.reviews).toBe(3)
  })

  it("MEMBER session with ?scope=org → falls back to self (never another member's usage)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Org install, caller not an admin of it → member.
    stubGitHubRole({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [],
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-self",
      authorLogin: "quiet-dev",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })
    // Another member's review — must NOT be counted for a member asking scope=org.
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-boss",
      authorLogin: "boss",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=org"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user") // downgraded to self
    expect(body.session!.used).toBe(1) // only their own review
    expect(body.session!.limit).toBe(2)
  })

  it("admin session with ?author=<member> → that member's per-developer usage", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHubRole({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })
    await insertTenant(db, 1, "octocat")
    const now = Date.now()
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-m",
      authorLogin: "member-x",
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?author=member-x"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    expect(body.session!.used).toBe(1)
    expect(body.session!.limit).toBe(2)
  })

  it("CORS preflight: OPTIONS /v1/usage from an allowlisted portal origin returns the CORS grant", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const req = new Request("https://x/v1/usage", {
      method: "OPTIONS",
      headers: { origin: "https://app.sigilix.ai" },
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
  })
})
