// #155 onboarding-backend FOUNDATION (slice 1 of 2) — /auth/install-redirect
// + /setup route tests. Mirrors the state-nonce CSRF pattern test style used
// for slack-install.ts and auth-oauth-github.ts.
//
// The /setup success path now requires (a) a decryptable session access token
// and (b) a GitHub `GET /user/installations` response that includes the claimed
// installation — so sessions are seeded via the real `createSession` (which
// encrypts a token) and `fetch` is stubbed to control the installations list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleInstallRedirect, handleSetupRoute } from "@/src/lib/auth-setup-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
// 32-byte AES-256 key (base64url), matching the production secret shape.
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))

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

/** Seed a real encrypted session record (so /setup can decrypt the access token). */
async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: "octocat",
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

function reqWithSession(url: string, sessionId: string | null): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { headers })
}

function extractState(location: string): string {
  const m = /[?&]state=([^&]+)/.exec(location)
  if (!m) throw new Error("no state param in redirect location: " + location)
  return decodeURIComponent(m[1]!)
}

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleInstallRedirect (GET /auth/install-redirect)", () => {
  it("redirects to /auth/github when there is no session", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleInstallRedirect(reqWithSession("https://x/auth/install-redirect", null), env)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/auth/github")
  })

  it("mints a state nonce in KV and 302s to the GitHub App install URL", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    await seedSession(kv, "sess-1", 111)

    const res = await handleInstallRedirect(reqWithSession("https://x/auth/install-redirect", "sess-1"), env)
    expect(res.status).toBe(302)
    const location = res.headers.get("location")!
    expect(location).toContain("https://github.com/apps/sigilix/installations/new")
    const state = extractState(location)

    const stored = await kv.get(`setup_state:${state}`, "json")
    expect(stored).toMatchObject({ githubUserId: 111 })
  })
})

describe("handleSetupRoute (GET /setup)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
  })

  async function mintState(githubUserId: number): Promise<string> {
    await seedSession(kv, "sess-1", githubUserId)
    const res = await handleInstallRedirect(reqWithSession("https://x/auth/install-redirect", "sess-1"), env)
    return extractState(res.headers.get("location")!)
  }

  it("401 without a session", async () => {
    const res = await handleSetupRoute(
      reqWithSession("https://x/setup?installation_id=42&state=whatever&setup_action=install", null),
      env,
    )
    expect(res.status).toBe(401)
  })

  it("400 when state is missing", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleSetupRoute(reqWithSession("https://x/setup?installation_id=42", "sess-1"), env)
    expect(res.status).toBe(400)
  })

  it("400 when installation_id is missing or non-numeric", async () => {
    const state = await mintState(111)
    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?state=${state}&installation_id=abc`, "sess-1"),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("400 on an unknown/expired state (and does not 500 on a second submission)", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleSetupRoute(
      reqWithSession("https://x/setup?installation_id=42&state=does-not-exist", "sess-1"),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("state nonce is single-use — a second /setup hit with the same state is rejected", async () => {
    stubUserInstallations([42])
    const state = await mintState(111)
    const first = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(first.status).toBe(200)

    const second = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(second.status).toBe(400)
  })

  it("400 when the nonce belongs to a different session's githubUserId", async () => {
    const state = await mintState(111)
    await seedSession(kv, "sess-2", 222) // a different user reusing/guessing the nonce
    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-2"),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("403 when the session user does not control the claimed installation (P0 cross-tenant guard)", async () => {
    // Attacker's own session + own valid nonce, but forges a victim's
    // installation_id. GitHub reports the attacker controls only installation 1.
    stubUserInstallations([1])
    const state = await mintState(111)
    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(res.status).toBe(403)

    // Nothing was linked and no key was minted for the victim's installation.
    const link = await db
      .prepare("SELECT COUNT(*) AS n FROM account_tenant WHERE installation_id = ?")
      .bind(42)
      .first<{ n: number }>()
    expect(link?.n).toBe(0)
    const keys = await db
      .prepare("SELECT COUNT(*) AS n FROM api_key WHERE installation_id = ?")
      .bind(42)
      .first<{ n: number }>()
    expect(keys?.n).toBe(0)
  })

  it("502 (fail closed) when the GitHub installations lookup errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )
    const state = await mintState(111)
    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(res.status).toBe(502)
    const link = await db
      .prepare("SELECT COUNT(*) AS n FROM account_tenant WHERE installation_id = ?")
      .bind(42)
      .first<{ n: number }>()
    expect(link?.n).toBe(0)
  })

  it("on success: links account_tenant, mints an api_key, and shows the plaintext key once", async () => {
    stubUserInstallations([42])
    const state = await mintState(111)

    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("sigilix_live_")
    expect(html).not.toContain("<script")

    const link = await db
      .prepare("SELECT role FROM account_tenant WHERE github_user_id = ? AND installation_id = ?")
      .bind("111", 42)
      .first<{ role: string }>()
    expect(link?.role).toBe("owner")

    const keys = await db
      .prepare("SELECT COUNT(*) AS n FROM api_key WHERE installation_id = ?")
      .bind(42)
      .first<{ n: number }>()
    expect(keys?.n).toBe(1)
  })

  it("does not require the `tenant` row to pre-exist (benign async-webhook race)", async () => {
    stubUserInstallations([999])
    const state = await mintState(111)
    // No row inserted into `tenant` (0001) at all — only account_tenant + api_key (0003).
    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=999&state=${state}&setup_action=install`, "sess-1"),
      env,
    )
    expect(res.status).toBe(200)
  })

  it("503 when SIGILIX_PLATFORM_DB is not configured", async () => {
    const noDbEnv = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    await seedSession(kv, "sess-1", 111)
    const mintRes = await handleInstallRedirect(reqWithSession("https://x/auth/install-redirect", "sess-1"), noDbEnv)
    const state = extractState(mintRes.headers.get("location")!)

    const res = await handleSetupRoute(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      noDbEnv,
    )
    expect(res.status).toBe(503)
  })
})
