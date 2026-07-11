export const MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS = 15 * 60
export const MCP_OAUTH_CALLBACK_TERMINAL_TTL_SECONDS = 5 * 60
export const MCP_OAUTH_CALLBACK_CLAIM_TTL_SECONDS = MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS
export const MCP_OAUTH_STATE_MAX_CHARS = 2_048

const ROUTE_VERSION = 2 as const
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

const ROUTE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sigilix_mcp_oauth_route_v2 (
  state_hash TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL,
  owner_scope TEXT NOT NULL,
  tenant_scope TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  stable_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  claim_id TEXT,
  claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)
`

export type McpOAuthCallbackStatus = "pending" | "processing" | "completed" | "failed"

export interface McpOAuthCallbackRoute {
  version: typeof ROUTE_VERSION
  stateHash: string
  ownerScope: string
  tenantScope: string
  grantId: string
  serverId: string
  stableSubject: string
  status: McpOAuthCallbackStatus
  claimId: string | null
  claimExpiresAt: number | null
  createdAt: number
  expiresAt: number
}

interface RouteEnv {
  MCP_CONNECTIONS: DurableObjectNamespace
}

interface RouteRow extends Record<string, string | number | null> {
  state_hash: string
  version: number
  owner_scope: string
  tenant_scope: string
  grant_id: string
  server_id: string
  stable_subject: string
  status: string
  claim_id: string | null
  claim_expires_at: number | null
  created_at: number
  expires_at: number
}

export type McpOAuthClaimResult =
  | { outcome: "claimed"; route: McpOAuthCallbackRoute }
  | { outcome: "wait"; route: McpOAuthCallbackRoute }
  | { outcome: "terminal"; route: McpOAuthCallbackRoute; expired: boolean }

export class McpOAuthCallbackRegistry {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly now: () => number = Date.now,
  ) {
    storage.sql.exec(ROUTE_SCHEMA)
  }

  create(route: McpOAuthCallbackRoute): McpOAuthCallbackRoute | null {
    if (!validRoute(route, this.now()) || route.status !== "pending" || route.claimId || route.claimExpiresAt)
      return null
    return this.storage.transactionSync(() => {
      let existing: McpOAuthCallbackRoute | null = null
      try {
        existing = this.readRaw(route.stateHash)
      } catch {
        this.storage.sql.exec("DELETE FROM sigilix_mcp_oauth_route_v2 WHERE state_hash = ?", route.stateHash)
      }
      if (existing) return sameAuthorization(existing, route) && existing.status === "pending" ? existing : null
      this.storage.sql.exec(
        `INSERT INTO sigilix_mcp_oauth_route_v2
         (state_hash, version, owner_scope, tenant_scope, grant_id, server_id, stable_subject,
          status, claim_id, claim_expires_at, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        route.stateHash,
        route.version,
        route.ownerScope,
        route.tenantScope,
        route.grantId,
        route.serverId,
        route.stableSubject,
        route.createdAt,
        route.expiresAt,
      )
      return this.readRaw(route.stateHash)
    })
  }

  readBound(stateHash: string, ownerScope: string, stableSubject: string): McpOAuthCallbackRoute | null {
    const route = this.readRaw(stateHash)
    if (!route || route.ownerScope !== ownerScope || route.stableSubject !== stableSubject) return null
    if (route.status === "completed" && route.expiresAt <= this.now()) {
      this.storage.sql.exec("DELETE FROM sigilix_mcp_oauth_route_v2 WHERE state_hash = ?", stateHash)
      return null
    }
    return route
  }

  claim(stateHash: string, ownerScope: string, stableSubject: string, claimId: string): McpOAuthClaimResult | null {
    if (!SAFE_ID_RE.test(claimId)) return null
    return this.storage.transactionSync(() => {
      const route = this.readBound(stateHash, ownerScope, stableSubject)
      if (!route) return null
      const now = this.now()
      if (route.status === "completed" || route.status === "failed") {
        return { outcome: "terminal", route, expired: false }
      }
      if (route.expiresAt <= now) {
        const failed = this.writeTerminal(route, "failed", now)
        return { outcome: "terminal", route: failed, expired: true }
      }
      if (route.status === "processing" && (route.claimExpiresAt ?? 0) > now) {
        return { outcome: "wait", route }
      }
      // A claim accepted before the pending deadline owns a fresh processing
      // lease. Extending the alarm prevents the stale-pending cleanup from
      // deleting the winning flow while its provider exchange is in flight.
      const claimExpiresAt = now + MCP_OAUTH_CALLBACK_CLAIM_TTL_SECONDS * 1_000
      this.storage.sql.exec(
        `UPDATE sigilix_mcp_oauth_route_v2
            SET status = 'processing', claim_id = ?, claim_expires_at = ?, expires_at = ?
          WHERE state_hash = ?`,
        claimId,
        claimExpiresAt,
        claimExpiresAt,
        stateHash,
      )
      return { outcome: "claimed", route: this.readRaw(stateHash)! }
    })
  }

  finalize(
    stateHash: string,
    ownerScope: string,
    stableSubject: string,
    claimId: string,
    status: "completed" | "failed",
  ): McpOAuthCallbackRoute | null {
    return this.storage.transactionSync(() => {
      const route = this.readBound(stateHash, ownerScope, stableSubject)
      if (!route) return null
      if (route.status === status) return route
      if (route.status !== "processing" || route.claimId !== claimId || (route.claimExpiresAt ?? 0) <= this.now()) {
        return null
      }
      return this.writeTerminal(route, status, this.now())
    })
  }

  expireDue(): McpOAuthCallbackRoute | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<RouteRow>(`${ROUTE_SELECT} LIMIT 1`).toArray()[0]
      if (!row) return null
      const route = mapRow(row)
      const now = this.now()
      if (route.expiresAt > now) return null
      if (route.status === "completed") {
        this.storage.sql.exec("DELETE FROM sigilix_mcp_oauth_route_v2 WHERE state_hash = ?", route.stateHash)
        return null
      }
      if (route.status === "failed") return route
      return this.writeTerminal(route, "failed", now)
    })
  }

  deleteFailed(stateHash: string): void {
    this.storage.sql.exec(
      "DELETE FROM sigilix_mcp_oauth_route_v2 WHERE state_hash = ? AND status = 'failed'",
      stateHash,
    )
  }

  deferFailedCleanup(stateHash: string, retryAt: number): void {
    if (!validTimestamp(retryAt)) return
    this.storage.sql.exec(
      `UPDATE sigilix_mcp_oauth_route_v2 SET expires_at = ?
        WHERE state_hash = ? AND status = 'failed'`,
      retryAt,
      stateHash,
    )
  }

  nextAlarm(): number | null {
    const row = this.storage.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM sigilix_mcp_oauth_route_v2 ORDER BY expires_at ASC LIMIT 1")
      .toArray()[0]
    return row?.expires_at ?? null
  }

  private writeTerminal(
    route: McpOAuthCallbackRoute,
    status: "completed" | "failed",
    now: number,
  ): McpOAuthCallbackRoute {
    const expiresAt = now + MCP_OAUTH_CALLBACK_TERMINAL_TTL_SECONDS * 1_000
    this.storage.sql.exec(
      `UPDATE sigilix_mcp_oauth_route_v2
          SET status = ?, claim_id = NULL, claim_expires_at = NULL, expires_at = ?
        WHERE state_hash = ?`,
      status,
      expiresAt,
      route.stateHash,
    )
    return this.readRaw(route.stateHash)!
  }

  private readRaw(stateHash: string): McpOAuthCallbackRoute | null {
    const row = this.storage.sql.exec<RouteRow>(`${ROUTE_SELECT} WHERE state_hash = ?`, stateHash).toArray()[0]
    if (!row) return null
    const route = mapRow(row)
    if (!validRoute(route, this.now(), true)) throw new TypeError("invalid callback route")
    return route
  }
}

