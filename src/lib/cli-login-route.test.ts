// sig-cli-login — tests for the `sigilix login` Worker endpoints
// (cli-login-route.ts): the loopback authorize→exchange happy path, PKCE/state
// verification, single-use + expiry of the one-time code, the unauthenticated
// authorize bounce, and the bearer-authed /v1/cli/me plan + cli_byok entitlement.
//
// Session auth via a seeded fake KV (auth-session.ts's SessionRecord shape); D1
// via the real-SQLite shim with the account_tenant/api_key (0003) + name (0009)
// + tenant (0001) schema applied.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleCliAuthorizeRoute, handleCliExchangeRoute, handleCliMeRoute } from "@/src/lib/cli-login-route"
import { linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode } from "@/src/lib/auth-session"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"

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
