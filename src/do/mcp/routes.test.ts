// sig-mcp-connections-p1 — HTTP route tests for /v1/mcp/servers* and
// /mcp/oauth/callback. The DO itself is stubbed here (its own orchestration
// is covered by mcp-connections-do.test.ts) — these tests exercise dual
// auth, per-seat DO-instance naming (cross-seat isolation), the SSRF
// pre-check, fail-soft listing, ownership-scoped delete, CORS, and the
// OAuth-callback redirect. Auth setup mirrors workspace-prs-route.test.ts.

import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { tryHandleMcpRoute } from "./routes"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"
import { hashMcpOAuthState } from "./oauth-callback-routing"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const GLOBAL_KEY = "global-shared-secret-token"
const PORTAL_ORIGIN = "https://app.sigilix.ai"

const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
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
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify([{ role: "admin", state: "active", organization: { login: "acme" } }]))
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
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

async function seedProviderSession(kv: KVNamespace, sessionId: string, userId?: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: "provider-user",
    ...(userId !== undefined ? { userId } : {}),
    accessToken: "",
    encryptionKeyB64url: ENC_KEY,
  })
}

/** A fake DurableObjectNamespace whose stub's fetch is fully test-controlled.
 *  Records every idFromName() call so tests can assert per-caller scoping. */
function makeMcpNamespace(handler: (req: Request) => Promise<Response> | Response) {
  const idFromNameCalls: string[] = []
  const stub = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input, init))),
  }
  const namespace = {
    idFromName: (name: string) => {
      idFromNameCalls.push(name)
      return { toString: () => name } as unknown as DurableObjectId
    },
    get: () => stub as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  return { namespace, idFromNameCalls }
}

function baseEnv(over: Partial<Env>): Env {
  return { OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY, ...over } as unknown as Env
}

function postServers(body: unknown, cookie?: string): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
  return new Request("https://api.sigilix.ai/v1/mcp/servers", { method: "POST", headers, body: JSON.stringify(body) })
}

function getServers(cookie?: string): Request {
  const headers = new Headers()
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
  return new Request("https://api.sigilix.ai/v1/mcp/servers", { headers })
}

function deleteServer(id: string, cookie?: string): Request {
  const headers = new Headers()
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
  return new Request(`https://api.sigilix.ai/v1/mcp/servers/${id}`, { method: "DELETE", headers })
}