const ROUTE_SELECT = `SELECT state_hash, version, owner_scope, tenant_scope, grant_id, server_id,
  stable_subject, status, claim_id, claim_expires_at, created_at, expires_at
  FROM sigilix_mcp_oauth_route_v2`

export async function hashMcpOAuthState(rawState: string): Promise<string | null> {
  if (
    rawState.length === 0 ||
    rawState.length > MCP_OAUTH_STATE_MAX_CHARS ||
    rawState.trim() !== rawState ||
    /[\u0000-\u001f\u007f]/.test(rawState)
  ) {
    return null
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawState))
  return base64urlEncode(new Uint8Array(digest))
}

export async function mcpOAuthStateHashFromUrl(rawUrl: string | URL): Promise<string | null> {
  try {
    const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl)
    const states = url.searchParams.getAll("state")
    return states.length === 1 && typeof states[0] === "string" ? hashMcpOAuthState(states[0]) : null
  } catch {
    return null
  }
}

export async function putMcpOAuthCallbackRoute(args: {
  env: RouteEnv
  authUrl: string | URL
  ownerScope: string
  tenantScope: string
  grantId: string
  serverId: string
  stableSubject: string
  nowMs?: number
}): Promise<McpOAuthCallbackRoute | null> {
  const stateHash = await mcpOAuthStateHashFromUrl(args.authUrl)
  const now = args.nowMs ?? Date.now()
  if (!stateHash || !validTimestamp(now)) return null
  const route: McpOAuthCallbackRoute = {
    version: ROUTE_VERSION,
    stateHash,
    ownerScope: args.ownerScope,
    tenantScope: args.tenantScope,
    grantId: args.grantId,
    serverId: args.serverId,
    stableSubject: args.stableSubject,
    status: "pending",
    claimId: null,
    claimExpiresAt: null,
    createdAt: now,
    expiresAt: now + MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS * 1_000,
  }
  const response = await callbackStub(args.env, stateHash).fetch("https://mcp-connections.do/oauth-route/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(route),
  })
  if (!response.ok) return null
  return readRouteResponse(response)
}

