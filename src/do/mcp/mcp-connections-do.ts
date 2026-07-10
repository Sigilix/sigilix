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
// SIG-193 P2A adds a DO-internal, read-only runtime catalog/invoke seam. It is
// deliberately not exposed by the public Worker router and is not wired into a
// model loop in this slice; only exact server-owned read capabilities survive.

import { DurableObject } from "cloudflare:workers"
import { MCPClientManager } from "agents/mcp/client"
import { SlackAwareOAuthProvider } from "./slack-oauth-provider"
import { areBoundedMcpArguments, sanitizeMcpInputSchema, sanitizeMcpResult } from "./runtime-data"
import {
  curatedReadTool,
  effectiveMcpPolicy,
  isMcpSurface,
  narrowMcpPolicy,
  type McpSurface,
  type StoredMcpPolicy,
} from "./runtime-policy"
import { guardUrl } from "@/src/do/deep-research/fetch-guard"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
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

/** Sigilix-owned policy state. Deliberately separate from the SDK table: SDK
 * upgrades remain free to manage cf_agents_mcp_servers without overwriting our
 * runtime grants. */
const MCP_POLICY_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS sigilix_mcp_policies (
    server_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    chat_enabled INTEGER NOT NULL CHECK (chat_enabled IN (0, 1)),
    deep_research_enabled INTEGER NOT NULL CHECK (deep_research_enabled IN (0, 1)),
    allowed_read_tools TEXT NOT NULL,
    max_calls_per_run INTEGER NOT NULL CHECK (max_calls_per_run >= 0 AND max_calls_per_run <= 4)
  )
`

const MCP_RUNTIME_CALLS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS sigilix_mcp_runtime_calls (
    run_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('chat', 'deep-research')),
    call_count INTEGER NOT NULL CHECK (call_count > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, server_id, surface)
  );
  CREATE INDEX IF NOT EXISTS sigilix_mcp_runtime_calls_updated_at
    ON sigilix_mcp_runtime_calls(updated_at)
`

const MAX_RUNTIME_BODY_BYTES = 16 * 1024
const RUNTIME_TOOL_TIMEOUT_MS = 10_000

export type McpConnectResult =
  | { status: "connected"; id: string; toolCount: number }
  | { status: "auth_required"; id: string; authUrl: string }
  | { status: "error"; error: string; existingId?: string }

export interface McpServerSummary {
  id: string
  name: string
  url: string
  status: string
  toolCount: number
}

