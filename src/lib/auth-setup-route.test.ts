// #155 onboarding-backend FOUNDATION (slice 1 of 2) — /auth/install-redirect
// + /setup route tests. Mirrors the state-nonce CSRF pattern test style used
// for slack-install.ts and auth-oauth-github.ts.
//
// The /setup success path resolves the central exact-installation access guard,
// so sessions are seeded via the real `createSession` and GitHub visibility +
// live-role responses are explicit in every path that reaches authorization.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleInstallRedirect, handleSetupRoute } from "@/src/lib/auth-setup-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import worker from "@/src/index"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
// 32-byte AES-256 key (base64url), matching the production secret shape.
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

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
async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number, db?: D1Database): Promise<void> {
  const userId = `test-user-${githubUserId}`
  if (db) {
    const now = "2026-07-15T00:00:00.000Z"
    await db
      .prepare(
        "INSERT OR IGNORE INTO user_identity" +
          " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(userId, String(githubUserId), JSON.stringify(["github"]), now, now)
      .run()
  }
  await createSession({
    kv,
    sessionId,
    login: "octocat",
    githubUserId,
    userId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

/** Stub the exact-installation visibility + live-role reads used by org access. */
function stubUserInstallations(ids: number[], options: { liveRole?: "admin" | "member"; status?: number } = {}): void {
  const status = options.status ?? 200
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          status === 200
            ? JSON.stringify({
                total_count: ids.length,
                installations: ids.map((id) => ({
                  id,
                  account: { type: "Organization", login: `org-${id}` },
                })),
              })
            : "boom",
          { status, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        const memberships =
          status === 200
            ? ids.map((id) => ({
                role: options.liveRole ?? "member",
                state: "active",
                organization: { login: `org-${id}` },
              }))
            : []
        return new Response(status === 200 ? JSON.stringify(memberships) : "boom", {
          status,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/orgs/org-42/members?")) {
        return new Response(JSON.stringify([{ id: 111, login: "octocat" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
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
const IDENTITY_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)
const ACCESS_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
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
    await db.exec(IDENTITY_MIGRATION_SQL)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
  })

  async function mintState(githubUserId: number): Promise<string> {
    await seedSession(kv, "sess-1", githubUserId, db)
    const res = await handleInstallRedirect(reqWithSession("https://x/auth/install-redirect", "sess-1"), env)
    return extractState(res.headers.get("location")!)
  }

  async function enableManagedMembership(): Promise<void> {
    await db.exec(ACCESS_MIGRATION_SQL)
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"
    env.GITHUB_APP_ID = "123"
    env.GITHUB_PRIVATE_KEY = "cached-token"
    await kv.put(
      "gh-installation-token:42",
      JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
    )
  }

  async function seedStoredAccess(options: {
    githubUserId?: string
    role?: "admin" | "member"
    revokedAt?: string | null
  }): Promise<void> {
    const githubUserId = options.githubUserId ?? "111"
    const now = "2026-07-13T00:00:00.000Z"
    await db
      .prepare(
        "INSERT INTO org_workspace_access" +
          " (installation_id, github_user_id, role, created_at, updated_at, revoked_at," +
          " updated_by, last_audit_id, last_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        42,
        githubUserId,
        options.role ?? "member",
        now,
        now,
        options.revokedAt ?? null,
        "test-seed",
        `seed-42-${githubUserId}`,
        "member_added_or_regranted",
      )
      .run()
  }

  async function dispatchSetup(state: string, environment: Env = env): Promise<Response> {
    return worker.fetch(
      reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
      environment,
      CTX,
    )
  }

  it("401 without a session", async () => {
    const res = await handleSetupRoute(
      reqWithSession("https://x/setup?installation_id=42&state=whatever&setup_action=install", null),
      env,
    )
    expect(res.status).toBe(401)
  })

  it("400 when state is missing", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await seedSession(kv, "sess-1", 111, db)
    const res = await handleSetupRoute(reqWithSession("https://x/setup?installation_id=42", "sess-1"), env)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first()).resolves.toEqual({ n: 0 })
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first()).resolves.toEqual({ n: 0 })
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
    await seedSession(kv, "sess-1", 111, db)
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
    await seedSession(kv, "sess-2", 222, db) // a different user reusing/guessing the nonce
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

  it("403 (fail closed) and consumes state when the GitHub installations lookup errors", async () => {
    stubUserInstallations([42], { status: 500 })
    const state = await mintState(111)
    const res = await dispatchSetup(state)
    expect(res.status).toBe(403)
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
    const replay = await dispatchSetup(state)
    expect(replay.status).toBe(400)
  })

  it("on success: links account_tenant, mints an api_key, and shows the plaintext key once", async () => {
    stubUserInstallations([42])
    const state = await mintState(111)

    const res = await dispatchSetup(state)
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

  describe("managed organization access through Worker dispatch", () => {
    it("allows an active stored member and mints for that immutable GitHub id", async () => {
      await enableManagedMembership()
      await seedStoredAccess({})
      stubUserInstallations([42])
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(200)
      await expect(
        db.prepare("SELECT installation_id, created_by FROM api_key WHERE revoked_at IS NULL").first(),
      ).resolves.toEqual({ installation_id: 42, created_by: "111" })
    })

    it("denies when only a legacy link exists without a managed access row", async () => {
      await enableManagedMembership()
      await db
        .prepare("INSERT INTO account_tenant (github_user_id, installation_id, role, created_at) VALUES (?, ?, ?, ?)")
        .bind("111", 42, "owner", "2026-07-13T00:00:00.000Z")
        .run()
      stubUserInstallations([42])
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(403)
      await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first()).resolves.toEqual({ n: 0 })
      await expect(db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access").first()).resolves.toEqual({ n: 0 })
    })

    it("does not bootstrap the first live GitHub member as an admin", async () => {
      await enableManagedMembership()
      stubUserInstallations([42], { liveRole: "member" })
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(403)
      await expect(db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access").first()).resolves.toEqual({ n: 0 })
      await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first()).resolves.toEqual({ n: 0 })
    })

    it("denies a revoked row without resurrecting it or minting a key", async () => {
      await enableManagedMembership()
      const revokedAt = "2026-07-13T01:00:00.000Z"
      await seedStoredAccess({ role: "admin", revokedAt })
      stubUserInstallations([42], { liveRole: "admin" })
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(403)
      await expect(db.prepare("SELECT role, revoked_at FROM org_workspace_access").first()).resolves.toEqual({
        role: "admin",
        revoked_at: revokedAt,
      })
      await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first()).resolves.toEqual({ n: 0 })
    })

    it("bootstraps the first exact live GitHub admin before linking and minting", async () => {
      await enableManagedMembership()
      stubUserInstallations([42], { liveRole: "admin" })
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(200)
      await expect(
        db.prepare("SELECT github_user_id, role, revoked_at FROM org_workspace_access").first(),
      ).resolves.toEqual({
        github_user_id: "111",
        role: "admin",
        revoked_at: null,
      })
      await expect(
        db.prepare("SELECT action, target_github_user_id FROM org_workspace_access_audit").first(),
      ).resolves.toEqual({ action: "bootstrap_admin", target_github_user_id: "111" })
      await expect(db.prepare("SELECT installation_id, created_by FROM api_key").first()).resolves.toEqual({
        installation_id: 42,
        created_by: "111",
      })
    })

    it("bootstraps a later live GitHub admin when the stored admin has left the exact roster", async () => {
      await enableManagedMembership()
      await seedStoredAccess({ githubUserId: "222", role: "admin" })
      stubUserInstallations([42], { liveRole: "admin" })
      const state = await mintState(111)

      const res = await dispatchSetup(state)

      expect(res.status).toBe(200)
      await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first()).resolves.toEqual({ n: 1 })
      await expect(
        db.prepare("SELECT role, revoked_at FROM org_workspace_access WHERE github_user_id = '111'").first(),
      ).resolves.toEqual({ role: "admin", revoked_at: null })
    })
  })

  // SIG-155 slice 3 — env-gated redirect polish (portal endpoints).
  describe("OPENCLAW_PORTAL_URL redirect polish", () => {
    it("unset: renders the plaintext-key page (byte-identical to before)", async () => {
      stubUserInstallations([42])
      const state = await mintState(111)
      const res = await handleSetupRoute(
        reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
        env,
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("sigilix_live_")
    })

    it("set: redirects the exact authorized installation to Portal setup without rendering the key page", async () => {
      stubUserInstallations([42])
      const state = await mintState(111)
      const portalEnv = { ...env, OPENCLAW_PORTAL_URL: "https://app.sigilix.ai" }
      const res = await handleSetupRoute(
        reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
        portalEnv,
      )
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("https://app.sigilix.ai/setup?installed=1&installation_id=42")
      // Never the key in the URL.
      expect(res.headers.get("location")).not.toContain("sigilix_live_")
      const body = await res.text()
      expect(body).not.toContain("sigilix_live_")

      // Linking + minting still happened even though the key page never renders.
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

    it("set: a 403 ownership failure still returns 403 (redirect gate never overrides an auth failure)", async () => {
      stubUserInstallations([1])
      const state = await mintState(111)
      const portalEnv = { ...env, OPENCLAW_PORTAL_URL: "https://app.sigilix.ai" }
      const res = await handleSetupRoute(
        reqWithSession(`https://x/setup?installation_id=42&state=${state}&setup_action=install`, "sess-1"),
        portalEnv,
      )
      expect(res.status).toBe(403)
    })
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