export async function readMcpOAuthCallbackRoute(args: {
  env: RouteEnv
  callbackUrl: string | URL
  ownerScope: string
  stableSubject: string
  expectedStatus?: McpOAuthCallbackStatus
}): Promise<McpOAuthCallbackRoute | null> {
  const stateHash = await mcpOAuthStateHashFromUrl(args.callbackUrl)
  if (!stateHash) return null
  const response = await routeRequest(args.env, stateHash, "read", args.ownerScope, args.stableSubject)
  const route = response.ok ? await readRouteResponse(response) : null
  return route && (!args.expectedStatus || route.status === args.expectedStatus) ? route : null
}

export async function claimMcpOAuthCallbackRoute(args: {
  env: RouteEnv
  callbackUrl: string | URL
  ownerScope: string
  stableSubject: string
}): Promise<McpOAuthClaimResult | null> {
  const stateHash = await mcpOAuthStateHashFromUrl(args.callbackUrl)
  if (!stateHash) return null
  const response = await routeRequest(args.env, stateHash, "claim", args.ownerScope, args.stableSubject, {
    claimId: crypto.randomUUID(),
  })
  if (!response.ok) return null
  const value = (await response.json()) as McpOAuthClaimResult
  return value && ["claimed", "wait", "terminal"].includes(value.outcome) ? value : null
}

