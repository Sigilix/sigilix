/**
 * Installation-scoped MCP management and hosted CLI runtime routes.
 *
 * Portal sessions authorize an MCP server from their private, user-scoped DO,
 * while a tenant-scoped broker DO owns the revocable grant exposed to the
 * organization. OAuth tokens never move into the tenant DO. Hosted runtimes
 * can only reach the broker with an installation-bound API key.
 */

import { guardUrl } from "@/src/do/deep-research/fetch-guard"
import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { handlePortalPreflight, hasJsonContentType, withPortalCors } from "@/src/lib/portal-cors"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { requireRuntimePrincipal, runtimeSessionScope, runtimeSessionSubject } from "@/src/lib/runtime-principal"
import {
  parseLeadingRuntimeAppMention,
  publicRuntimeAppCatalog,
  resolveRuntimeApp,
  runtimeAppRouteError,
} from "@/src/shared/domain/runtime-app-registry"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const DO_BASE = "https://mcp-connections.do"
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"
const MAX_BODY_BYTES = 16 * 1024
const MAX_URL_CHARS = 2_048
const MAX_NAME_CHARS = 128
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const CREATE_FIELDS = new Set(["url", "name"])

export interface McpOrgAdminContext {
  session: AuthedSession
  ownerScope: string
  tenantScope: string
  stableSubject: string
  creatorSubject: string
}

export type McpOrgAdminAuth = { ok: true; value: McpOrgAdminContext } | { ok: false; response: Response }

type ConnectResult =
  | { status: "connected"; id: string; toolCount: number }
  | { status: "auth_required"; id: string; authUrl: string }
  | { status: "error"; error: string; existingId?: string }

interface OrgMcpMatch {
  installationId: number
  grantId?: string
  policy: boolean
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function resolveStub(env: Env, scope: string): DurableObjectStub {
  return env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(scope))
}

function parseOrgMcpPath(pathname: string): OrgMcpMatch | "invalid" | null {
  const match = /^\/v1\/org\/([^/]+)\/mcp\/servers(?:\/([^/]+)(\/policy)?)?$/.exec(pathname)
  if (!match?.[1]) return null
  let installationToken: string
  let grantToken: string | undefined
  try {
    installationToken = decodeURIComponent(match[1])
    grantToken = match[2] === undefined ? undefined : decodeURIComponent(match[2])
  } catch {
    return "invalid"
  }
  if (!/^\d+$/.test(installationToken)) return "invalid"
  const installationId = Number(installationToken)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return "invalid"
  if (grantToken !== undefined && !SAFE_ID_RE.test(grantToken)) return "invalid"
  return { installationId, ...(grantToken ? { grantId: grantToken } : {}), policy: match[3] === "/policy" }
}

function identityForSession(session: AuthedSession): Omit<McpOrgAdminContext, "session" | "tenantScope"> | null {
  const ownerScope = runtimeSessionScope(session.record)
  const stableSubject = runtimeSessionSubject(session.record)
  if (!ownerScope || !stableSubject) return null
  const userId = session.record.userId?.trim()
  if (userId && SAFE_ID_RE.test(userId)) {
    return { ownerScope, stableSubject, creatorSubject: `user:${userId}` }
  }
  const githubUserId = session.record.githubUserId
  if (!Number.isSafeInteger(githubUserId) || (githubUserId ?? 0) <= 0) return null
  const subject = String(githubUserId)
  return { ownerScope, stableSubject, creatorSubject: `github:${subject}` }
}

export async function authenticateMcpOrgAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
): Promise<McpOrgAdminAuth> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  const identity = identityForSession(session)
  if (!identity) return { ok: false, response: json({ error: "stable_identity_required" }, 401) }
  const encryptionKey = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!encryptionKey) return { ok: false, response: json({ error: "misconfigured" }, 503) }

  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: encryptionKey,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org-mcp-github-token-failed",
        installationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "mcp_auth_failed" }, 500) }
  }
  if (!(await isAdminOfInstallation(accessToken, session.record.login, installationId))) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  return {
    ok: true,
    value: { session, ...identity, tenantScope: `tenant:${installationId}` },
  }
}

async function readJsonObject(
  request: Request,
  maximum = MAX_BODY_BYTES,
): Promise<{ ok: true; raw: string; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const raw = await readBodyCapped(request, maximum)
  if (raw === null) return { ok: false, response: json({ error: "payload_too_large" }, 413) }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isPlainObject(value)) return { ok: false, response: json({ error: "invalid json" }, 400) }
    return { ok: true, raw, value }
  } catch {
    return { ok: false, response: json({ error: "invalid json" }, 400) }
  }
}

