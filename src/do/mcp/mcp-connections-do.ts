// sig-mcp-connections-p1 — McpConnectionsAgent: the Durable Object that owns
// one seat's (later one org's) custom MCP-server connections. One DO instance
// per scope id (idFromName("session:<githubUserId>") | "tenant:<installationId>"
// — see routes.ts), so token isolation across seats/tenants is enforced by DO
// naming, not by an in-DO ownership check.
//
// This is a thin wrapper around Cloudflare's `agents` SDK MCPClientManager —
// P1 deliberately does NOT extend the SDK's `Agent` class (which brings
// hibernation/websocket/hono routing this Worker doesn't use and already
// hand-rolls its own DO dispatch, matching DeepResearchDO's pattern). The
// SDK class alone gives us, for free: SSE + streamable-HTTP transport
// (auto-detected), the full OAuth 2.1 + Dynamic Client Registration flow,
// token storage + refresh in this DO's own SQLite, and tool discovery.
//
// P1 scope: connect (+ OAuth) / list / disconnect only. Nothing here wires
// `getAITools()` into the chat/deep-research tool loop yet — that is the P2
// fast-follow (see the scope doc: project-sigilix-portal-mcp-scope).

import { DurableObject } from "cloudflare:workers"
import { MCPClientManager } from "agents/mcp/client"
import { SlackAwareOAuthProvider } from "./slack-oauth-provider"
import { guardUrl } from "@/src/do/deep-research/fetch-guard"
import type { Env } from "@/src/shared/types/env"
import { normalizeEnv } from "@/src/shared/util/normalize-env"

/** Fixed identity handed to the SDK — used for OAuth client metadata + the
 *  DCR client name; NOT a secret and NOT per-server. */
const MCP_CLIENT_NAME = "sigilix-portal-mcp"
const MCP_CLIENT_VERSION = "1.0.0"

/** The SDK's `MCPClientManager` persists every registered server into a
 *  `cf_agents_mcp_servers` SQLite table (INSERT/SELECT/UPDATE/DELETE), but it
 *  never CREATEs that table itself — the DDL lives ONLY in the SDK's `Agent`
 *  base class (`_ensureSchema`), which this DO deliberately does NOT extend
 *  (see the file header). So we own the schema here, matching the SDK's table
 *  shape verbatim (agents/dist/index.js `_ensureSchema`). Without it the very
 *  first `saveServerToStorage` INSERT throws "no such table:
 *  cf_agents_mcp_servers", which the connect handler swallowed into a blanket
 *  "registration failed" for EVERY app. */
const MCP_SERVERS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    server_url TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    client_id TEXT,
    auth_url TEXT,
    server_options TEXT
  )
