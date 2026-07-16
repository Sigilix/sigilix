import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"
import { tryHandleOrgMcpRoute } from "./org-routes"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const LEGACY_KEY = "legacy-global-key"
const API_KEY_SQL = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const IDENTITY_SQL = readFileSync(new URL("../../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")

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
  await db.exec(API_KEY_SQL)
  await db.exec(IDENTITY_SQL)
  return db
}

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number, login = "octocat"): Promise<void> {
  await createSession({
    kv,
    sessionId,
    userId: `user-${githubUserId}`,
    login,
    githubUserId,
    accessToken: `ghu_${githubUserId}`,
    encryptionKeyB64url: ENC_KEY,
  })
}

async function seedIdentity(db: D1Database, userId: string, githubUserId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_identity
       (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, ?, '["github"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .bind(userId, String(githubUserId))
    .run()
}

async function seedApiKey(db: D1Database, installationId: number): Promise<string> {
  const plaintext = `sigilix_live_tenant_${installationId}`
  await insertApiKey(db, {
    id: `key-${installationId}`,
    keyHash: await sha256Hex(plaintext),
    installationId,
    createdBy: "111",
    nowIso: "2026-07-10T00:00:00.000Z",
  })
  return plaintext
}

function stubGitHubAdmin(installationId: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [{ id: installationId, account: { type: "Organization", login: "acme" } }],
          }),
          { status: 200 },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify([{ role: "admin", state: "active", organization: { login: "acme" } }]), {
          status: 200,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

interface DoCall {
  scope: string
  request: Request
}

function makeNamespace(handler: (scope: string, request: Request) => Promise<Response> | Response) {
  const idFromNameCalls: string[] = []
  const calls: DoCall[] = []
  const namespace = {
    idFromName: (scope: string) => {
      idFromNameCalls.push(scope)
      return { toString: () => scope } as unknown as DurableObjectId
    },
    get: (id: DurableObjectId) =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const scope = id.toString()
          calls.push({ scope, request })
          return handler(scope, request)
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  return { namespace, idFromNameCalls, calls }
}

function env(kv: KVNamespace, namespace: DurableObjectNamespace, db?: D1Database): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    OPENCLAW_SIGILIX_API_KEY: LEGACY_KEY,
    MCP_CONNECTIONS: namespace,
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
  } as unknown as Env
}