function validateCreateBody(
  value: Record<string, unknown>,
): { ok: true; url: string; name?: string } | { ok: false; response: Response } {
  if (Object.keys(value).some((key) => !CREATE_FIELDS.has(key))) {
    return { ok: false, response: json({ error: "invalid request" }, 400) }
  }
  const rawUrl = typeof value.url === "string" ? value.url.trim() : ""
  if (!rawUrl || rawUrl.length > MAX_URL_CHARS) return { ok: false, response: json({ error: "invalid url" }, 400) }
  if (value.name !== undefined && typeof value.name !== "string") {
    return { ok: false, response: json({ error: "invalid name" }, 400) }
  }
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name.length > MAX_NAME_CHARS) return { ok: false, response: json({ error: "invalid name" }, 400) }

  const guarded = guardUrl(rawUrl)
  if (!guarded.ok) return { ok: false, response: json({ error: `url not allowed: ${guarded.reason}` }, 400) }
  if (guarded.url.protocol !== "https:") {
    return { ok: false, response: json({ error: "url not allowed: https-required" }, 400) }
  }
  if (guarded.url.username || guarded.url.password) {
    return { ok: false, response: json({ error: "url not allowed: embedded-credentials" }, 400) }
  }
  if (guarded.url.search || guarded.url.hash) {
    return { ok: false, response: json({ error: "url not allowed: query-or-fragment-not-allowed" }, 400) }
  }
  return { ok: true, url: guarded.url.toString(), ...(name ? { name } : {}) }
}

function safeUpstreamStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502
}

async function parseDoJson(response: Response): Promise<unknown | null> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

async function failGrantAndCleanup(
  tenantStub: DurableObjectStub,
  ownerStub: DurableObjectStub,
  grantId: string,
  serverId: string,
): Promise<void> {
  const outcomes = await Promise.all([
    failOrRevokeGrant(tenantStub, grantId),
    retryCleanup(ownerStub, `${DO_BASE}/servers/${encodeURIComponent(serverId)}`, "DELETE", true),
  ])
  if (outcomes.some((ok) => !ok)) {
    console.error(JSON.stringify({ event: "org-mcp-connect-cleanup-incomplete", grantId }))
  }
}

async function failOrRevokeGrant(tenantStub: DurableObjectStub, grantId: string): Promise<boolean> {
  const failUrl = `${DO_BASE}/grants/${encodeURIComponent(grantId)}/fail`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await tenantStub.fetch(failUrl, { method: "POST" })
      if (!response.ok) continue
      const value = await parseDoJson(response)
      const grant = isPlainObject(value) && isPlainObject(value.grant) ? value.grant : null
      if (grant?.status === "failed" || grant?.status === "revoked") return true
      // `/activate` may have committed even if its response was lost. The
      // registry deliberately will not downgrade active → failed, so an active
      // or ambiguous success must take the terminal revoke path instead.
      if (grant?.status === "active") return revokeGrant(tenantStub, grantId)
    } catch {
      // Retry once, then revoke because the grant's state is uncertain.
    }
  }
  return revokeGrant(tenantStub, grantId)
}

function revokeGrant(tenantStub: DurableObjectStub, grantId: string): Promise<boolean> {
  return retryCleanup(tenantStub, `${DO_BASE}/broker/servers/${encodeURIComponent(grantId)}`, "DELETE", true)
}

async function retryCleanup(
  stub: DurableObjectStub,
  url: string,
  method: "POST" | "DELETE",
  acceptNotFound: boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stub.fetch(url, { method })
      if (response.ok || (acceptNotFound && response.status === 404)) return true
    } catch {
      // One immediate idempotent retry handles a transient DO wake/network fault.
    }
  }
  return false
}

