import { DurableObject } from "cloudflare:workers"
import { MCPClientManager } from "agents/mcp/client"
import { SlackAwareOAuthProvider } from "./slack-oauth-provider"
import { areBoundedMcpArguments, sanitizeMcpInputSchema, sanitizeMcpResult } from "./runtime-data"
import {
  curatedReadTool,
  effectiveMcpPolicy,
  isMcpRuntimeSurface,
  maximumMcpPolicy,
  mcpSurfaceEnabled,
  narrowMcpPolicy,
  type McpRuntimeSurface,
  type StoredMcpPolicy,
} from "./runtime-policy"
import { TenantMcpGrantRegistry, type TenantMcpGrant } from "./tenant-mcp-grant-registry"
import {
  putMcpOAuthCallbackRoute,
  readMcpOAuthCallbackRoute,
  updateMcpOAuthCallbackRoute,
  type McpOAuthCallbackRoute,
} from "./oauth-callback-routing"
import { McpOAuthCallbackDoHandler } from "./oauth-callback-do-handler"
import {
  JSON_HEADERS,
  brokerDescriptor,
  brokerPolicyEnvelope,
  canonicalMcpEndpointUrl,
  claimMcpOAuthProcessing,
  connectJson,
  ensureMcpConnectionsSchema,
  failClosedStoredPolicy,
  effectiveBrokerPolicy,
  isPlainObject,
  isPolicyEnvelope,
  isSessionOwnerScope,
  isStoredSurfacePolicy,
  json,
  parseConnectGrantContext,
  parseSafeId,
  readMcpOAuthCompletion,
  redactMcpUrl,
  remoteTool,
  safeActiveGrant,
  safeRuntimeId,
  safeToolName,
  timeoutRejection,
  writeMcpOAuthCompletion,
  type McpPolicyEnvelope,
  type McpRuntimeToolDescriptor,
} from "./mcp-connections-support"
import { guardUrl } from "@/src/do/deep-research/fetch-guard"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { normalizeEnv } from "@/src/shared/util/normalize-env"

export type { McpPolicyEnvelope, McpRuntimeToolDescriptor } from "./mcp-connections-support"

const MCP_CLIENT_NAME = "sigilix-portal-mcp"
const MCP_CLIENT_VERSION = "1.0.0"

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