export async function updateMcpOAuthCallbackRoute(args: {
  env: RouteEnv
  callbackUrl: string | URL
  expected: McpOAuthCallbackRoute
  status: "completed" | "failed"
}): Promise<McpOAuthCallbackRoute | null> {
  const stateHash = await mcpOAuthStateHashFromUrl(args.callbackUrl)
  if (!stateHash || stateHash !== args.expected.stateHash || !args.expected.claimId) return null
  const response = await routeRequest(
    args.env,
    stateHash,
    "finalize",
    args.expected.ownerScope,
    args.expected.stableSubject,
    { claimId: args.expected.claimId, status: args.status },
  )
  return response.ok ? readRouteResponse(response) : null
}

async function routeRequest(
  env: RouteEnv,
  stateHash: string,
  action: "read" | "claim" | "finalize",
  ownerScope: string,
  stableSubject: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return callbackStub(env, stateHash).fetch(`https://mcp-connections.do/oauth-route/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stateHash, ownerScope, stableSubject, ...extra }),
  })
}

function callbackStub(env: RouteEnv, stateHash: string): DurableObjectStub {
  return env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(`oauth-route:${stateHash}`))
}

async function readRouteResponse(response: Response): Promise<McpOAuthCallbackRoute | null> {
  try {
    const value = (await response.json()) as { route?: unknown } | McpOAuthCallbackRoute
    const route = "route" in value ? value.route : value
    return validRoute(route, Date.now(), true) ? route : null
  } catch {
    return null
  }
}

function mapRow(row: RouteRow): McpOAuthCallbackRoute {
  return {
    version: row.version as typeof ROUTE_VERSION,
    stateHash: row.state_hash,
    ownerScope: row.owner_scope,
    tenantScope: row.tenant_scope,
    grantId: row.grant_id,
    serverId: row.server_id,
    stableSubject: row.stable_subject,
    status: row.status as McpOAuthCallbackStatus,
    claimId: row.claim_id,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function validRoute(value: unknown, now: number, allowExpired = false): value is McpOAuthCallbackRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const route = value as McpOAuthCallbackRoute
  if (
    route.version !== ROUTE_VERSION ||
    !/^[A-Za-z0-9_-]{43}$/.test(route.stateHash) ||
    !isSessionScope(route.ownerScope) ||
    !isTenantScope(route.tenantScope) ||
    !SAFE_ID_RE.test(route.grantId) ||
    !SAFE_ID_RE.test(route.serverId) ||
    !SAFE_ID_RE.test(route.stableSubject) ||
    !["pending", "processing", "completed", "failed"].includes(route.status) ||
    !validTimestamp(route.createdAt) ||
    !validTimestamp(route.expiresAt) ||
    route.createdAt > now ||
    route.expiresAt <= route.createdAt ||
    (route.status === "pending" &&
      route.expiresAt - route.createdAt > MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS * 1_000) ||
    (route.status === "processing" &&
      route.expiresAt - route.createdAt >
        (MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS + MCP_OAUTH_CALLBACK_CLAIM_TTL_SECONDS) * 1_000) ||
    (!allowExpired && route.expiresAt <= now)
  ) {
    return false
  }
  if (route.status === "processing") {
    return typeof route.claimId === "string" && SAFE_ID_RE.test(route.claimId) && validTimestamp(route.claimExpiresAt)
  }
  return route.claimId === null && route.claimExpiresAt === null
}

function sameAuthorization(left: McpOAuthCallbackRoute, right: McpOAuthCallbackRoute): boolean {
  return (
    left.stateHash === right.stateHash &&
    left.ownerScope === right.ownerScope &&
    left.tenantScope === right.tenantScope &&
    left.grantId === right.grantId &&
    left.serverId === right.serverId &&
    left.stableSubject === right.stableSubject
  )
}

function isSessionScope(value: string): boolean {
  return value.startsWith("session:") && SAFE_ID_RE.test(value.slice("session:".length))
}

function isTenantScope(value: string): boolean {
  if (!/^tenant:[1-9]\d*$/.test(value)) return false
  return Number.isSafeInteger(Number(value.slice("tenant:".length)))
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
