import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(19))
const PORTAL_ORIGIN = "https://app.sigilix.ai"

const MIGRATIONS = [
  "../migrations/0001_create_tenant_repo_usage.sql",
  "../migrations/0003_create_account_tenant_and_api_key.sql",
  "../migrations/0006_create_user_identity.sql",
  "../migrations/0010_add_gitlab_id_to_user_identity.sql",
  "../migrations/0021_create_app_memory.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

interface ListedMemory {
  id: string
  scope: "personal" | "organization"
  appId: string
  content: string
  createdAt: string
}

interface ListBody {
  role: "admin" | "member"
  memories: ListedMemory[]
  cursor?: string
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

function makeKV(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = values.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  for (const sql of MIGRATIONS) await db.exec(sql)
  for (const [userId, githubUserId, name] of [
    ["user-member", "111", "Member User"],
    ["user-admin", "222", "Admin User"],
    ["user-outsider", "333", "Outside User"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO user_identity
          (user_id, github_user_id, name, providers, created_at, last_login_at)
         VALUES (?, ?, ?, '["github"]', ?, ?)`,
      )
      .bind(userId, githubUserId, name, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
  }
  return db
}

async function seedSessions(kv: KVNamespace): Promise<void> {
  for (const session of [
    { id: "member-session", login: "alice", githubUserId: 111, userId: "user-member", token: "member-token" },
    { id: "admin-session", login: "bob", githubUserId: 222, userId: "user-admin", token: "admin-token" },
    { id: "outside-session", login: "eve", githubUserId: 333, userId: "user-outsider", token: "outside-token" },
  ]) {
    await createSession({
      kv,
      sessionId: session.id,
      login: session.login,
      githubUserId: session.githubUserId,
      userId: session.userId,
      accessToken: session.token,
      encryptionKeyB64url: ENC_KEY,
    })
  }
}

function stubGithub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get("authorization")
      const token = authorization?.replace(/^Bearer /, "")

      const installations =
        token === "member-token"
          ? [
              { id: 1, account: { type: "User", login: "alice" } },
              { id: 2, account: { type: "Organization", login: "org-b" } },
            ]
          : token === "admin-token"
            ? [{ id: 2, account: { type: "Organization", login: "org-b" } }]
            : [{ id: 3, account: { type: "Organization", login: "org-c" } }]
      const memberships =
        token === "member-token"
          ? [{ role: "member", state: "active", organization: { login: "org-b" } }]
          : token === "admin-token"
            ? [{ role: "admin", state: "active", organization: { login: "org-b" } }]
            : [{ role: "admin", state: "active", organization: { login: "org-c" } }]

      if (url.includes("/user/installations")) {
        return new Response(JSON.stringify({ total_count: installations.length, installations }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/user/memberships/orgs")) {
        return new Response(JSON.stringify(memberships), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected GitHub request: ${url}`)
    }),
  )
}

function request(
  sessionId: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Request {
  return new Request(`https://worker.example${path}`, {
    method: options.method ?? "GET",
    headers: {
      cookie: `__Host-sigilix_session=${sessionId}`,
      origin: PORTAL_ORIGIN,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  })
}

function createRequest(
  sessionId: string,
  args: { installationId?: number; appId?: string; scope?: string; content?: string },
): Request {
  const installationId = args.installationId ?? 2
  const appId = args.appId ?? "cli"
  return request(sessionId, `/v1/org/${installationId}/apps/${encodeURIComponent(appId)}/memories`, {
    method: "POST",
    body: {
      scope: args.scope ?? "personal",
      content: args.content ?? "Use the repository test command before opening a pull request.",
    },
  })
}

function env(kv: KVNamespace, db?: D1Database): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
  } as unknown as Env
}

async function createMemory(
  environment: Env,
  sessionId: string,
  args: Parameters<typeof createRequest>[1],
): Promise<{ response: Response; body: { role: string; deduped: boolean; memory: ListedMemory } }> {
  const response = await worker.fetch(createRequest(sessionId, args), environment, executionContext())
  return {
    response,
    body: (await response.json()) as { role: string; deduped: boolean; memory: ListedMemory },
  }
}

let kv: KVNamespace
let db: D1Database
let environment: Env

beforeEach(async () => {
  kv = makeKV()
  db = await makeDb()
  await seedSessions(kv)
  stubGithub()
  environment = env(kv, db)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("managed app memories through the real Worker", () => {
  it("lets a member create, list, and hard-delete only their personal app memory", async () => {
    const created = await createMemory(environment, "member-session", {})
    expect(created.response.status).toBe(201)
    expect(created.body).toMatchObject({
      role: "member",
      deduped: false,
      memory: { scope: "personal", appId: "cli" },
    })

    const listed = await worker.fetch(
      request("member-session", "/v1/org/2/apps/cli/memories"),
      environment,
      executionContext(),
    )
    expect(listed.status).toBe(200)
    expect(listed.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(listed.headers.get("cache-control")).toBe("private, no-store")
    expect(await listed.json()).toMatchObject({ role: "member", memories: [created.body.memory] })

    const deleted = await worker.fetch(
      request("member-session", `/v1/org/2/apps/cli/memories/${created.body.memory.id}`, {
        method: "DELETE",
      }),
      environment,
      executionContext(),
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true, deleted: true })

    const after = await worker.fetch(
      request("member-session", "/v1/org/2/apps/cli/memories"),
      environment,
      executionContext(),
    )
    expect((await after.json()) as ListBody).toMatchObject({ memories: [] })
  })

  it("lets members read org memories but only the exact installation admin mutate them", async () => {
    const created = await createMemory(environment, "admin-session", {
      appId: "github",
      scope: "organization",
      content: "Run the integration suite for changes under src/lib.",
    })
    expect(created.response.status).toBe(201)
    expect(created.body).toMatchObject({ role: "admin", memory: { scope: "organization", appId: "github" } })

    const memberList = await worker.fetch(
      request("member-session", "/v1/org/2/apps/github/memories"),
      environment,
      executionContext(),
    )
    expect(await memberList.json()).toMatchObject({ role: "member", memories: [created.body.memory] })

    const memberDelete = await worker.fetch(
      request("member-session", `/v1/org/2/apps/github/memories/${created.body.memory.id}`, {
        method: "DELETE",
      }),
      environment,
      executionContext(),
    )
    expect(memberDelete.status).toBe(404)

    const adminDelete = await worker.fetch(
      request("admin-session", `/v1/org/2/apps/github/memories/${created.body.memory.id}`, {
        method: "DELETE",
      }),
      environment,
      executionContext(),
    )
    expect(adminDelete.status).toBe(200)
  })

  it("does not let aggregate admin status authorize org B", async () => {
    const response = await worker.fetch(
      createRequest("member-session", { scope: "organization" }),
      environment,
      executionContext(),
    )
    expect(response.status).toBe(403)
    expect(await db.prepare("SELECT COUNT(*) AS n FROM app_memory").first<{ n: number }>()).toEqual({ n: 0 })
  })

  it("fails closed for an installation outside the session and for a mismatched session identity", async () => {
    const outside = await worker.fetch(
      request("outside-session", "/v1/org/2/apps/cli/memories"),
      environment,
      executionContext(),
    )
    expect(outside.status).toBe(403)

    await createSession({
      kv,
      sessionId: "mismatch-session",
      login: "alice",
      githubUserId: 111,
      userId: "user-admin",
      accessToken: "member-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const mismatch = await worker.fetch(
      request("mismatch-session", "/v1/org/2/apps/cli/memories"),
      environment,
      executionContext(),
    )
    expect(mismatch.status).toBe(401)
  })

  it("dedupes exact content and rejects unsafe app ids and credential-shaped content", async () => {
    const first = await createMemory(environment, "member-session", {})
    const second = await createMemory(environment, "member-session", {})
    expect(first.response.status).toBe(201)
    expect(second.response.status).toBe(200)
    expect(second.body).toMatchObject({ deduped: true, memory: { id: first.body.memory.id } })

    const gitlab = await createMemory(environment, "member-session", {
      appId: "gitlab",
      content: "Treat GitLab merge requests as review context.",
    })
    expect(gitlab.response.status).toBe(201)
    expect(gitlab.body).toMatchObject({ memory: { appId: "gitlab" } })

    const unknownApp = await worker.fetch(
      createRequest("member-session", { appId: "unknown-app" }),
      environment,
      executionContext(),
    )
    expect(unknownApp.status).toBe(404)

    const secret = await worker.fetch(
      createRequest("member-session", {
        content: "Use sk_live_abcdefghijklmnopqrstuvwxyz123456 for billing tests.",
      }),
      environment,
      executionContext(),
    )
    expect(secret.status).toBe(400)
    expect(await secret.json()).toEqual({ error: "credential_detected" })
  })

  it("cursor-paginates a bounded mixed personal and organization list", async () => {
    for (const content of ["First personal preference.", "Second personal preference.", "Third personal preference."]) {
      expect((await createMemory(environment, "member-session", { content })).response.status).toBe(201)
    }
    expect(
      (
        await createMemory(environment, "admin-session", {
          scope: "organization",
          content: "Organization-wide CLI preference.",
        })
      ).response.status,
    ).toBe(201)

    const firstPage = await worker.fetch(
      request("member-session", "/v1/org/2/apps/cli/memories?limit=2"),
      environment,
      executionContext(),
    )
    const firstBody = (await firstPage.json()) as ListBody
    expect(firstBody.memories).toHaveLength(2)
    expect(firstBody.cursor).toBeTypeOf("string")

    const secondPage = await worker.fetch(
      request("member-session", `/v1/org/2/apps/cli/memories?limit=2&cursor=${encodeURIComponent(firstBody.cursor!)}`),
      environment,
      executionContext(),
    )
    const secondBody = (await secondPage.json()) as ListBody
    expect(secondBody.memories).toHaveLength(2)
    expect(new Set([...firstBody.memories, ...secondBody.memories].map((memory) => memory.id)).size).toBe(4)
  })

  it("fails closed when managed-memory D1 is unavailable", async () => {
    const response = await worker.fetch(
      request("member-session", "/v1/org/2/apps/cli/memories"),
      env(kv),
      executionContext(),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "app_memory_unavailable" })
  })

  it("requires a live session and rejects malformed app-memory paths", async () => {
    const noSession = await worker.fetch(
      new Request("https://worker.example/v1/org/2/apps/cli/memories", { headers: { origin: PORTAL_ORIGIN } }),
      environment,
      executionContext(),
    )
    expect(noSession.status).toBe(401)

    const malformed = await worker.fetch(
      request("member-session", "/v1/org/not-a-number/apps/cli/memories"),
      environment,
      executionContext(),
    )
    expect(malformed.status).toBe(400)
  })
})