function orgRequest(
  method: string,
  installationId: number,
  sessionId: string | null,
  suffix = "",
  body?: unknown,
  origin?: string,
): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  if (body !== undefined) headers.set("content-type", "application/json")
  if (origin) headers.set("origin", origin)
  return new Request(`https://api.sigilix.ai/v1/org/${installationId}/mcp/servers${suffix}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function runtimeRequest(body: unknown, bearer?: string, cookie?: string, path = "catalog"): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (bearer) headers.set("authorization", `Bearer ${bearer}`)
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
  return new Request(`https://api.sigilix.ai/v1/mcp/runtime/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function appResolveRequest(text: string, bearer?: string): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (bearer) headers.set("authorization", `Bearer ${bearer}`)
  return new Request("https://api.sigilix.ai/v1/apps/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  })
}

async function dispatch(request: Request, environment: Env): Promise<Response> {
  const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext
  const response = await tryHandleOrgMcpRoute(request, environment, ctx, new URL(request.url))
  if (!response) throw new Error("route did not match")
  return response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("installation-scoped MCP management", () => {
  it("uses the exact installation admin gate before resolving any Durable Object", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    const doFetch = vi.fn(() => new Response("not reached", { status: 500 }))
    const { namespace, idFromNameCalls } = makeNamespace(doFetch)

    const response = await dispatch(orgRequest("GET", 999, "sess-1"), env(kv, namespace))

    expect(response.status).toBe(403)
    expect(idFromNameCalls).toEqual([])
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("creates the tenant grant before connecting the owner DO and exposes only the grant id", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    let grantBody: Record<string, unknown> | undefined
    let connectBody: Record<string, unknown> | undefined
    const { namespace, idFromNameCalls } = makeNamespace(async (scope, request) => {
      const path = new URL(request.url).pathname
      if (scope === "tenant:42" && path === "/grants") {
        grantBody = (await request.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ status: "pending" }))
      }
      if (scope === "session:111" && path === "/connect") {
        connectBody = (await request.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ status: "connected", id: connectBody.serverId, toolCount: 3 }))
      }
      if (scope === "tenant:42" && path.endsWith("/activate")) {
        return new Response(JSON.stringify({ grant: { ...grantBody, status: "active" } }))
      }
      throw new Error(`unexpected DO request: ${scope} ${request.method} ${path}`)
    })

    const response = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "https://mcp.example.com/api", name: "Example" }),
      env(kv, namespace),
    )
    const body = (await response.json()) as { status: string; id: string; toolCount: number }
    const serverId = String(connectBody?.serverId)

    expect(response.status).toBe(200)
    expect(body).toEqual({ status: "connected", id: grantBody?.grantId, toolCount: 3 })
    expect(body.id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect(serverId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect(body.id).not.toBe(serverId)
    expect(idFromNameCalls).toEqual(["tenant:42", "session:111"])
    expect(grantBody).toMatchObject({
      ownerScope: "session:111",
      serverId,
      creatorSubject: "user:user-111",
    })
    expect(connectBody).toMatchObject({
      serverId,
      url: "https://mcp.example.com/api",
      allowOAuth: true,
      grant: {
        grantId: body.id,
        ownerScope: "session:111",
        tenantScope: "tenant:42",
        stableSubject: "user-111",
      },
    })
    expect(JSON.stringify(body)).not.toContain("session:111")
    expect(JSON.stringify(body)).not.toContain(serverId)
  })

  it("keeps an OAuth grant pending and returns a guarded authorization URL under the public grant id", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    const { namespace, calls } = makeNamespace(async (scope, request) => {
      const path = new URL(request.url).pathname
      if (scope === "tenant:42" && path === "/grants") return new Response(JSON.stringify({ status: "pending" }))
      if (scope === "session:111" && path === "/connect") {
        const connect = (await request.json()) as { serverId: string }
        return new Response(
          JSON.stringify({
            status: "auth_required",
            id: connect.serverId,
            authUrl: "https://provider.example/authorize?state=opaque",
          }),
        )
      }
      throw new Error(`unexpected DO request: ${scope} ${request.method} ${path}`)
    })

    const response = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "https://mcp.example.com/api" }),
      env(kv, namespace),
    )
    const body = (await response.json()) as { status: string; id: string; authUrl: string }

    expect(body).toMatchObject({
      status: "auth_required",
      authUrl: "https://provider.example/authorize?state=opaque",
    })
    expect(body.id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect(calls.some(({ request }) => /\/activate$/.test(request.url))).toBe(false)
    expect(calls.some(({ request }) => /\/fail$/.test(request.url))).toBe(false)
  })

  it("does not report connected unless the exact tenant grant becomes active", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    let pending: Record<string, unknown> = {}
    const { namespace, calls } = makeNamespace(async (scope, request) => {
      const path = new URL(request.url).pathname
      if (scope === "tenant:42" && path === "/grants") {
        pending = (await request.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ grant: { ...pending, status: "pending" } }), { status: 201 })
      }
      if (scope === "session:111" && path === "/connect") {
        const connect = (await request.json()) as { serverId: string }
        return new Response(JSON.stringify({ status: "connected", id: connect.serverId, toolCount: 1 }))
      }
      if (scope === "tenant:42" && path.endsWith("/activate")) {
        return new Response(JSON.stringify({ grant: { ...pending, status: "failed" } }))
      }
      if (scope === "tenant:42" && path.endsWith("/fail")) {
        return new Response(JSON.stringify({ grant: { ...pending, status: "failed" } }))
      }
      if (scope === "session:111" && request.method === "DELETE") return new Response(JSON.stringify({ ok: true }))
      throw new Error(`unexpected DO request: ${scope} ${request.method} ${path}`)
    })

    const response = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "https://mcp.example.com/api" }),
      env(kv, namespace),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "failed to activate MCP grant" })
    expect(calls.some(({ request }) => /\/fail$/.test(request.url))).toBe(true)
    expect(calls.some(({ scope, request }) => scope === "session:111" && request.method === "DELETE")).toBe(true)
  })

  it("revokes a grant when activation may have committed but its response is lost", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    let pending: Record<string, unknown> = {}
    const { namespace, calls } = makeNamespace(async (scope, request) => {
      const path = new URL(request.url).pathname
      if (scope === "tenant:42" && path === "/grants") {
        pending = (await request.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ grant: { ...pending, status: "pending" } }), { status: 201 })
      }
      if (scope === "session:111" && path === "/connect") {
        const connect = (await request.json()) as { serverId: string }
        return new Response(JSON.stringify({ status: "connected", id: connect.serverId, toolCount: 1 }))
      }
      if (scope === "tenant:42" && path.endsWith("/activate")) throw new Error("response lost after commit")
      if (scope === "tenant:42" && path.endsWith("/fail")) {
        return new Response(JSON.stringify({ grant: { ...pending, status: "active" } }))
      }
      if (scope === "tenant:42" && request.method === "DELETE") {
        return new Response(JSON.stringify({ grant: { ...pending, status: "revoked" } }))
      }
      if (scope === "session:111" && request.method === "DELETE") return new Response(JSON.stringify({ ok: true }))
      throw new Error(`unexpected DO request: ${scope} ${request.method} ${path}`)
    })

    const response = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "https://mcp.example.com/api" }),
      env(kv, namespace),
    )

    expect(response.status).toBe(502)
    expect(calls.some(({ request }) => request.method === "POST" && /\/fail$/.test(request.url))).toBe(true)
    expect(
      calls.some(
        ({ scope, request }) =>
          scope === "tenant:42" && request.method === "DELETE" && /\/broker\/servers\//.test(request.url),
      ),
    ).toBe(true)
  })

  it("fails the grant and removes the owner server when connect fails", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    let failAttempts = 0
    let cleanupAttempts = 0
    const { namespace, calls } = makeNamespace((scope, request) => {
      const path = new URL(request.url).pathname
      if (scope === "tenant:42" && path === "/grants") return new Response(JSON.stringify({ status: "pending" }))
      if (scope === "session:111" && path === "/connect") {
        return new Response(JSON.stringify({ status: "error", error: "provider secret details" }), { status: 502 })
      }
      if (scope === "tenant:42" && path.endsWith("/fail")) {
        failAttempts += 1
        return new Response(JSON.stringify({ grant: { status: failAttempts === 1 ? "retry" : "failed" } }), {
          status: failAttempts === 1 ? 500 : 200,
        })
      }
      if (scope === "session:111" && request.method === "DELETE") {
        cleanupAttempts += 1
        return new Response(JSON.stringify({ ok: cleanupAttempts > 1 }), { status: cleanupAttempts === 1 ? 500 : 200 })
      }
      throw new Error(`unexpected DO request: ${scope} ${request.method} ${path}`)
    })

    const response = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "https://mcp.example.com/api" }),
      env(kv, namespace),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "failed to connect" })
    expect({ failAttempts, cleanupAttempts }).toEqual({ failAttempts: 2, cleanupAttempts: 2 })
    expect(calls.some(({ scope, request }) => scope === "tenant:42" && /\/fail$/.test(request.url))).toBe(true)
    expect(
      calls.some(
        ({ scope, request }) =>
          scope === "session:111" && request.method === "DELETE" && /\/servers\//.test(request.url),
      ),
    ).toBe(true)
  })

  it("a non-owner admin revokes org access without purging the owner's token", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-2", 222, "other")
    stubGitHubAdmin(42)
    const { namespace, idFromNameCalls } = makeNamespace(
      () =>
        new Response(
          JSON.stringify({
            grant: { ownerScope: "session:111", serverId: "server-private", grantId: "grant-1" },
          }),
        ),
    )

    const response = await dispatch(orgRequest("DELETE", 42, "sess-2", "/grant-1"), env(kv, namespace))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(idFromNameCalls).toEqual(["tenant:42"])
  })

  it("the owner admin revokes org access and purges the owner server", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    const { namespace, idFromNameCalls, calls } = makeNamespace((scope, request) => {
      if (scope === "tenant:42") {
        return new Response(
          JSON.stringify({ grant: { ownerScope: "session:111", serverId: "server-private", grantId: "grant-1" } }),
        )
      }
      if (scope === "session:111" && request.method === "DELETE") return new Response(JSON.stringify({ ok: true }))
      return new Response("not found", { status: 404 })
    })

    const response = await dispatch(orgRequest("DELETE", 42, "sess-1", "/grant-1"), env(kv, namespace))

    expect(response.status).toBe(200)
    expect(idFromNameCalls).toEqual(["tenant:42", "session:111"])
    expect(calls.at(-1)?.request.url).toBe("https://mcp-connections.do/servers/server-private")
    expect(JSON.stringify(await response.json())).not.toMatch(/owner|server-private/i)
  })

  it("sanitizes broker internals from list responses and adds credentialed portal CORS", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    const { namespace } = makeNamespace(
      () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                grantId: "grant-public",
                ownerScope: "session:111",
                serverId: "server-private",
                accessToken: "secret-token",
                access_token: "snake-secret-token",
                headers: { authorization: "nested-secret" },
                name: "Linear",
              },
            ],
          }),
        ),
    )

    const response = await dispatch(orgRequest("GET", 42, "sess-1", "", undefined, PORTAL_ORIGIN), env(kv, namespace))
    const serialized = await response.text()

    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(JSON.parse(serialized)).toEqual({ servers: [{ name: "Linear", id: "grant-public" }] })
    expect(serialized).not.toMatch(/session:111|server-private|secret-token|snake-secret-token|nested-secret/)
  })

  it("maps malformed successful list and policy broker envelopes to 502", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    stubGitHubAdmin(42)
    const { namespace } = makeNamespace(() => new Response("{}", { status: 200 }))
    const environment = env(kv, namespace)

    const list = await dispatch(orgRequest("GET", 42, "sess-1"), environment)
    const policy = await dispatch(orgRequest("GET", 42, "sess-1", "/grant-1/policy"), environment)

    expect(list.status).toBe(502)
    expect(policy.status).toBe(502)
    expect(await list.json()).toEqual({ error: "MCP broker failed" })
    expect(await policy.json()).toEqual({ error: "MCP broker failed" })
  })

  it("rejects unsafe, non-JSON, and oversized create requests before any DO call", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))
    const environment = env(kv, namespace)

    const unsafe = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: "http://169.254.169.254/latest/meta-data" }),
      environment,
    )
    const noType = new Request("https://api.sigilix.ai/v1/org/42/mcp/servers", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=sess-1` },
      body: JSON.stringify({ url: "https://mcp.example.com" }),
    })
    const wrongType = await dispatch(noType, environment)
    const oversized = await dispatch(
      orgRequest("POST", 42, "sess-1", "", { url: `https://mcp.example.com/${"x".repeat(17_000)}` }),
      environment,
    )

    expect([unsafe.status, wrongType.status, oversized.status]).toEqual([400, 415, 413])
    expect(idFromNameCalls).toEqual([])
  })

  it("answers CORS preflight only for an allowlisted portal origin", async () => {
    const { namespace } = makeNamespace(() => new Response("not reached"))
    const request = new Request("https://api.sigilix.ai/v1/org/42/mcp/servers", {
      method: "OPTIONS",
      headers: { origin: PORTAL_ORIGIN },
    })
    const response = await dispatch(request, env(makeKV(), namespace))

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
  })
})