export interface McpRuntimeToolDescriptor {
  serverId: string
  vendor: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpPolicyEnvelope {
  server: { id: string; name: string; url: string; status: string; vendorId: string }
  policy: {
    version: number
    enabled: boolean
    readOnly: true
    surfaces: { chat: boolean; deepResearch: boolean }
    allowedReadTools: string[]
    maxCallsPerRun: number
  }
  tools: Array<{
    id: string
    name: string
    description: string
    allowedByCatalog: boolean
    enabled: boolean
  }>
  blockedToolCount: number
  dataSensitivity: string
}

export class McpConnectionsAgent extends DurableObject<Env> {
  private readonly mcp: MCPClientManager
  private restored: Promise<void> | null = null
  /** In-flight reservation covering the async gap before the SDK row exists. */
  private readonly connectingEndpoints = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    // sig-worker-debrand-openclaw: SIGILIX_-preferred / OPENCLAW_-fallback env on
    // `this.env` (see normalize-env.ts).
    super(ctx, normalizeEnv(env))
    // Create the SDK's server table BEFORE handing storage to the manager, so
    // its restore/register/list SQL always has the table it assumes exists.
    // `sql.exec` is synchronous on a SQLite-backed DO and `IF NOT EXISTS`
    // keeps this idempotent across DO wakes.
    ctx.storage.sql.exec(MCP_SERVERS_TABLE_DDL)
    ctx.storage.sql.exec(MCP_POLICY_TABLE_DDL)
    ctx.storage.sql.exec(MCP_RUNTIME_CALLS_TABLE_DDL)
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
    if (request.method === "POST" && url.pathname === "/runtime/catalog") return this.handleRuntimeCatalog(request)
    if (request.method === "POST" && url.pathname === "/runtime/invoke") return this.handleRuntimeInvoke(request)
    if (request.method === "DELETE" && url.pathname.startsWith("/servers/")) {
      return this.handleDisconnect(decodeURIComponent(url.pathname.slice("/servers/".length)))
    }
    const policyMatch = /^\/servers\/([^/]+)\/policy$/.exec(url.pathname)
    if (policyMatch?.[1]) {
      const id = decodeURIComponent(policyMatch[1])
      if (request.method === "GET") return this.handlePolicyGet(id)
      if (request.method === "PUT") return this.handlePolicyPut(id, request)
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
    let body: { url?: unknown; name?: unknown; callbackUrl?: unknown; allowOAuth?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return connectJson({ status: "error", error: "invalid json" }, 400)
    }
    const rawUrl = typeof body.url === "string" ? body.url.trim() : ""
    const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : ""
    if (!rawUrl) return connectJson({ status: "error", error: "missing url" }, 400)
    if (!callbackUrl) return connectJson({ status: "error", error: "missing callback url" }, 400)
    if (body.allowOAuth !== undefined && typeof body.allowOAuth !== "boolean") {
      return connectJson({ status: "error", error: "invalid oauth policy" }, 400)
    }

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
    if (guard.url.protocol !== "https:") {
      return connectJson({ status: "error", error: "blocked url: https-required" }, 400)
    }
    if (guard.url.username || guard.url.password) {
      return connectJson({ status: "error", error: "blocked url: embedded-credentials" }, 400)
    }

    const canonicalUrl = canonicalMcpEndpointUrl(guard.url)
    if (!canonicalUrl) return connectJson({ status: "error", error: "blocked url: invalid-url" }, 400)
    const existing = this.mcp.listServers().find((row) => canonicalMcpEndpointUrl(row.server_url) === canonicalUrl)
    if (existing || this.connectingEndpoints.has(canonicalUrl)) {
      return connectJson(
        {
          status: "error",
          error: "this MCP server is already connected",
          ...(existing ? { existingId: existing.id } : {}),
        },
        409,
      )
    }
    // No await between the duplicate check and this reservation: concurrent
    // requests in the same principal-scoped DO cannot both pass the gate.
    this.connectingEndpoints.add(canonicalUrl)

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
      // Even though registerServer should only touch local state, SDK/SQLite
      // exception text can expose implementation details. Log it server-side
      // and keep the authenticated caller's response generic.
      const detail = err instanceof Error ? err.message : String(err)
      console.error("mcp-connections: registerServer failed", detail)
      this.connectingEndpoints.delete(canonicalUrl)
      await this.mcp.removeServer(id).catch(() => {})
      return connectJson({ status: "error", error: "registration failed" }, 502)
    }
    // The persisted/listed SDK row is now the durable duplicate guard.
    this.connectingEndpoints.delete(canonicalUrl)

    let result
    try {
      result = await this.mcp.connectToServer(id)
    } catch (err) {
      console.error("mcp-connections: connectToServer failed", err instanceof Error ? err.message : err)
      await this.mcp.removeServer(id).catch(() => {})
      return connectJson({ status: "error", error: "connect failed" }, 502)
    }

    if (result.state === "authenticating") {
      if (body.allowOAuth === false) {
        // API-key callers cannot complete the browser-cookie callback. Remove
        // the pending SDK row in the owning DO before returning the rejection,
        // so no credential or server orphan survives the failed flow.
        try {
          await this.mcp.removeServer(id)
        } catch (err) {
          console.error("mcp-connections: oauth rejection cleanup failed", err instanceof Error ? err.message : err)
          return connectJson({ status: "error", error: "oauth cleanup failed" }, 502)
        }
        return connectJson({ status: "error", error: "OAuth connections require a signed-in browser session" }, 400)
      }
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
    this.deleteStoredPolicy(id)
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
    } else if (result.serverId) {
      await this.mcp.removeServer(result.serverId).catch((err) => {
        console.error("mcp-connections: rejected oauth cleanup failed", err instanceof Error ? err.message : err)
      })
    }
    return json(result)
  }

