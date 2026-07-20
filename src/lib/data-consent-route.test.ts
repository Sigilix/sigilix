// sig-training-data-consent — GET/POST /v1/org/:installationId/data-consent tests.
// Mirrors org-seat-route.test.ts's harness (makeD1 + migrations, KV session, and
// GitHub fetch stubbing for the two calls isAdminOfInstallation makes).

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { makeR2 } from "@/src/features/training-consent/adapters/r2-fake.test-helpers"
import { handleGetDataConsent, handleSetDataConsent, type ConsentStateResponse } from "@/src/lib/data-consent-route"
import { base64urlEncode, createSession, decryptAccessToken, getSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))

const TENANT_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const IDENTITY_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const CONSENT_SQL = readFileSync(
  new URL("../../migrations/0008_create_data_learning_consent.sql", import.meta.url),
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
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(TENANT_SQL)
  await db.exec(IDENTITY_SQL)
  await db.exec(CONSENT_SQL)
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES ('consent-user-111', '111', '["github"]', 't', 't')`,
    )
    .run()
  return db
}

async function seedTenant(db: D1Database, installationId: number, tier: string): Promise<void> {
  await db
    .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, ?, 't', 't')")
    .bind(installationId, tier)
    .run()
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId: 111,
    userId: "consent-user-111",
    accessToken: "ghu_t",
    encryptionKeyB64url: ENC_KEY,
  })
}

function stubGitHub(
  installations: Array<{ id: number; account: { type: string; login: string } }>,
  expectedAccessToken?: string,
): string[] {
  const seenAuthorizations: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: expectedAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (expectedAccessToken) {
        seenAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      }
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(JSON.stringify({ total_count: installations.length, installations }), { status: 200 })
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return new Response("[]", { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return seenAuthorizations
}

function req(method: string, sessionId: string | null, iid: number, body?: unknown): Request {
  const headers = new Headers()
  if (body !== undefined) headers.set("content-type", "application/json")
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://x/v1/org/${iid}/data-consent`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function env(kv: KVNamespace, db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
    ...extra,
  } as unknown as Env
}

async function readConsentRow(db: D1Database, iid: number) {
  return db
    .prepare("SELECT consent, set_by, source, plan_at_grant FROM data_learning_consent WHERE installation_id = ?")
    .bind(iid)
    .first<{ consent: string; set_by: string; source: string; plan_at_grant: string | null }>()
}

afterEach(() => vi.unstubAllGlobals())

describe("handleSetDataConsent (POST)", () => {
  it("refreshes an expired GitHub token before the exact-installation admin write", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await createSession({
      kv,
      sessionId: "expired-session",
      login: "octocat",
      githubUserId: 111,
      userId: "consent-user-111",
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60_000,
      encryptionKeyB64url: ENC_KEY,
    })
    await seedTenant(db, 1, "team")
    const seenAuthorizations = stubGitHub([{ id: 1, account: { type: "User", login: "octocat" } }], "rotated-access")
    const routeEnv = env(kv, db, {
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    })

    const res = await handleSetDataConsent(
      req("POST", "expired-session", 1, { consent: "granted" }),
      routeEnv,
      undefined,
      1,
    )

    expect(res.status).toBe(200)
    expect(seenAuthorizations).toEqual(["Bearer rotated-access", "Bearer rotated-access"])
    const persisted = await getSession({ kv, sessionId: "expired-session" })
    expect(persisted).not.toBeNull()
    await expect(
      decryptAccessToken(
        { encryptedAccessToken: persisted!.encryptedAccessToken, iv: persisted!.iv },
        "expired-session",
        ENC_KEY,
      ),
    ).resolves.toBe("rotated-access")
  })

  it("401 without a session", async () => {
    const db = await makeDb()
    const res = await handleSetDataConsent(
      req("POST", null, 1, { consent: "granted" }),
      env(makeKV(), db),
      undefined,
      1,
    )
    expect(res.status).toBe(401)
  })

  it("400 on a malformed body", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    const res = await handleSetDataConsent(req("POST", "s1", 1, { consent: "maybe" }), env(kv, db), undefined, 1)
    expect(res.status).toBe(400)
  })

  it("403 when the caller is not an admin of this installation", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubGitHub([]) // token sees no installations → not an admin of #1
    const res = await handleSetDataConsent(req("POST", "s1", 1, { consent: "granted" }), env(kv, db), undefined, 1)
    expect(res.status).toBe(403)
    expect(await readConsentRow(db, 1)).toBeNull()
  })

  it("admin sets consent → 200 + persisted row with plan snapshot + provenance", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    await seedTenant(db, 1, "team")
    stubGitHub([{ id: 1, account: { type: "User", login: "octocat" } }])

    const res = await handleSetDataConsent(req("POST", "s1", 1, { consent: "granted" }), env(kv, db), undefined, 1)
    expect(res.status).toBe(200)
    const row = await readConsentRow(db, 1)
    expect(row).toMatchObject({ consent: "granted", set_by: "octocat", source: "portal-admin", plan_at_grant: "team" })
  })

  it("revocation (denied) purges the org's training partition", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubGitHub([{ id: 5, account: { type: "User", login: "octocat" } }])
    const { bucket, store } = makeR2()
    // Pre-seed some already-retained objects for org 5 (and an untouched org 6).
    await bucket.put("installation/5/learning/1-a.json", "{}")
    await bucket.put("installation/5/chat/2-b.json", "{}")
    await bucket.put("installation/6/learning/3-c.json", "{}")

    const res = await handleSetDataConsent(
      req("POST", "s1", 5, { consent: "denied" }),
      env(kv, db, { SIGILIX_TRAINING_DATA: bucket }),
      undefined,
      5,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { purged: number }
    expect(body.purged).toBe(2)
    // Org 6's partition is untouched.
    expect([...store.keys()]).toEqual(["installation/6/learning/3-c.json"])
  })
})

describe("handleGetDataConsent (GET)", () => {
  it("returns the fail-closed plan default when no explicit row exists", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    await seedTenant(db, 1, "team") // team → opt-in → denied default
    stubGitHub([{ id: 1, account: { type: "User", login: "octocat" } }])

    const res = await handleGetDataConsent(req("GET", "s1", 1), env(kv, db), undefined, 1)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ConsentStateResponse
    expect(body).toMatchObject({ consent: "denied", isDefault: true, planDefault: "denied" })
  })

  it("reflects an explicit granted row", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "s1", "octocat")
    await seedTenant(db, 1, "pro")
    stubGitHub([{ id: 1, account: { type: "User", login: "octocat" } }])
    await handleSetDataConsent(req("POST", "s1", 1, { consent: "granted" }), env(kv, db), undefined, 1)

    const res = await handleGetDataConsent(req("GET", "s1", 1), env(kv, db), undefined, 1)
    const body = (await res.json()) as ConsentStateResponse
    expect(body).toMatchObject({ consent: "granted", isDefault: false, setBy: "octocat" })
  })
})