function serverPolicy(id: string, method: "GET" | "PUT", cookie: string, body?: unknown): Request {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookie}` })
  if (body !== undefined) headers.set("content-type", "application/json")
  return new Request(`https://api.sigilix.ai/v1/mcp/servers/${id}/policy`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext
  const res = await tryHandleMcpRoute(request, env, ctx, new URL(request.url))
  if (!res) throw new Error("route did not match")
  return res
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("POST /v1/mcp/servers", () => {
  it("401 with no session and no api key", async () => {
    const kv = makeKV()
    const env = baseEnv({ OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("should not be called", { status: 500 }))
    const res = await dispatch(postServers({ url: "https://example.com/mcp" }), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(401)
  })

  it("415 without a json content-type (CSRF guard)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=sess-1` },
      body: JSON.stringify({ url: "https://example.com/mcp" }),
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(415)
  })

  it("400s a private-network URL before ever reaching the DO (SSRF pre-check)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const doFetch = vi.fn(() => new Response("should not be called", { status: 500 }))
    const { namespace } = makeMcpNamespace(doFetch)
    const res = await dispatch(postServers({ url: "http://169.254.169.254/latest/meta-data" }, "sess-1"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(400)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("400s a public plaintext HTTP URL before ever reaching the DO", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const doFetch = vi.fn(() => new Response("should not be called", { status: 500 }))
    const { namespace } = makeMcpNamespace(doFetch)
    const res = await dispatch(postServers({ url: "http://example.com/mcp" }, "sess-1"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(400)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("400s connection URLs carrying query-string credentials before reaching the DO", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const environment = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const doFetch = vi.fn(() => new Response("should not be called", { status: 500 }))
    const { namespace } = makeMcpNamespace(doFetch)
    const res = await dispatch(postServers({ url: "https://example.com/mcp?token=secret" }, "sess-1"), {
      ...environment,
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(400)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("fails closed for a live session with no stable principal id", async () => {
    const kv = makeKV()
    await seedProviderSession(kv, "sess-unstable")
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const doFetch = vi.fn(() => new Response("should not be called", { status: 500 }))
    const { namespace, idFromNameCalls } = makeMcpNamespace(doFetch)
    const res = await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-unstable"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "stable_identity_required" })
    expect(idFromNameCalls).toEqual([])
  })

  it("uses the persistent user id for a non-GitHub session", async () => {
    const kv = makeKV()
    await seedProviderSession(kv, "sess-provider", "user-uuid-1")
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace, idFromNameCalls } = makeMcpNamespace(
      () => new Response(JSON.stringify({ status: "connected", id: "srv-1", toolCount: 0 })),
    )
    await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-provider"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(idFromNameCalls).toEqual(["session:user-uuid-1"])
  })

  it("400s on a missing url", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const res = await dispatch(postServers({}, "sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(400)
  })

  it("happy path: relays the DO's connected result and carries portal CORS headers", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    let connectBody: Record<string, unknown> | undefined
    const { namespace } = makeMcpNamespace(async (request) => {
      connectBody = (await request.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ status: "connected", id: "srv-1", toolCount: 3 }), { status: 200 })
    })
    const request = postServers({ url: "https://example.com/mcp", name: "Example" }, "sess-1")
    request.headers.set("origin", PORTAL_ORIGIN)
    const res = await dispatch(request, {
      ...env,
      OPENCLAW_BASE_URL: "https://callbacks.sigilix.ai/configured/path",
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    const body = (await res.json()) as { status: string; toolCount: number }
    expect(body).toMatchObject({ status: "connected", toolCount: 3 })
    expect(connectBody?.callbackUrl).toBe("https://callbacks.sigilix.ai/mcp/oauth/callback")
  })

  it("relays a duplicate-endpoint conflict with the existing server id", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "this MCP server is already connected",
            existingId: "srv-existing",
          }),
          { status: 409 },
        ),
    )

    const res = await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-1"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "this MCP server is already connected",
      existingServerId: "srv-existing",
    })
  })

  it("relays an auth_required result with its authUrl", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(
      () =>
        new Response(JSON.stringify({ status: "auth_required", id: "srv-1", authUrl: "https://provider/authorize" }), {
          status: 200,
        }),
    )
    const res = await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-1"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; authUrl: string }
    expect(body.status).toBe("auth_required")
    expect(body.authUrl).toBe("https://provider/authorize")
  })

  it("rejects and cleans up auth_required for an api-key caller", async () => {
    const db = await makeDb()
    const plaintext = "sigilix_live_mcp_tenant_oauth"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: db })
    const seen: Request[] = []
    const { namespace } = makeMcpNamespace(async (request) => {
      seen.push(request)
      if (request.method === "DELETE") return new Response(JSON.stringify({ ok: true }))
      const body = (await request.json()) as { allowOAuth?: boolean }
      expect(body.allowOAuth).toBe(false)
      return new Response(
        JSON.stringify({ status: "auth_required", id: "srv-1", authUrl: "https://provider/authorize" }),
      )
    })
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ url: "https://example.com/mcp" }),
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/signed-in browser session/)
    expect(seen.map((request) => request.method)).toEqual(["POST", "DELETE"])
  })

  it("denies the legacy global bearer because it has no tenant boundary", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const doFetch = vi.fn(() => new Response("should not be called", { status: 500 }))
    const { namespace, idFromNameCalls } = makeMcpNamespace(doFetch)
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GLOBAL_KEY}` },
      body: JSON.stringify({ url: "https://example.com/mcp" }),
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "tenant_scope_required" })
    expect(idFromNameCalls).toEqual([])
  })

  it("scopes different sessions to different DO instances (cross-seat isolation)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-a", "user-a", 111)
    await seedSession(kv, "sess-b", "user-b", 222)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace, idFromNameCalls } = makeMcpNamespace(
      () => new Response(JSON.stringify({ status: "connected", id: "srv-1", toolCount: 0 }), { status: 200 }),
    )
    await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-a"), { ...env, MCP_CONNECTIONS: namespace })
    await dispatch(postServers({ url: "https://example.com/mcp" }, "sess-b"), { ...env, MCP_CONNECTIONS: namespace })
    expect(idFromNameCalls).toEqual(["session:111", "session:222"])
  })

  it("api-key path scopes by installation id, distinct from any session scope", async () => {
    const db = await makeDb()
    const plaintext = "sigilix_live_mcp_test"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: db })
    const { namespace, idFromNameCalls } = makeMcpNamespace(
      () => new Response(JSON.stringify({ status: "connected", id: "srv-1", toolCount: 0 }), { status: 200 }),
    )
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ url: "https://example.com/mcp" }),
    })
    await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(idFromNameCalls).toEqual(["tenant:42"])
  })
})

describe("GET /v1/mcp/servers", () => {
  it("401 with no auth", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const res = await dispatch(getServers(), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(401)
  })

  it("relays the DO's server list", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const servers = [{ id: "srv-1", name: "Example", url: "https://example.com/mcp", status: "ready", toolCount: 2 }]
    const { namespace } = makeMcpNamespace(() => new Response(JSON.stringify({ servers }), { status: 200 }))
    const res = await dispatch(getServers("sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ servers })
  })

  it("fail-soft: a DO fetch failure returns an empty list, never a 500", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(() => {
      throw new Error("DO unreachable")
    })
    const res = await dispatch(getServers("sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ servers: [] })
  })
})

describe("DELETE /v1/mcp/servers/:id", () => {
  it("401 with no auth", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const res = await dispatch(deleteServer("srv-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(401)
  })

  it("404s when the DO reports the id isn't this caller's (no existence leak)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
    const res = await dispatch(deleteServer("someone-elses-server", "sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(404)
  })

  it("200s + ok:true on a successful disconnect", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const res = await dispatch(deleteServer("srv-1", "sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("GET/PUT /v1/mcp/servers/:id/policy", () => {
  it("relays the owning DO's stable policy envelope", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const envelope = {
      server: { id: "srv-1", name: "Linear", url: "https://mcp.linear.app/mcp", status: "ready", vendorId: "linear" },
      policy: {
        version: 0,
        enabled: true,
        readOnly: true,
        surfaces: { chat: true, deepResearch: true },
        allowedReadTools: ["list_comments"],
        maxCallsPerRun: 4,
      },
      tools: [],
      blockedToolCount: 0,
      dataSensitivity: "linear-account-data",
    }
    const { namespace, idFromNameCalls } = makeMcpNamespace(() => new Response(JSON.stringify(envelope)))
    const response = await dispatch(serverPolicy("srv-1", "GET", "sess-1"), {
      ...env,
      MCP_CONNECTIONS: namespace,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(envelope)
    expect(idFromNameCalls).toEqual(["session:111"])
  })

  it("forwards a bounded policy update and preserves a 409 stale version", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const seen = vi.fn(async (request: Request) => {
      expect(request.method).toBe("PUT")
      expect(await request.json()).toMatchObject({ version: 0, enabled: false })
      return new Response(JSON.stringify({ error: "stale_version" }), { status: 409 })
    })
    const { namespace } = makeMcpNamespace(seen)
    const response = await dispatch(
      serverPolicy("srv-1", "PUT", "sess-1", {
        version: 0,
        enabled: false,
        surfaces: { chat: false, deepResearch: false },
        allowedReadTools: [],
        maxCallsPerRun: 0,
      }),
      { ...env, MCP_CONNECTIONS: namespace },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "stale_version" })
  })
})

describe("OPTIONS preflight", () => {
  it("answers a preflight for the allowlisted portal origin", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "OPTIONS",
      headers: { origin: PORTAL_ORIGIN },
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
  })

  it("403s a preflight from a non-allowlisted origin", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("nope", { status: 500 }))
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(403)
  })
})

describe("tenant MCP runtime broker", () => {
  it("exposes invoke only behind installation-bound authentication", async () => {
    const request = new Request("https://api.sigilix.ai/v1/mcp/runtime/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const result = await tryHandleMcpRoute(
      request,
      baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() }),
      { waitUntil: () => undefined } as unknown as ExecutionContext,
      new URL(request.url),
    )
    expect(result?.status).toBe(401)
  })
})

describe("GET /mcp/oauth/callback", () => {
  function callbackRequest(cookie?: string, search = "?code=abc&state=xyz"): Request {
    const headers = new Headers()
    if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
    return new Request(`https://api.sigilix.ai/mcp/oauth/callback${search}`, { headers })
  }

  it("rejects a callback when no strongly-consistent route exists instead of falling through", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(
      () => new Response(JSON.stringify({ authSuccess: true, serverId: "srv-1" }), { status: 200 }),
    )
    const res = await dispatch(callbackRequest("sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/?mcpError=oauth_failed#/apps`)
  })

  it("redirects with mcpError=oauth_failed when the SDK reports failure", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
    })
    const { namespace } = makeMcpNamespace(
      () => new Response(JSON.stringify({ authSuccess: false, authError: "access_denied" }), { status: 200 }),
    )
    const res = await dispatch(callbackRequest("sess-1"), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/?mcpError=oauth_failed#/apps`)
  })

  it("forwards a processing route with its existing claim so token-stored activation can retry", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    stubGitHubAdmin(42)
    const stateHash = await hashMcpOAuthState("xyz")
    if (!stateHash) throw new Error("state hash missing")
    const route = {
      version: 2,
      stateHash,
      ownerScope: "session:111",
      tenantScope: "tenant:42",
      grantId: "grant-retry",
      serverId: "server-retry",
      stableSubject: "111",
      status: "processing",
      claimId: "claim-existing",
      claimExpiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    }
    let ownerCalls = 0
    const { namespace } = makeMcpNamespace(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/oauth-route/read") return new Response(JSON.stringify({ route }))
      if (path === "/oauth-callback") {
        ownerCalls += 1
        expect(request.headers.get("x-sigilix-mcp-claim-id")).toBe("claim-existing")
        return new Response(JSON.stringify({ authSuccess: true, serverId: "grant-retry" }))
      }
      throw new Error(`unexpected DO path ${path}`)
    })
    const environment = baseEnv({
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: await makeDb(),
      MCP_CONNECTIONS: namespace,
    })

    const response = await dispatch(callbackRequest("sess-1"), environment)

    expect(response.headers.get("location")).toBe(`${PORTAL_ORIGIN}/?mcpConnected=1#/apps`)
    expect(ownerCalls).toBe(1)
  })

  it("redirects with mcpError=unauthenticated when there is no session at all (fail-soft, never a raw 401 mid-OAuth)", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("should not be called", { status: 500 }))
    const res = await dispatch(callbackRequest(undefined), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/?mcpError=unauthenticated#/apps`)
  })
})
