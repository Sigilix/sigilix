import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(12))
const PORTAL_ORIGIN = "https://app.sigilix.ai"

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_IDENTITY_SQL = readFileSync(
  new URL("../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SEAT_SQL = readFileSync(
  new URL("../migrations/0007_create_org_seat_assignment.sql", import.meta.url),
  "utf8",
)

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

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
  await db.exec(MIGRATION_IDENTITY_SQL)
  await db.exec(MIGRATION_SEAT_SQL)
  return db
}

async function seedSession(kv: KVNamespace, userId?: string): Promise<void> {
  await createSession({
    kv,
    sessionId: "sess-1",
    login: "octocat",
    githubUserId: 111,
    ...(userId ? { userId } : {}),
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

function authedRequest(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: {
      cookie: `${SESSION_COOKIE}=sess-1`,
      origin: PORTAL_ORIGIN,
    },
  })
}

async function seedOrgUsage(db: D1Database): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (2, 'org-b', 'Organization', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (200, 2, 'org-b/api', ?)")
    .bind("2026-01-01T00:00:00Z")
    .run()
  for (const [prNumber, login] of [
    [1, "octocat"],
    [2, "secret-agent"],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO usage_ledger" +
          " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
          " VALUES (2, 200, ?, ?, 1, 100, ?, ?)",
      )
      .bind(prNumber, `sha-${prNumber}`, login, `2026-06-0${prNumber}T00:00:00Z`)
      .run()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("organization bootstrap authorization through the real Worker", () => {
  it("GET /auth/session verifies the session without any GitHub request", async () => {
    const kv = makeKV()
    await seedSession(kv)
    const githubFetch = vi.fn(async () => {
      throw new Error("the identity-only session probe must not call GitHub")
    })
    vi.stubGlobal("fetch", githubFetch)

    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(authedRequest("/auth/session"), env, ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(await res.json()).toEqual({
      user: {
        login: "octocat",
        name: null,
        githubUserId: 111,
        userId: null,
        email: null,
        provider: "github",
      },
    })
    expect(githubFetch).not.toHaveBeenCalled()
  })

  it("admin of A but member of selected B receives only B's own-seat member response", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await db
      .prepare(
        "INSERT INTO user_identity (user_id, github_user_id, providers, created_at, last_login_at)" +
          " VALUES ('user-111', '111', '[\"github\"]', 't', 't')",
      )
      .run()
    await seedSession(kv, "user-111")
    await seedOrgUsage(db)

    const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/user/installations")) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            installations: [
              { id: 1, account: { type: "User", login: "octocat" } },
              { id: 2, account: { type: "Organization", login: "org-b" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/user/memberships/orgs")) {
        return new Response(JSON.stringify([{ role: "member", state: "active", organization: { login: "org-b" } }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal("fetch", githubFetch)

    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    const res = await worker.fetch(authedRequest("/v1/org/overview?installationId=2"), env, ctx())

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      org: { account: string; installationId: number }
      role: string
      seatCount: number
      seats: Array<{ login: string }>
    }
    expect(body.org).toEqual(expect.objectContaining({ account: "org-b", installationId: 2 }))
    expect(body.role).toBe("member")
    expect(body.seatCount).toBe(2)
    expect(body.seats.map((seat) => seat.login)).toEqual(["octocat"])
    expect(githubFetch.mock.calls.filter(([input]) => String(input).includes("/user/installations"))).toHaveLength(1)
  })
})