describe("tenant-key MCP runtime", () => {
  it("exposes only the versioned public app names and aliases", async () => {
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))
    const request = new Request("https://api.sigilix.ai/v1/apps/catalog", {
      headers: { origin: PORTAL_ORIGIN },
    })

    const response = await dispatch(request, env(makeKV(), namespace))
    const body = (await response.json()) as {
      version: number
      apps: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(body.version).toBe(1)
    expect(body.apps).toContainEqual(
      expect.objectContaining({ id: "github", canonicalMention: "@GitHub", aliases: ["@gh"], surfaces: [] }),
    )
    expect(body.apps).toContainEqual(
      expect.objectContaining({
        id: "datadog",
        canonicalMention: "@Datadog",
        surfaces: ["chat", "deep-research", "cli"],
      }),
    )
    expect(body.apps).toContainEqual(
      expect.objectContaining({
        id: "netlify",
        canonicalMention: "@Netlify",
        surfaces: ["chat", "deep-research", "cli"],
      }),
    )
    expect(JSON.stringify(body)).not.toMatch(/serverId|grant|https?:\/\//)
    expect(idFromNameCalls).toEqual([])
  })

  it("resolves and strips a leading app mention without contacting the tenant broker", async () => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))

    const response = await dispatch(
      appResolveRequest("  @LiNeAr: list recent comments", bearer),
      env(makeKV(), namespace, db),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      version: 1,
      route: {
        kind: "resolved",
        task: "list recent comments",
        appId: "linear",
        mention: "@Linear",
      },
    })
    expect(idFromNameCalls).toEqual([])
  })

  it.each([
    [
      "@forged.example list issues",
      "invalid_app_mention",
      "@forged.example",
      "Use a supported @App mention at the start of your request.",
    ],
    ["@MadeUp list issues", "unknown_app", "@MadeUp", "That app mention is not supported."],
    ["@Linear", "missing_app_task", "@Linear", "Add a request after the app mention."],
  ])("rejects %s before resolving a tenant broker", async (question, error, mention, message) => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))

    const response = await dispatch(appResolveRequest(question, bearer), env(makeKV(), namespace, db))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error, message, mention })
    expect(idFromNameCalls).toEqual([])
  })

  it("returns an ordinary task without selecting an app or tenant broker", async () => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))

    const response = await dispatch(appResolveRequest("list recent comments", bearer), env(makeKV(), namespace, db))

    expect(await response.json()).toEqual({
      version: 1,
      route: { kind: "none", task: "list recent comments" },
    })
    expect(idFromNameCalls).toEqual([])
  })

  it("routes an installation bearer to its tenant broker and preserves status and body", async () => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const upstreamBody = JSON.stringify({ tools: [{ grantId: "grant-1", name: "list_issues" }] })
    const { namespace, idFromNameCalls, calls } = makeNamespace((_scope, request) => {
      expect(request.headers.get("authorization")).toBeNull()
      return new Response(upstreamBody, {
        status: 207,
        headers: { "content-type": "application/json", authorization: "internal-secret" },
      })
    })

    const response = await dispatch(
      runtimeRequest({ surface: "cli", appId: "linear", question: "raw text must not cross the broker seam" }, bearer),
      env(makeKV(), namespace, db),
    )

    expect(response.status).toBe(207)
    expect(await response.text()).toBe(upstreamBody)
    expect(response.headers.get("authorization")).toBeNull()
    expect(idFromNameCalls).toEqual(["tenant:42"])
    expect(new URL(calls[0]!.request.url).pathname).toBe("/broker/runtime/catalog")
    expect(await calls[0]!.request.json()).toEqual({ surface: "cli", appId: "linear" })
  })

  it("routes invoke through the same tenant broker without forwarding bearer credentials", async () => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const { namespace, calls } = makeNamespace((_scope, request) => {
      expect(request.headers.get("authorization")).toBeNull()
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } }))
    })

    const response = await dispatch(
      runtimeRequest(
        {
          surface: "cli",
          installationId: 999,
          serverId: "grant-1",
          toolName: "list_issues",
          runId: "run-1",
          arguments: {},
        },
        bearer,
        undefined,
        "invoke",
      ),
      env(makeKV(), namespace, db),
    )

    expect(response.status).toBe(200)
    expect(new URL(calls[0]!.request.url).pathname).toBe("/broker/runtime/invoke")
    expect(await calls[0]!.request.json()).toEqual({
      surface: "cli",
      serverId: "grant-1",
      toolName: "list_issues",
      runId: "run-1",
      arguments: {},
    })
  })

  it("derives tenant and CLI scope for memory queries instead of trusting the caller", async () => {
    const db = await makeDb()
    const bearer = await seedApiKey(db, 42)
    const { namespace, calls } = makeNamespace((_scope, request) => {
      expect(request.headers.get("authorization")).toBeNull()
      return new Response(JSON.stringify({ results: [] }))
    })

    const response = await dispatch(
      runtimeRequest(
        {
          surface: "agent",
          installationId: 999,
          query: "what changed?",
          topK: 3,
          appId: "linear",
        },
        bearer,
        undefined,
        "memory/query",
      ),
      env(makeKV(), namespace, db),
    )

    expect(response.status).toBe(200)
    expect(new URL(calls[0]!.request.url).pathname).toBe("/broker/memory/query")
    expect(await calls[0]!.request.json()).toEqual({
      surface: "cli",
      query: "what changed?",
      topK: 3,
      appId: "linear",
    })
  })

  it("denies session and legacy-global callers before resolving a broker DO", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const db = await makeDb()
    await seedIdentity(db, "user-111", 111)
    const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))
    const environment = env(kv, namespace, db)

    const sessionResponse = await dispatch(runtimeRequest({ surface: "cli" }, undefined, "sess-1"), environment)
    const legacyResponse = await dispatch(runtimeRequest({ surface: "cli" }, LEGACY_KEY), environment)

    expect(sessionResponse.status).toBe(403)
    expect(await sessionResponse.json()).toEqual({ error: "tenant_scope_required" })
    expect(legacyResponse.status).toBe(403)
    expect(await legacyResponse.json()).toEqual({ error: "tenant_scope_required" })
    expect(idFromNameCalls).toEqual([])
  })

  it.each(["chat", "deep-research", "pr-review", "agent"])(
    "denies the %s surface before resolving a broker DO",
    async (surface) => {
      const db = await makeDb()
      const bearer = await seedApiKey(db, 42)
      const { namespace, idFromNameCalls } = makeNamespace(() => new Response("not reached", { status: 500 }))

      const response = await dispatch(runtimeRequest({ surface }, bearer), env(makeKV(), namespace, db))

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "surface_not_allowed" })
      expect(idFromNameCalls).toEqual([])
    },
  )
})