async function handleCreate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const create = validateCreateBody(parsed.value)
  if (!create.ok) return create.response
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  const tenantStub = resolveStub(env, auth.value.tenantScope)
  const ownerStub = resolveStub(env, auth.value.ownerScope)
  const grantId = crypto.randomUUID()
  const serverId = crypto.randomUUID()
  let grantResponse: Response
  try {
    grantResponse = await tenantStub.fetch(`${DO_BASE}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId,
        ownerScope: auth.value.ownerScope,
        serverId,
        creatorSubject: auth.value.creatorSubject,
        serverUrl: create.url,
      }),
    })
  } catch (error) {
    console.error("org-mcp: grant create failed", error instanceof Error ? error.message : error)
    return json({ error: "failed to create MCP grant" }, 502)
  }
  if (!grantResponse.ok) return json({ error: "failed to create MCP grant" }, safeUpstreamStatus(grantResponse.status))

  let connectResponse: Response
  try {
    connectResponse = await ownerStub.fetch(`${DO_BASE}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId,
        url: create.url,
        ...(create.name ? { name: create.name } : {}),
        callbackUrl: trustedOAuthCallbackUrl(env),
        allowOAuth: true,
        grant: {
          grantId,
          ownerScope: auth.value.ownerScope,
          tenantScope: auth.value.tenantScope,
          stableSubject: auth.value.stableSubject,
        },
      }),
    })
  } catch (error) {
    console.error("org-mcp: owner connect failed", error instanceof Error ? error.message : error)
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to connect" }, 502)
  }
  const connect = (await parseDoJson(connectResponse)) as ConnectResult | null
  if (!connect || connect.status === "error" || !connectResponse.ok) {
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to connect" }, safeUpstreamStatus(connectResponse.status))
  }
  if (connect.id !== serverId) {
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to connect" }, 502)
  }
  if (connect.status === "auth_required") {
    const authUrl = typeof connect.authUrl === "string" ? guardUrl(connect.authUrl) : null
    if (!authUrl || !authUrl.ok || authUrl.url.protocol !== "https:" || authUrl.url.username || authUrl.url.password) {
      await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
      return json({ error: "failed to connect" }, 502)
    }
    return json({ status: "auth_required", id: grantId, authUrl: authUrl.url.toString() })
  }
  if (!Number.isSafeInteger(connect.toolCount) || connect.toolCount < 0) {
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to connect" }, 502)
  }
  let activation: Response
  try {
    activation = await tenantStub.fetch(`${DO_BASE}/grants/${encodeURIComponent(grantId)}/activate`, {
      method: "POST",
    })
  } catch (error) {
    console.error("org-mcp: grant activation failed", error instanceof Error ? error.message : error)
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to activate MCP grant" }, 502)
  }
  const activated = await parseDoJson(activation)
  const activeGrant = isPlainObject(activated) && isPlainObject(activated.grant) ? activated.grant : null
  if (
    !activation.ok ||
    !activeGrant ||
    activeGrant.status !== "active" ||
    activeGrant.grantId !== grantId ||
    activeGrant.serverId !== serverId ||
    activeGrant.ownerScope !== auth.value.ownerScope
  ) {
    await failGrantAndCleanup(tenantStub, ownerStub, grantId, serverId)
    return json({ error: "failed to activate MCP grant" }, 502)
  }
  return json({ status: "connected", id: grantId, toolCount: connect.toolCount })
}

async function proxyBrokerResponse(response: Response, publicId?: string): Promise<Response> {
  const body = await parseDoJson(response)
  if (body === null) return json({ error: "MCP broker failed" }, 502)
  const sanitized = publicBrokerEnvelope(body, publicId)
  if (!sanitized.ok) return json({ error: "MCP broker failed" }, response.ok ? 502 : response.status)
  return json(sanitized.value, response.status)
}

function publicBrokerEnvelope(
  value: unknown,
  forcedId?: string,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false }
  if (Array.isArray(value.servers)) {
    const servers = value.servers.flatMap((candidate) => {
      const server = publicServer(candidate)
      return server ? [server] : []
    })
    return { ok: true, value: { servers, ...(typeof value.partial === "boolean" ? { partial: value.partial } : {}) } }
  }
  if (isPlainObject(value.server)) {
    const server = publicServer(value.server, forcedId)
    if (!server) return { ok: false }
    return {
      ok: true,
      value: {
        server,
        ...(isPlainObject(value.policy) ? { policy: publicPolicy(value.policy) } : {}),
        ...(Array.isArray(value.tools) ? { tools: value.tools.flatMap(publicTool) } : {}),
        ...(Number.isSafeInteger(value.blockedToolCount) && (value.blockedToolCount as number) >= 0
          ? { blockedToolCount: value.blockedToolCount }
          : {}),
        ...(typeof value.dataSensitivity === "string" && value.dataSensitivity.length <= 128
          ? { dataSensitivity: value.dataSensitivity }
          : {}),
      },
    }
  }
  const error = typeof value.error === "string" && /^[A-Za-z0-9 _-]{1,128}$/.test(value.error) ? value.error : null
  return error ? { ok: true, value: { error } } : { ok: false }
}