`

export type McpConnectResult =
  | { status: "connected"; id: string; toolCount: number }
  | { status: "auth_required"; id: string; authUrl: string }
  | { status: "error"; error: string }

export interface McpServerSummary {
  id: string
  name: string
  url: string
  status: string
  toolCount: number
}

export class McpConnectionsAgent extends DurableObject<Env> {
  private readonly mcp: MCPClientManager
  private restored: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    // sig-worker-debrand-openclaw: SIGILIX_-preferred / OPENCLAW_-fallback env on
    // `this.env` (see normalize-env.ts).
    super(ctx, normalizeEnv(env))
    // Create the SDK's server table BEFORE handing storage to the manager, so
    // its restore/register/list SQL always has the table it assumes exists.
    // `sql.exec` is synchronous on a SQLite-backed DO and `IF NOT EXISTS`
    // keeps this idempotent across DO wakes.
    ctx.storage.sql.exec(MCP_SERVERS_TABLE_DDL)
    this.mcp = new MCPClientManager(MCP_CLIENT_NAME, MCP_CLIENT_VERSION, {
      storage: ctx.storage,
      // Restored connections do NOT persist a transport.authProvider
      // (registerServer strips it before saving), so the manager rebuilds one via
      // this factory on wake — return the Slack-aware provider so a restored Slack
      // connection keeps its static confidential client instead of falling back to
      // DCR. The manager sets `.serverId` on the returned provider itself.
      createAuthProvider: (callbackUrl) =>
        new SlackAwareOAuthProvider(
          ctx.storage,
          MCP_CLIENT_NAME,
          callbackUrl,
          env.SIGILIX_SLACK_CLIENT_ID,
          env.SIGILIX_SLACK_CLIENT_SECRET,
        ),
    })
  }

  /** Route the internal DO requests, mirroring DeepResearchDO's fetch-based API. */
  override async fetch(request: Request): Promise<Response> {
    await this.ensureRestored()
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/connect") return this.handleConnect(request)
    if (request.method === "GET" && url.pathname === "/list") return this.handleList()
    if (request.method === "DELETE" && url.pathname.startsWith("/servers/")) {
      return this.handleDisconnect(decodeURIComponent(url.pathname.slice("/servers/".length)))
    }
    if (url.pathname === "/oauth-callback") return this.handleOAuthCallback(request)
    return json({ error: "not found" }, 404)
  }

  /** Restore any previously-persisted server connections (SDK SQLite) exactly
   *  once per DO wake — required so "persist" survives an eviction/restart. */
  private async ensureRestored(): Promise<void> {
    if (!this.restored) {
      this.restored = this.mcp.restoreConnectionsFromStorage(MCP_CLIENT_NAME).catch((err) => {
        console.error("mcp-connections: restore failed", err instanceof Error ? err.message : err)
      })
    }
    await this.restored
  }

  private async handleConnect(request: Request): Promise<Response> {
    let body: { url?: unknown; name?: unknown; callbackUrl?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return connectJson({ status: "error", error: "invalid json" }, 400)
    }
    const rawUrl = typeof body.url === "string" ? body.url.trim() : ""
    const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : ""
    if (!rawUrl) return connectJson({ status: "error", error: "missing url" }, 400)
    if (!callbackUrl) return connectJson({ status: "error", error: "missing callback url" }, 400)

    // Belt-and-suspenders SSRF re-check on the REGISTERED url — routes.ts
    // already validates it before calling in, but the DO must never trust
    // its caller either. This also closes an SDK gap: the SDK's own
    // isBlockedUrl deliberately ALLOWS loopback ("local dev"); guardUrl does
    // not. Residual, NOT covered by either guard (documented, not fixed
    // here — P1 scope): the SDK's transport follows HTTP redirects and
    // dials OAuth-metadata/token/DCR endpoints it discovers FROM the target
    // server using plain `fetch`, with no per-hop re-validation — same class
    // of gap fetch-guard.ts calls out for DNS-rebinding. Low practical
    // exploitability (Workers egress isn't routed to RFC1918/metadata the
    // way EC2's is), but a real residual worth a P2 follow-up if this
    // becomes a bigger attack surface.
    const guard = guardUrl(rawUrl)
    if (!guard.ok) return connectJson({ status: "error", error: `blocked url: ${guard.reason}` }, 400)

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : guard.url.hostname
    const id = crypto.randomUUID()

    try {
      // Fresh connect: attach the Slack-aware auth provider directly. registerServer
      // wires transport.authProvider into the connection (then strips it before
      // persisting — the ctor `createAuthProvider` factory covers the later restore
      // path). Without this, a first-time OAuth connect would have no auth provider
      // at all. serverId must be set so the provider can resolve its server host.
      const authProvider = new SlackAwareOAuthProvider(
        this.ctx.storage,
        MCP_CLIENT_NAME,
        callbackUrl,
        this.env.SIGILIX_SLACK_CLIENT_ID,
        this.env.SIGILIX_SLACK_CLIENT_SECRET,
      )
      authProvider.serverId = id
      await this.mcp.registerServer(id, {
        url: guard.url.toString(),
        name,
        callbackUrl,
        transport: { authProvider },
      })
    } catch (err) {
      // registerServer only touches LOCAL state (SSRF re-check + this DO's own
      // SQLite) — never third-party content — so the detail is safe to surface
      // and specific enough to be actionable instead of a blanket
      // "registration failed" for every app.
      const detail = err instanceof Error ? err.message : String(err)
      console.error("mcp-connections: registerServer failed", detail)
      return connectJson({ status: "error", error: `registration failed: ${detail}` }, 502)
    }

    let result
    try {
      result = await this.mcp.connectToServer(id)
    } catch (err) {
      console.error("mcp-connections: connectToServer failed", err instanceof Error ? err.message : err)
      await this.mcp.removeServer(id).catch(() => {})
      return connectJson({ status: "error", error: "connect failed" }, 502)
    }

    if (result.state === "authenticating") {
      return connectJson({ status: "auth_required", id, authUrl: result.authUrl })
    }
    if (result.state === "failed") {
      // `result.error` may carry untrusted content surfaced by the target
      // server — log the detail server-side, return a generic message.
      console.error("mcp-connections: connect failed", result.error)
      await this.mcp.removeServer(id).catch(() => {})
      return connectJson({ status: "error", error: "failed to connect to the server" }, 502)
    }
    // "connected" — discover tools before reporting a count (best-effort; a
    // discovery failure still leaves the server connected, just tool-count 0).
    await this.mcp.discoverIfConnected(id).catch(() => undefined)
    const toolCount = this.mcp.listTools({ serverId: id }).length
    return connectJson({ status: "connected", id, toolCount })
  }

  private handleList(): Response {
    const rows = this.mcp.listServers()
    const servers: McpServerSummary[] = rows.map((row) => {
      const conn = this.mcp.mcpConnections[row.id]
      const status = conn?.connectionState ?? "failed"
      const toolCount = this.mcp.listTools({ serverId: row.id }).length
      return { id: row.id, name: row.name, url: row.server_url, status, toolCount }
    })
    return json({ servers })
  }

  private async handleDisconnect(id: string): Promise<Response> {
    if (!id) return json({ error: "not found" }, 404)
    const exists = this.mcp.listServers().some((row) => row.id === id)
    if (!exists) return json({ error: "not found" }, 404)
    await this.mcp.removeServer(id)
    return json({ ok: true })
  }

  private async handleOAuthCallback(request: Request): Promise<Response> {
    let result
    try {
      result = await this.mcp.handleCallbackRequest(request)
    } catch (err) {
      console.error("mcp-connections: oauth callback failed", err instanceof Error ? err.message : err)
      return json({ authSuccess: false, authError: "callback failed" })
    }
    if (result.authSuccess) {
      // Best-effort: bring the connection up + discover tools right away so
      // the portal's post-redirect list refresh shows it as connected. A
      // failure here does not undo the completed OAuth exchange — the caller
      // can always retry discovery from a later list/connect.
      await this.mcp.establishConnection(result.serverId).catch((err) => {
        console.error("mcp-connections: establishConnection failed", err instanceof Error ? err.message : err)
      })
    }
    return json(result)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function connectJson(body: McpConnectResult, status = 200): Response {
  return json(body, status)
}