  private handlePolicyGet(id: string): Response {
    const row = this.serverRow(id)
    if (!row) return json({ error: "not found" }, 404)
    return json(this.buildPolicyEnvelope(row))
  }

  private async handlePolicyPut(id: string, request: Request): Promise<Response> {
    const row = this.serverRow(id)
    if (!row) return json({ error: "not found" }, 404)
    const raw = await readBodyCapped(request, MAX_RUNTIME_BODY_BYTES)
    if (raw === null) return json({ error: "payload_too_large" }, 413)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return json({ error: "invalid json" }, 400)
    }
    const currentVersion = this.readStoredPolicy(id)?.version ?? 0
    const narrowed = narrowMcpPolicy(row.server_url, value, currentVersion)
    if (!narrowed.ok) return json({ error: narrowed.error }, narrowed.error === "stale_version" ? 409 : 400)
    this.writeStoredPolicy(id, narrowed.policy)
    return json(this.buildPolicyEnvelope(row, narrowed.policy))
  }

  private async handleRuntimeCatalog(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    if (!isMcpSurface(body.surface)) return json({ error: "invalid_surface" }, 400)
    return json(this.buildRuntimeCatalog(body.surface))
  }

  private async handleRuntimeInvoke(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    const serverId = typeof body.serverId === "string" ? body.serverId : ""
    const toolName = typeof body.toolName === "string" ? body.toolName : ""
    const runId = typeof body.runId === "string" ? body.runId : ""
    if (
      !isMcpSurface(body.surface) ||
      !serverId ||
      serverId.length > 128 ||
      !toolName ||
      toolName.length > 128 ||
      !safeRuntimeId(runId)
    ) {
      return json({ error: "invalid_request" }, 400)
    }
    if (!areBoundedMcpArguments(body.arguments)) return json({ error: "invalid_arguments" }, 400)

    // Rebuild from the live READY state and current stored policy immediately
    // before every call. A descriptor returned by an earlier catalog request is
    // never a capability token; revocation wins over stale client state.
    const current = this.buildRuntimeCatalog(body.surface, serverId)
    const allowed = current.tools.some((tool) => tool.serverId === serverId && tool.name === toolName)
    if (!allowed) return json({ error: "tool_not_allowed" }, 403)
    const row = this.serverRow(serverId)
    if (!row) return json({ error: "tool_not_allowed" }, 403)
    const policy = effectiveMcpPolicy(row.server_url, this.readStoredPolicy(serverId))
    if (!this.reserveRuntimeCall(runId, serverId, body.surface, policy.maxCallsPerRun)) {
      return json({ error: "max_calls_per_run_exceeded" }, 429)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RUNTIME_TOOL_TIMEOUT_MS)
    let result: unknown
    try {
      result = await Promise.race([
        this.mcp.callTool({ serverId, name: toolName, arguments: body.arguments }, undefined, {
          signal: controller.signal,
          timeout: RUNTIME_TOOL_TIMEOUT_MS,
          maxTotalTimeout: RUNTIME_TOOL_TIMEOUT_MS,
        }),
        timeoutRejection(controller.signal),
      ])
    } catch (_err) {
      const timedOut = controller.signal.aborted
      console.error(JSON.stringify({ event: "mcp-runtime-invoke-failed", serverId, toolName, timedOut }))
      return json({ error: timedOut ? "tool_timeout" : "tool_failed" }, timedOut ? 504 : 502)
    } finally {
      clearTimeout(timer)
    }
    const sanitized = sanitizeMcpResult(result)
    if (!sanitized) return json({ error: "unsupported_tool_result" }, 502)
    return json({ result: sanitized })
  }

  private buildRuntimeCatalog(
    surface: McpSurface,
    onlyServerId?: string,
  ): { tools: McpRuntimeToolDescriptor[]; blockedToolCount: number; unsupportedServerCount: number } {
    const tools: McpRuntimeToolDescriptor[] = []
    let blockedToolCount = 0
    let unsupportedServerCount = 0
    for (const row of this.mcp.listServers()) {
      if (onlyServerId && row.id !== onlyServerId) continue
      const connection = this.mcp.mcpConnections[row.id]
      if (connection?.connectionState !== "ready") continue
      const policy = effectiveMcpPolicy(row.server_url, this.readStoredPolicy(row.id))
      const discovered = this.mcp.listTools({ serverId: row.id }) as unknown[]
      if (policy.vendor === "custom") {
        unsupportedServerCount += 1
        blockedToolCount += discovered.length
        continue
      }
      const surfaceEnabled =
        policy.enabled &&
        policy.maxCallsPerRun > 0 &&
        (surface === "chat" ? policy.chatEnabled : policy.deepResearchEnabled)
      for (const candidate of discovered) {
        const remote = remoteTool(candidate)
        if (!remote || !surfaceEnabled || !policy.allowedReadTools.includes(remote.name)) {
          blockedToolCount += 1
          continue
        }
        const curated = curatedReadTool(row.server_url, remote.name)
        const inputSchema = sanitizeMcpInputSchema(remote.inputSchema)
        if (!curated || !inputSchema) {
          blockedToolCount += 1
          continue
        }
        tools.push({
          serverId: row.id,
          vendor: policy.vendor,
          name: curated.name,
          description: curated.description,
          inputSchema,
        })
      }
    }
    return { tools, blockedToolCount, unsupportedServerCount }
  }

  private async readRuntimeBody(request: Request): Promise<Record<string, unknown> | Response> {
    const raw = await readBodyCapped(request, MAX_RUNTIME_BODY_BYTES)
    if (raw === null) return json({ error: "payload_too_large" }, 413)
    try {
      const parsed = JSON.parse(raw) as unknown
      return isPlainObject(parsed) ? parsed : json({ error: "invalid json" }, 400)
    } catch {
      return json({ error: "invalid json" }, 400)
    }
  }

  private buildPolicyEnvelope(
    row: { id: string; name: string; server_url: string },
    stored = this.readStoredPolicy(row.id),
  ): McpPolicyEnvelope {
    const policy = effectiveMcpPolicy(row.server_url, stored)
    const status = this.mcp.mcpConnections[row.id]?.connectionState ?? "failed"
    const tools: McpPolicyEnvelope["tools"] = []
    let blockedToolCount = 0
    for (const candidate of this.mcp.listTools({ serverId: row.id }) as unknown[]) {
      const remote = remoteTool(candidate)
      if (!remote || !safeToolName(remote.name)) {
        blockedToolCount += 1
        continue
      }
      const curated = curatedReadTool(row.server_url, remote.name)
      const allowedByCatalog = curated !== null
      const enabled = policy.enabled && allowedByCatalog && policy.allowedReadTools.includes(remote.name)
      if (!enabled) blockedToolCount += 1
      tools.push({
        id: remote.name,
        name: remote.name,
        description: curated?.description ?? "Blocked until this exact read capability is reviewed by Sigilix.",
        allowedByCatalog,
        enabled,
      })
    }
    return {
      server: {
        id: row.id,
        name: row.name,
        url: row.server_url,
        status,
        vendorId: policy.vendor,
      },
      policy: {
        version: policy.version,
        enabled: policy.enabled,
        readOnly: true,
        surfaces: { chat: policy.chatEnabled, deepResearch: policy.deepResearchEnabled },
        allowedReadTools: policy.allowedReadTools,
        maxCallsPerRun: policy.maxCallsPerRun,
      },
      tools,
      blockedToolCount,
      dataSensitivity: policy.vendor === "custom" ? "custom-server-data" : `${policy.vendor}-account-data`,
    }
  }

  private serverRow(id: string): { id: string; name: string; server_url: string } | null {
    return this.mcp.listServers().find((row) => row.id === id) ?? null
  }

  private readStoredPolicy(serverId: string): StoredMcpPolicy | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        version: number
        enabled: number
        chat_enabled: number
        deep_research_enabled: number
        allowed_read_tools: string
        max_calls_per_run: number
      }>(
        `SELECT version, enabled, chat_enabled, deep_research_enabled, allowed_read_tools, max_calls_per_run
         FROM sigilix_mcp_policies WHERE server_id = ?`,
        serverId,
      )
      .toArray()[0]
    if (!row) return undefined
    try {
      const names = JSON.parse(row.allowed_read_tools) as unknown
      if (
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        !Number.isSafeInteger(row.max_calls_per_run) ||
        row.max_calls_per_run < 0 ||
        row.max_calls_per_run > 4 ||
        !Array.isArray(names) ||
        names.some((name) => typeof name !== "string" || !safeToolName(name))
      ) {
        return failClosedStoredPolicy(row.version)
      }
      return {
        version: row.version,
        enabled: row.enabled === 1,
        chatEnabled: row.chat_enabled === 1,
        deepResearchEnabled: row.deep_research_enabled === 1,
        allowedReadTools: names,
        maxCallsPerRun: row.max_calls_per_run,
      }
    } catch {
      return failClosedStoredPolicy(row.version)
    }
  }

  private writeStoredPolicy(serverId: string, policy: StoredMcpPolicy): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sigilix_mcp_policies
       (server_id, version, enabled, chat_enabled, deep_research_enabled, allowed_read_tools, max_calls_per_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         version = excluded.version,
         enabled = excluded.enabled,
         chat_enabled = excluded.chat_enabled,
         deep_research_enabled = excluded.deep_research_enabled,
         allowed_read_tools = excluded.allowed_read_tools,
         max_calls_per_run = excluded.max_calls_per_run`,
      serverId,
      policy.version,
      policy.enabled ? 1 : 0,
      policy.chatEnabled ? 1 : 0,
      policy.deepResearchEnabled ? 1 : 0,
      JSON.stringify(policy.allowedReadTools),
      policy.maxCallsPerRun,
    )
  }

  private deleteStoredPolicy(serverId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_policies WHERE server_id = ?", serverId)
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_runtime_calls WHERE server_id = ?", serverId)
  }

  private reserveRuntimeCall(runId: string, serverId: string, surface: McpSurface, maximum: number): boolean {
    if (maximum <= 0) return false
    const now = Date.now()
    // Run ids are short-lived. Opportunistic one-day GC prevents a trusted
    // internal caller bug from growing this counter table forever.
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_runtime_calls WHERE updated_at < ?", now - 86_400_000)
    const cursor = this.ctx.storage.sql.exec(
      `INSERT INTO sigilix_mcp_runtime_calls (run_id, server_id, surface, call_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(run_id, server_id, surface) DO UPDATE SET
         call_count = call_count + 1,
         updated_at = excluded.updated_at
       WHERE call_count < ?`,
      runId,
      serverId,
      surface,
      now,
      maximum,
    )
    return cursor.rowsWritten > 0
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function connectJson(body: McpConnectResult, status = 200): Response {
  return json(body, status)
}

function remoteTool(value: unknown): { name: string; inputSchema: unknown } | null {
  if (!isPlainObject(value) || typeof value.name !== "string") return null
  return { name: value.name, inputSchema: value.inputSchema }
}

function safeToolName(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

function safeRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

/** Normalize syntactic aliases that reach the same MCP transport endpoint. */
function canonicalMcpEndpointUrl(value: URL | string): string | null {
  try {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(value)
    url.hash = ""
    url.searchParams.sort()
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString()
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function timeoutRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("tool timeout"))
    signal.addEventListener("abort", () => reject(new Error("tool timeout")), { once: true })
  })
}

function failClosedStoredPolicy(version: number): StoredMcpPolicy {
  return {
    version: Number.isSafeInteger(version) && version > 0 ? version : 1,
    enabled: false,
    chatEnabled: false,
    deepResearchEnabled: false,
    allowedReadTools: [],
    maxCallsPerRun: 0,
  }
}