function publicServer(value: unknown, forcedId?: string): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  const candidateId = forcedId ?? value.grantId ?? value.id
  if (typeof candidateId !== "string" || !SAFE_ID_RE.test(candidateId)) return null
  const out: Record<string, unknown> = { id: candidateId }
  for (const key of ["name", "url", "status", "vendorId", "grantStatus"] as const) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length <= MAX_URL_CHARS) {
      out[key] = key === "url" ? redactPublicUrl(candidate) : candidate
    }
  }
  return out
}

function trustedOAuthCallbackUrl(env: Env): string {
  const configured = env.OPENCLAW_BASE_URL ?? "https://api.sigilix.ai"
  try {
    const url = new URL(configured)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid")
    return `${url.origin}${OAUTH_CALLBACK_PATH}`
  } catch {
    return `https://api.sigilix.ai${OAUTH_CALLBACK_PATH}`
  }
}

function redactPublicUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}

function publicPolicy(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (Number.isSafeInteger(value.version) && (value.version as number) >= 0) out.version = value.version
  if (typeof value.enabled === "boolean") out.enabled = value.enabled
  if (typeof value.readOnly === "boolean") out.readOnly = value.readOnly
  if (Number.isSafeInteger(value.maxCallsPerRun) && (value.maxCallsPerRun as number) >= 0) {
    out.maxCallsPerRun = value.maxCallsPerRun
  }
  if (Array.isArray(value.allowedReadTools)) {
    out.allowedReadTools = value.allowedReadTools.filter(
      (tool): tool is string => typeof tool === "string" && SAFE_ID_RE.test(tool),
    )
  }
  if (isPlainObject(value.surfaces)) {
    const surfaces: Record<string, boolean> = {}
    for (const key of ["chat", "deepResearch", "deep-research", "cli", "pr-review", "agent", "memory-index"] as const) {
      if (typeof value.surfaces[key] === "boolean") surfaces[key] = value.surfaces[key]
    }
    out.surfaces = surfaces
  }
  return out
}

function publicTool(value: unknown): Record<string, unknown>[] {
  if (!isPlainObject(value)) return []
  const out: Record<string, unknown> = {}
  for (const key of ["id", "name"] as const) {
    if (typeof value[key] === "string" && SAFE_ID_RE.test(value[key])) out[key] = value[key]
  }
  if (typeof value.description === "string" && value.description.length <= 2_048) out.description = value.description
  if (typeof value.allowedByCatalog === "boolean") out.allowedByCatalog = value.allowedByCatalog
  if (typeof value.enabled === "boolean") out.enabled = value.enabled
  return typeof out.id === "string" && typeof out.name === "string" ? [out] : []
}

async function handleList(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
): Promise<Response> {
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  try {
    return proxyBrokerResponse(await resolveStub(env, auth.value.tenantScope).fetch(`${DO_BASE}/broker/list`))
  } catch (error) {
    console.error("org-mcp: broker list failed", error instanceof Error ? error.message : error)
    return json({ error: "MCP broker failed" }, 502)
  }
}

async function handlePolicy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  grantId: string,
): Promise<Response> {
  let raw: string | undefined
  if (request.method === "PUT") {
    if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
    const parsed = await readJsonObject(request)
    if (!parsed.ok) return parsed.response
    raw = parsed.raw
  }
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  try {
    const response = await resolveStub(env, auth.value.tenantScope).fetch(
      `${DO_BASE}/broker/servers/${encodeURIComponent(grantId)}/policy`,
      request.method === "PUT"
        ? { method: "PUT", headers: { "content-type": "application/json" }, body: raw ?? "" }
        : { method: "GET" },
    )
    return proxyBrokerResponse(response, grantId)
  } catch (error) {
    console.error("org-mcp: broker policy failed", error instanceof Error ? error.message : error)
    return json({ error: "MCP broker failed" }, 502)
  }
}

