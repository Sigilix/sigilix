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
    const { namespace } = makeMcpNamespace(
      () => new Response(JSON.stringify({ status: "connected", id: "srv-1", toolCount: 3 }), { status: 200 }),
    )
    const request = postServers({ url: "https://example.com/mcp", name: "Example" }, "sess-1")
    request.headers.set("origin", PORTAL_ORIGIN)
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    const body = (await res.json()) as { status: string; toolCount: number }
    expect(body).toMatchObject({ status: "connected", toolCount: 3 })
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

  it("rejects an auth_required result for an api-key (tenant) caller — the OAuth callback can only resolve a session scope", async () => {
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
    const { namespace } = makeMcpNamespace(
      () =>
        new Response(JSON.stringify({ status: "auth_required", id: "srv-1", authUrl: "https://provider/authorize" }), {
          status: 200,
        }),
    )
    const request = new Request("https://api.sigilix.ai/v1/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ url: "https://example.com/mcp" }),
    })
    const res = await dispatch(request, { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/signed-in browser session/)
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

describe("GET /mcp/oauth/callback", () => {
  function callbackRequest(cookie?: string, search = "?code=abc&state=xyz"): Request {
    const headers = new Headers()
    if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
    return new Request(`https://api.sigilix.ai/mcp/oauth/callback${search}`, { headers })
  }

  it("redirects to the portal with mcpConnected=1 on a successful callback", async () => {
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
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/#/apps?mcpConnected=1`)
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
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/#/apps?mcpError=oauth_failed`)
  })

  it("redirects with mcpError=unauthenticated when there is no session at all (fail-soft, never a raw 401 mid-OAuth)", async () => {
    const env = baseEnv({ OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: await makeDb() })
    const { namespace } = makeMcpNamespace(() => new Response("should not be called", { status: 500 }))
    const res = await dispatch(callbackRequest(undefined), { ...env, MCP_CONNECTIONS: namespace })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${PORTAL_ORIGIN}/#/apps?mcpError=unauthenticated`)
  })
})