export class McpConnectionsAgent extends DurableObject<Env> {
  private readonly mcp: MCPClientManager
  private readonly grants: TenantMcpGrantRegistry
  private readonly callbackRoutes: McpOAuthCallbackDoHandler
  private restored: Promise<void> | null = null
  /** In-flight reservation covering the async gap before the SDK row exists. */
  private readonly connectingEndpoints = new Set<string>()
  private readonly brokerInvocations = new Map<string, Set<Promise<void>>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, normalizeEnv(env))
    ensureMcpConnectionsSchema(ctx.storage)
    this.grants = new TenantMcpGrantRegistry(ctx.storage)
    this.callbackRoutes = new McpOAuthCallbackDoHandler(ctx.storage, this.env)
    this.mcp = new MCPClientManager(MCP_CLIENT_NAME, MCP_CLIENT_VERSION, {
      storage: ctx.storage,
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
    if (request.method === "POST" && url.pathname.startsWith("/oauth-route/")) {
      return this.callbackRoutes.handle(url.pathname.slice("/oauth-route/".length), request)
    }
    if (request.method === "POST" && url.pathname === "/connect") return this.handleConnect(request)
    if (request.method === "GET" && url.pathname === "/list") return this.handleList()
    if (request.method === "POST" && url.pathname === "/runtime/catalog") return this.handleRuntimeCatalog(request)
    if (request.method === "POST" && url.pathname === "/runtime/invoke") return this.handleRuntimeInvoke(request)
    if (request.method === "POST" && url.pathname === "/grants") return this.handleGrantCreate(request)
    if (request.method === "GET" && url.pathname === "/broker/list") return this.handleBrokerList()
    if (request.method === "POST" && url.pathname === "/broker/runtime/catalog") {
      return this.handleBrokerCatalog(request)
    }
    if (request.method === "POST" && url.pathname === "/broker/runtime/invoke") {
      return this.handleBrokerInvoke(request)
    }
    const grantTransition = /^\/grants\/([^/]+)\/(activate|fail)$/.exec(url.pathname)
    if (request.method === "POST" && grantTransition?.[1] && grantTransition[2]) {
      return this.handleGrantTransition(decodeURIComponent(grantTransition[1]), grantTransition[2])
    }
    const brokerPolicy = /^\/broker\/servers\/([^/]+)\/policy$/.exec(url.pathname)
    if (brokerPolicy?.[1] && (request.method === "GET" || request.method === "PUT")) {
      return this.handleBrokerPolicy(decodeURIComponent(brokerPolicy[1]), request)
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/broker/servers/")) {
      return this.handleBrokerRevoke(decodeURIComponent(url.pathname.slice("/broker/servers/".length)))
    }
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

  override async alarm(): Promise<void> {
    await this.callbackRoutes.alarm()
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
    let body: {
      serverId?: unknown
      url?: unknown
      name?: unknown
      callbackUrl?: unknown
      allowOAuth?: unknown
      grant?: unknown
    }
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
    const requestedServerId = body.serverId === undefined ? undefined : parseSafeId(body.serverId)
    if (body.serverId !== undefined && !requestedServerId) {
      return connectJson({ status: "error", error: "invalid server id" }, 400)
    }
    const grantContext = parseConnectGrantContext(body.grant)
    if (body.grant !== undefined && !grantContext) {
      return connectJson({ status: "error", error: "invalid grant context" }, 400)
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
    if (guard.url.search || guard.url.hash) {
      return connectJson({ status: "error", error: "blocked url: query-or-fragment-not-allowed" }, 400)
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
    this.connectingEndpoints.add(canonicalUrl)

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : guard.url.hostname
    const id = requestedServerId ?? crypto.randomUUID()

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
      if (grantContext) this.writeStoredPolicy(id, maximumMcpPolicy(guard.url.toString()))
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
      if (grantContext) {
        const route = await putMcpOAuthCallbackRoute({
          env: this.env,
          authUrl: result.authUrl,
          ownerScope: grantContext.ownerScope,
          tenantScope: grantContext.tenantScope,
          grantId: grantContext.grantId,
          serverId: id,
          stableSubject: grantContext.stableSubject,
        })
        if (!route) {
          await this.mcp.removeServer(id).catch(() => undefined)
          return connectJson({ status: "error", error: "failed to persist OAuth callback state" }, 502)
        }
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
      return { id: row.id, name: row.name, url: redactMcpUrl(row.server_url), status, toolCount }
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
    const ownerScope = request.headers.get("x-sigilix-mcp-owner-scope") ?? ""
    const stableSubject = request.headers.get("x-sigilix-mcp-stable-subject") ?? ""
    const claimId = request.headers.get("x-sigilix-mcp-claim-id") ?? ""
    if (!ownerScope || !stableSubject || !claimId) {
      return json({ authSuccess: false, authError: "callback state invalid" })
    }
    const route = await readMcpOAuthCallbackRoute({
      env: this.env,
      callbackUrl: request.url,
      ownerScope,
      stableSubject,
      expectedStatus: "processing",
    })
    if (!route || route.claimId !== claimId) {
      return json({ authSuccess: false, authError: "callback state invalid", retryable: true }, 409)
    }
    return this.handleGrantedOAuthCallback(request, route)
  }

  private async handleGrantedOAuthCallback(request: Request, route: McpOAuthCallbackRoute): Promise<Response> {
    const completion = readMcpOAuthCompletion(this.ctx.storage, route.stateHash)
    if (completion?.status === "completed" || completion?.status === "failed") {
      return this.finalizeStoredCompletion(request, route, completion.status)
    }

    // The SDK persists tokens before returning from handleCallbackRequest. If
    // the DO crashed in the tiny gap before our completion row, this check is
    // the recovery source of truth: never replay a single-use authorization
    // code or delete an already-valid credential.
    if (completion?.status === "token_stored" || (await this.hasStoredTokens(route.serverId))) {
      return this.reconcileGrantedOAuthSuccess(request, route)
    }
    if (!claimMcpOAuthProcessing(this.ctx.storage, route)) {
      return json({ authSuccess: false, authError: "callback processing", retryable: true }, 409)
    }

    let result
    try {
      result = await this.mcp.handleCallbackRequest(request)
    } catch (err) {
      console.error("mcp-connections: granted oauth callback failed", err instanceof Error ? err.message : err)
      if (await this.hasStoredTokens(route.serverId)) return this.reconcileGrantedOAuthSuccess(request, route)
      return this.finalizeGrantedOAuthFailure(request, route)
    }
    if (result.authSuccess) return this.reconcileGrantedOAuthSuccess(request, route)
    if (await this.hasStoredTokens(route.serverId)) return this.reconcileGrantedOAuthSuccess(request, route)
    return this.finalizeGrantedOAuthFailure(request, route)
  }

  private async reconcileGrantedOAuthSuccess(request: Request, route: McpOAuthCallbackRoute): Promise<Response> {
    writeMcpOAuthCompletion(this.ctx.storage, route, "token_stored")
    try {
      await this.mcp.establishConnection(route.serverId)
      const activated = await this.transitionTenantGrant(route, "activate")
      if (activated.outcome === "retryable") {
        return json({ authSuccess: false, authError: "grant activation pending", retryable: true }, 503)
      }
      if (activated.outcome === "terminal") return this.finalizeGrantedOAuthFailure(request, route)
      writeMcpOAuthCompletion(this.ctx.storage, route, "completed")
      return this.finalizeStoredCompletion(request, route, "completed")
    } catch (err) {
      console.error("mcp-connections: granted oauth reconciliation failed", err instanceof Error ? err.message : err)
      return json({ authSuccess: false, authError: "grant activation pending", retryable: true }, 503)
    }
  }

  private async finalizeGrantedOAuthFailure(request: Request, route: McpOAuthCallbackRoute): Promise<Response> {
    let credentialPurged = false
    await this.mcp.removeServer(route.serverId).then(
      () => {
        credentialPurged = true
      },
      (err: unknown) => {
        console.error(
          "mcp-connections: rejected granted oauth cleanup failed",
          err instanceof Error ? err.message : err,
        )
      },
    )
    await this.transitionTenantGrant(route, "fail")
    if (!credentialPurged) {
      return json({ authSuccess: false, authError: "callback cleanup pending", retryable: true }, 503)
    }
    writeMcpOAuthCompletion(this.ctx.storage, route, "failed", "callback failed")
    return this.finalizeStoredCompletion(request, route, "failed")
  }

  private async finalizeStoredCompletion(
    request: Request,
    route: McpOAuthCallbackRoute,
    status: "completed" | "failed",
  ): Promise<Response> {
    const finalized = await updateMcpOAuthCallbackRoute({
      env: this.env,
      callbackUrl: request.url,
      expected: route,
      status,
    })
    if (!finalized) {
      return json({ authSuccess: false, authError: "callback finalization pending", retryable: true }, 503)
    }
    return status === "completed"
      ? json({ authSuccess: true, serverId: route.grantId })
      : json({ authSuccess: false, authError: "callback failed" })
  }

  private async hasStoredTokens(serverId: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{
        client_id: string | null
        callback_url: string
      }>("SELECT client_id, callback_url FROM cf_agents_mcp_servers WHERE id = ?", serverId)
      .toArray()[0]
    if (!row?.client_id) return false
    try {
      const provider = new SlackAwareOAuthProvider(
        this.ctx.storage,
        MCP_CLIENT_NAME,
        row.callback_url,
        this.env.SIGILIX_SLACK_CLIENT_ID,
        this.env.SIGILIX_SLACK_CLIENT_SECRET,
      )
      provider.serverId = serverId
      provider.clientId = row.client_id
      return (await provider.tokens()) !== undefined
    } catch (err) {
      console.warn("mcp-connections: stored token check failed", err instanceof Error ? err.message : err)
      return false
    }
  }

  private async transitionTenantGrant(
    route: McpOAuthCallbackRoute,
    transition: "activate" | "fail",
  ): Promise<{ outcome: "active"; grant: TenantMcpGrant } | { outcome: "terminal" } | { outcome: "retryable" }> {
    if (!this.env.MCP_CONNECTIONS) return { outcome: "retryable" }
    const stub = this.env.MCP_CONNECTIONS.get(this.env.MCP_CONNECTIONS.idFromName(route.tenantScope))
    const response = await stub.fetch(
      `https://mcp-connections.do/grants/${encodeURIComponent(route.grantId)}/${transition}`,
      {
        method: "POST",
      },
    )
    if (!response.ok) return response.status === 404 ? { outcome: "terminal" } : { outcome: "retryable" }
    const body = (await response.json()) as { grant?: TenantMcpGrant }
    if (!body.grant) return { outcome: "retryable" }
    if (transition === "activate" && body.grant.status === "active") return { outcome: "active", grant: body.grant }
    if (transition === "fail" && (body.grant.status === "failed" || body.grant.status === "revoked")) {
      return { outcome: "terminal" }
    }
    return body.grant.status === "pending" ? { outcome: "retryable" } : { outcome: "terminal" }
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

  private async handleGrantCreate(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    const grantId = parseSafeId(body.grantId)
    const ownerScope = typeof body.ownerScope === "string" ? body.ownerScope : ""
    const serverId = parseSafeId(body.serverId)
    const creatorSubject = parseSafeId(body.creatorSubject)
    const serverUrl = typeof body.serverUrl === "string" ? body.serverUrl : ""
    if (!grantId || !serverId || !creatorSubject || !serverUrl || !isSessionOwnerScope(ownerScope)) {
      return json({ error: "invalid_grant" }, 400)
    }
    this.grants.gcStalePending(Date.now() - 15 * 60 * 1_000)
    try {
      const result = this.grants.createPending({ grantId, ownerScope, serverId, creatorSubject, serverUrl })
      return json(result, result.outcome === "created" ? 201 : 200)
    } catch (err) {
      console.warn("mcp-grants: create rejected", err instanceof Error ? err.message : err)
      return json({ error: "grant_conflict" }, 409)
    }
  }

  private handleGrantTransition(grantId: string, transition: string): Response {
    if (!parseSafeId(grantId)) return json({ error: "not found" }, 404)
    try {
      const grant = transition === "activate" ? this.grants.activate(grantId) : this.grants.fail(grantId)
      if (!grant) return json({ error: "not found" }, 404)
      return json({ grant })
    } catch {
      return json({ error: "not found" }, 404)
    }
  }

  private async handleBrokerList(): Promise<Response> {
    this.grants.gcStalePending(Date.now() - 15 * 60 * 1_000)
    const grants = this.grants.listOpen().slice(0, 32)
    const servers: Array<McpPolicyEnvelope["server"] & { grantStatus: TenantMcpGrant["status"] }> = []
    let partial = false
    for (const grant of grants) {
      try {
        const response = await this.ownerStub(grant.ownerScope).fetch(
          `https://mcp-connections.do/servers/${encodeURIComponent(grant.serverId)}/policy`,
        )
        if (!response.ok) {
          partial = true
          continue
        }
        const envelope = (await response.json()) as McpPolicyEnvelope
        if (!isPolicyEnvelope(envelope)) {
          partial = true
          continue
        }
        servers.push({ ...envelope.server, id: grant.grantId, grantStatus: grant.status })
      } catch (err) {
        partial = true
        console.warn("mcp-broker: list owner failed", err instanceof Error ? err.message : err)
      }
    }
    return json({ servers, partial })
  }

  private async handleBrokerPolicy(grantId: string, request: Request): Promise<Response> {
    const grant = safeActiveGrant(this.grants, grantId)
    if (!grant) return json({ error: "not found" }, 404)
    if (request.method === "PUT") {
      const body = await this.readRuntimeBody(request)
      if (body instanceof Response) return body
      const updated = this.grants.updatePolicy(grantId, body)
      if (!updated) return json({ error: "not found" }, 404)
      if ("error" in updated) return json({ error: updated.error }, updated.error === "stale_version" ? 409 : 400)
    }
    try {
      const response = await this.ownerStub(grant.ownerScope).fetch(
        `https://mcp-connections.do/servers/${encodeURIComponent(grant.serverId)}/policy`,
        { method: "GET" },
      )
      const text = await response.text()
      if (!response.ok) return new Response(text, { status: response.status, headers: JSON_HEADERS })
      const envelope = JSON.parse(text) as unknown
      if (!isPolicyEnvelope(envelope)) return json({ error: "invalid_owner_response" }, 502)
      return json(brokerPolicyEnvelope(this.grants.getActive(grantId)!, envelope))
    } catch (err) {
      console.error("mcp-broker: policy owner failed", err instanceof Error ? err.message : err)
      return json({ error: "broker_unavailable" }, 502)
    }
  }

  private async handleBrokerRevoke(grantId: string): Promise<Response> {
    if (!parseSafeId(grantId)) return json({ error: "not found" }, 404)
    try {
      const grant = this.grants.revoke(grantId)
      if (!grant) return json({ error: "not found" }, 404)
      const admitted = [...(this.brokerInvocations.get(grantId) ?? [])]
      if (admitted.length > 0) await Promise.allSettled(admitted)
      // This response is DO-internal. The edge route strips ownerScope/serverId
      // before answering the portal, using them only to let the consenting user
      // also purge their own provider credential.
      return json({ grant })
    } catch {
      return json({ error: "not found" }, 404)
    }
  }

  private async handleBrokerCatalog(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    if (!isMcpRuntimeSurface(body.surface)) return json({ error: "invalid_surface" }, 400)
    if (body.surface !== "cli") return json({ error: "surface_not_allowed" }, 403)
    const tools: McpRuntimeToolDescriptor[] = []
    let partial = false
    for (const grant of this.grants
      .listOpen()
      .filter((candidate) => candidate.status === "active")
      .slice(0, 32)) {
      try {
        const ownerEnvelope = await this.readOwnerPolicyEnvelope(grant)
        if (!ownerEnvelope) {
          partial = true
          continue
        }
        const effective = effectiveBrokerPolicy(grant, ownerEnvelope)
        if (!mcpSurfaceEnabled(effective, body.surface)) continue
        const response = await this.ownerStub(grant.ownerScope).fetch("https://mcp-connections.do/runtime/catalog", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface: body.surface, serverId: grant.serverId }),
        })
        if (!response.ok) {
          partial = true
          continue
        }
        const value = (await response.json()) as { tools?: unknown[] }
        if (!Array.isArray(value.tools)) {
          partial = true
          continue
        }
        for (const candidate of value.tools) {
          const descriptor = brokerDescriptor(candidate, grant)
          if (descriptor && effective.allowedReadTools.includes(descriptor.name)) tools.push(descriptor)
        }
      } catch (err) {
        partial = true
        console.warn("mcp-broker: catalog owner failed", err instanceof Error ? err.message : err)
      }
    }
    return json({ tools, partial })
  }

  private async handleBrokerInvoke(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    const grantId = parseSafeId(body.serverId)
    const toolName = parseSafeId(body.toolName)
    const runId = parseSafeId(body.runId)
    if (!isMcpRuntimeSurface(body.surface) || !grantId || !toolName || !runId) {
      return json({ error: "invalid_request" }, 400)
    }
    if (body.surface !== "cli") return json({ error: "surface_not_allowed" }, 403)
    if (!areBoundedMcpArguments(body.arguments)) return json({ error: "invalid_arguments" }, 400)
    const grant = this.grants.getActive(grantId)
    if (!grant) return json({ error: "tool_not_allowed" }, 403)
    // Admit synchronously in the tenant DO before the first await. Revoke
    // flips the durable grant state, then waits this exact promise set; no call
    // can slip through the getActive→lease gap after revoke returns.
    let release!: () => void
    const admitted = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = this.brokerInvocations.get(grantId) ?? new Set<Promise<void>>()
    active.add(admitted)
    this.brokerInvocations.set(grantId, active)
    try {
      const ownerEnvelope = await this.readOwnerPolicyEnvelope(grant)
      if (!ownerEnvelope) return json({ error: "broker_unavailable" }, 502)
      const effective = effectiveBrokerPolicy(grant, ownerEnvelope)
      if (!mcpSurfaceEnabled(effective, body.surface) || !effective.allowedReadTools.includes(toolName)) {
        return json({ error: "tool_not_allowed" }, 403)
      }
      if (!this.reserveRuntimeCall(runId, grantId, body.surface, effective.maxCallsPerRun)) {
        return json({ error: "max_calls_per_run_exceeded" }, 429)
      }
      const response = await this.ownerStub(grant.ownerScope).fetch("https://mcp-connections.do/runtime/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          surface: body.surface,
          serverId: grant.serverId,
          toolName,
          arguments: body.arguments,
        }),
      })
      const text = await response.text()
      return new Response(text, { status: response.status, headers: JSON_HEADERS })
    } catch (err) {
      console.warn("mcp-broker: invoke owner failed", err instanceof Error ? err.message : err)
      return json({ error: "broker_unavailable" }, 502)
    } finally {
      release()
      active.delete(admitted)
      if (active.size === 0) this.brokerInvocations.delete(grantId)
    }
  }

  private async readOwnerPolicyEnvelope(grant: TenantMcpGrant): Promise<McpPolicyEnvelope | null> {
    try {
      const response = await this.ownerStub(grant.ownerScope).fetch(
        `https://mcp-connections.do/servers/${encodeURIComponent(grant.serverId)}/policy`,
      )
      if (!response.ok) return null
      const value = (await response.json()) as unknown
      return isPolicyEnvelope(value) ? value : null
    } catch {
      return null
    }
  }

  private ownerStub(ownerScope: string): DurableObjectStub {
    return this.env.MCP_CONNECTIONS.get(this.env.MCP_CONNECTIONS.idFromName(ownerScope))
  }

  private async handleRuntimeCatalog(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    if (!isMcpRuntimeSurface(body.surface)) return json({ error: "invalid_surface" }, 400)
    const onlyServerId = body.serverId === undefined ? undefined : parseSafeId(body.serverId)
    if (body.serverId !== undefined && !onlyServerId) return json({ error: "invalid_request" }, 400)
    return json(this.buildRuntimeCatalog(body.surface, onlyServerId ?? undefined))
  }

  private async handleRuntimeInvoke(request: Request): Promise<Response> {
    const body = await this.readRuntimeBody(request)
    if (body instanceof Response) return body
    const serverId = typeof body.serverId === "string" ? body.serverId : ""
    const toolName = typeof body.toolName === "string" ? body.toolName : ""
    const runId = typeof body.runId === "string" ? body.runId : ""
    if (
      !isMcpRuntimeSurface(body.surface) ||
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
    surface: McpRuntimeSurface,
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
      const surfaceEnabled = policy.maxCallsPerRun > 0 && mcpSurfaceEnabled(policy, surface)
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
        url: redactMcpUrl(row.server_url),
        status,
        vendorId: policy.vendor,
      },
      policy: {
        version: policy.version,
        enabled: policy.enabled,
        readOnly: true,
        surfaces: policy.surfaces,
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
        surfaces: string
        allowed_read_tools: string
        max_calls_per_run: number
      }>(
        `SELECT version, enabled, surfaces, allowed_read_tools, max_calls_per_run
         FROM sigilix_mcp_policies_v2 WHERE server_id = ?`,
        serverId,
      )
      .toArray()[0]
    if (!row) return undefined
    try {
      const names = JSON.parse(row.allowed_read_tools) as unknown
      const surfaces = JSON.parse(row.surfaces) as unknown
      if (
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        !Number.isSafeInteger(row.max_calls_per_run) ||
        row.max_calls_per_run < 0 ||
        row.max_calls_per_run > 4 ||
        !Array.isArray(names) ||
        !isStoredSurfacePolicy(surfaces) ||
        names.some((name) => typeof name !== "string" || !safeToolName(name))
      ) {
        return failClosedStoredPolicy(row.version)
      }
      return {
        version: row.version,
        enabled: row.enabled === 1,
        surfaces,
        allowedReadTools: names,
        maxCallsPerRun: row.max_calls_per_run,
      }
    } catch {
      return failClosedStoredPolicy(row.version)
    }
  }

  private writeStoredPolicy(serverId: string, policy: StoredMcpPolicy): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sigilix_mcp_policies_v2
       (server_id, version, enabled, surfaces, allowed_read_tools, max_calls_per_run)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         version = excluded.version,
         enabled = excluded.enabled,
         surfaces = excluded.surfaces,
         allowed_read_tools = excluded.allowed_read_tools,
         max_calls_per_run = excluded.max_calls_per_run`,
      serverId,
      policy.version,
      policy.enabled ? 1 : 0,
      JSON.stringify(policy.surfaces),
      JSON.stringify(policy.allowedReadTools),
      policy.maxCallsPerRun,
    )
  }

  private deleteStoredPolicy(serverId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_policies_v2 WHERE server_id = ?", serverId)
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_runtime_calls_v2 WHERE server_id = ?", serverId)
  }

  private reserveRuntimeCall(runId: string, serverId: string, surface: McpRuntimeSurface, maximum: number): boolean {
    if (maximum <= 0) return false
    const now = Date.now()
    // Run ids are short-lived. Opportunistic one-day GC prevents a trusted
    // internal caller bug from growing this counter table forever.
    this.ctx.storage.sql.exec("DELETE FROM sigilix_mcp_runtime_calls_v2 WHERE updated_at < ?", now - 86_400_000)
    // SQLite-backed DO SQL is synchronous and atomically isolated inside this
    // object's private database. A conflicting concurrent request therefore
    // evaluates the WHERE guard against the committed counter and becomes a
    // no-op once the cap is reached; rowsWritten is the reservation result.
    const cursor = this.ctx.storage.sql.exec(
      `INSERT INTO sigilix_mcp_runtime_calls_v2 (run_id, server_id, surface, call_count, updated_at)
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