async function handleDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  grantId: string,
): Promise<Response> {
  const auth = await authenticateMcpOrgAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  const tenantStub = resolveStub(env, auth.value.tenantScope)
  let response: Response
  try {
    response = await tenantStub.fetch(`${DO_BASE}/broker/servers/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    })
  } catch (error) {
    console.error("org-mcp: broker revoke failed", error instanceof Error ? error.message : error)
    return json({ error: "failed to revoke MCP grant" }, 502)
  }
  const result = await parseDoJson(response)
  if (!response.ok) {
    return json({ error: response.status === 404 ? "not found" : "failed to revoke MCP grant" }, response.status)
  }
  if (!isPlainObject(result)) return json({ error: "MCP broker failed" }, 502)
  const internal = isPlainObject(result.grant) ? result.grant : result
  if (
    internal.ownerScope === auth.value.ownerScope &&
    typeof internal.serverId === "string" &&
    SAFE_ID_RE.test(internal.serverId)
  ) {
    try {
      const cleanup = await resolveStub(env, auth.value.ownerScope).fetch(
        `${DO_BASE}/servers/${encodeURIComponent(internal.serverId)}`,
        { method: "DELETE" },
      )
      if (!cleanup.ok && cleanup.status !== 404) return json({ error: "credential cleanup failed" }, 502)
    } catch (error) {
      console.error("org-mcp: owner credential cleanup failed", error instanceof Error ? error.message : error)
      return json({ error: "credential cleanup failed" }, 502)
    }
  }
  return json({ ok: true })
}

async function handleRuntime(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth.response
  if (auth.principal.kind !== "tenant") return json({ error: "tenant_scope_required" }, 403)
  if (parsed.value.surface !== "cli") return json({ error: "surface_not_allowed" }, 403)
  const forwarded =
    path === "catalog"
      ? { surface: "cli", ...(parsed.value.appId === undefined ? {} : { appId: parsed.value.appId }) }
      : {
          surface: "cli",
          serverId: parsed.value.serverId,
          toolName: parsed.value.toolName,
          runId: parsed.value.runId,
          arguments: parsed.value.arguments,
          ...(parsed.value.appId === undefined ? {} : { appId: parsed.value.appId }),
        }
  try {
    const response = await resolveStub(env, auth.principal.scope).fetch(`${DO_BASE}/broker/runtime/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
    })
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    })
  } catch (error) {
    console.error("org-mcp: runtime broker failed", error instanceof Error ? error.message : error)
    return json({ error: "MCP runtime failed" }, 502)
  }
}

async function handleAppResolve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth.response
  if (auth.principal.kind !== "tenant") return json({ error: "tenant_scope_required" }, 403)
  if (typeof parsed.value.text !== "string") return json({ error: "invalid_request" }, 400)
  const route = parseLeadingRuntimeAppMention(parsed.value.text)
  if (route.kind === "rejected") {
    return json({ ...runtimeAppRouteError(route.reason), mention: route.mention }, 400)
  }
  if (route.kind === "resolved") {
    const app = resolveRuntimeApp(route.appId)
    return json({ version: 1, route: { ...route, mention: app?.canonicalMention ?? route.mention } })
  }
  return json({ version: 1, route })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Route dispatcher wired by the Worker entry point. */
export async function tryHandleOrgMcpRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/v1/apps/catalog") {
    return withPortalCors(request, json(publicRuntimeAppCatalog()), env)
  }
  if (request.method === "POST" && url.pathname === "/v1/apps/resolve") {
    return handleAppResolve(request, env, ctx)
  }
  const orgMatch = parseOrgMcpPath(url.pathname)
  if (request.method === "OPTIONS" && orgMatch !== null) return handlePortalPreflight(request, env)
  if (orgMatch === "invalid")
    return withPortalCors(request, json({ error: "invalid installation or grant id" }, 400), env)
  if (orgMatch) {
    let response: Response | null = null
    if (!orgMatch.grantId && !orgMatch.policy && request.method === "POST") {
      response = await handleCreate(request, env, ctx, orgMatch.installationId)
    } else if (!orgMatch.grantId && !orgMatch.policy && request.method === "GET") {
      response = await handleList(request, env, ctx, orgMatch.installationId)
    } else if (orgMatch.grantId && orgMatch.policy && (request.method === "GET" || request.method === "PUT")) {
      response = await handlePolicy(request, env, ctx, orgMatch.installationId, orgMatch.grantId)
    } else if (orgMatch.grantId && !orgMatch.policy && request.method === "DELETE") {
      response = await handleDelete(request, env, ctx, orgMatch.installationId, orgMatch.grantId)
    }
    return response ? withPortalCors(request, response, env) : null
  }
  if (request.method === "POST" && url.pathname === "/v1/mcp/runtime/catalog") {
    return handleRuntime(request, env, ctx, "catalog")
  }
  if (request.method === "POST" && url.pathname === "/v1/mcp/runtime/invoke") {
    return handleRuntime(request, env, ctx, "invoke")
  }
  return null
}
