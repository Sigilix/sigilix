import { sanitizeMcpInputSchema } from "./runtime-data"
import type { McpOAuthCallbackRoute } from "./oauth-callback-routing"
import {
  curatedReadToolForVendor,
  intersectMcpPolicies,
  type EffectiveMcpPolicy,
  type McpSurfacePolicy,
  type StoredMcpPolicy,
} from "./runtime-policy"
import { type TenantMcpGrant, TenantMcpGrantRegistry } from "./tenant-mcp-grant-registry"

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

const MCP_POLICY_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS sigilix_mcp_policies_v2 (
    server_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    surfaces TEXT NOT NULL,
    allowed_read_tools TEXT NOT NULL,
    max_calls_per_run INTEGER NOT NULL CHECK (max_calls_per_run >= 0 AND max_calls_per_run <= 4)
  )
`

const MCP_RUNTIME_CALLS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS sigilix_mcp_runtime_calls_v2 (
    run_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('chat', 'deep-research', 'cli', 'pr-review', 'agent')),
    call_count INTEGER NOT NULL CHECK (call_count > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, server_id, surface)
  );
  CREATE INDEX IF NOT EXISTS sigilix_mcp_runtime_calls_v2_updated_at
    ON sigilix_mcp_runtime_calls_v2(updated_at)
`

const MCP_OAUTH_COMPLETION_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS sigilix_mcp_oauth_completions (
    state_hash TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    tenant_scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'token_stored', 'completed', 'failed')),
    auth_error TEXT,
    updated_at INTEGER NOT NULL
  )
`

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
    surfaces: McpSurfacePolicy
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

export interface ConnectGrantContext {
  grantId: string
  ownerScope: string
  tenantScope: string
  stableSubject: string
}

export const JSON_HEADERS = { "content-type": "application/json" } as const
export type McpOAuthCompletionStatus = "processing" | "token_stored" | "completed" | "failed"

const MCP_OAUTH_PROCESSING_LEASE_MS = 15 * 60 * 1_000

export function ensureMcpConnectionsSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(MCP_SERVERS_TABLE_DDL)
  storage.sql.exec(MCP_POLICY_TABLE_DDL)
  storage.sql.exec(MCP_RUNTIME_CALLS_TABLE_DDL)
  storage.sql.exec(MCP_OAUTH_COMPLETION_TABLE_DDL)
  migrateLegacyMcpState(storage)
}

export function readMcpOAuthCompletion(
  storage: DurableObjectStorage,
  stateHash: string,
): { status: McpOAuthCompletionStatus } | null {
  return (
    storage.sql
      .exec<{
        status: McpOAuthCompletionStatus
      }>("SELECT status FROM sigilix_mcp_oauth_completions WHERE state_hash = ?", stateHash)
      .toArray()[0] ?? null
  )
}

export function writeMcpOAuthCompletion(
  storage: DurableObjectStorage,
  route: McpOAuthCallbackRoute,
  status: McpOAuthCompletionStatus,
  authError?: string,
): void {
  storage.sql.exec(
    `INSERT INTO sigilix_mcp_oauth_completions
       (state_hash, server_id, grant_id, tenant_scope, status, auth_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(state_hash) DO UPDATE SET
       status = excluded.status,
       auth_error = excluded.auth_error,
       updated_at = excluded.updated_at`,
    route.stateHash,
    route.serverId,
    route.grantId,
    route.tenantScope,
    status,
    authError ?? null,
    Date.now(),
  )
}

/** Atomically admits one owner-DO SDK exchange. A callback retry can reuse the
 * route claim, but cannot start a second single-use authorization-code exchange
 * while the first owner request is still processing. */
export function claimMcpOAuthProcessing(storage: DurableObjectStorage, route: McpOAuthCallbackRoute): boolean {
  return storage.transactionSync(() => {
    const current = storage.sql
      .exec<{
        server_id: string
        grant_id: string
        tenant_scope: string
        status: McpOAuthCompletionStatus
        updated_at: number
      }>(
        `SELECT server_id, grant_id, tenant_scope, status, updated_at
           FROM sigilix_mcp_oauth_completions WHERE state_hash = ?`,
        route.stateHash,
      )
      .toArray()[0]
    const now = Date.now()
    if (current) {
      if (
        current.server_id !== route.serverId ||
        current.grant_id !== route.grantId ||
        current.tenant_scope !== route.tenantScope ||
        current.status !== "processing" ||
        now - current.updated_at < MCP_OAUTH_PROCESSING_LEASE_MS
      ) {
        return false
      }
      storage.sql.exec(
        "UPDATE sigilix_mcp_oauth_completions SET updated_at = ? WHERE state_hash = ? AND status = 'processing'",
        now,
        route.stateHash,
      )
      return true
    }
    writeMcpOAuthCompletion(storage, route, "processing")
    return true
  })
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

export function connectJson(body: unknown, status = 200): Response {
  return json(body, status)
}

export function remoteTool(value: unknown): { name: string; inputSchema: unknown } | null {
  if (!isPlainObject(value) || typeof value.name !== "string") return null
  return { name: value.name, inputSchema: value.inputSchema }
}

export function safeToolName(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

export function safeRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

export function parseSafeId(value: unknown): string | null {
  return typeof value === "string" && safeRuntimeId(value) ? value : null
}

export function parseConnectGrantContext(value: unknown): ConnectGrantContext | null {
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (
    keys.length !== 4 ||
    keys.some((key) => !["grantId", "ownerScope", "tenantScope", "stableSubject"].includes(key))
  ) {
    return null
  }
  const grantId = parseSafeId(value.grantId)
  const stableSubject = parseSafeId(value.stableSubject)
  const ownerScope = typeof value.ownerScope === "string" ? value.ownerScope : ""
  const tenantScope = typeof value.tenantScope === "string" ? value.tenantScope : ""
  if (!grantId || !stableSubject || !isSessionOwnerScope(ownerScope) || !isTenantScope(tenantScope)) return null
  return { grantId, ownerScope, tenantScope, stableSubject }
}

export function isSessionOwnerScope(value: string): boolean {
  return value.startsWith("session:") && safeRuntimeId(value.slice("session:".length))
}

export function safeActiveGrant(registry: TenantMcpGrantRegistry, grantId: string): TenantMcpGrant | null {
  const parsed = parseSafeId(grantId)
  if (!parsed) return null
  try {
    return registry.getActive(parsed)
  } catch {
    return null
  }
}

export function brokerDescriptor(value: unknown, grant: TenantMcpGrant): McpRuntimeToolDescriptor | null {
  if (!isPlainObject(value) || value.serverId !== grant.serverId) return null
  const vendor = typeof value.vendor === "string" ? value.vendor : ""
  const name = typeof value.name === "string" ? value.name : ""
  const curated = curatedReadToolForVendor(vendor, name)
  const inputSchema = sanitizeMcpInputSchema(value.inputSchema)
  if (!curated || !inputSchema) return null
  return { serverId: grant.grantId, vendor, name, description: curated.description, inputSchema }
}

export function effectiveBrokerPolicy(grant: TenantMcpGrant, owner: McpPolicyEnvelope): EffectiveMcpPolicy {
  const ownerStored: StoredMcpPolicy = {
    version: owner.policy.version,
    enabled: owner.policy.enabled,
    surfaces: owner.policy.surfaces,
    allowedReadTools: owner.policy.allowedReadTools,
    maxCallsPerRun: owner.policy.maxCallsPerRun,
  }
  return intersectMcpPolicies(grant.serverUrl, ownerStored, grant.policy)
}

export function brokerPolicyEnvelope(grant: TenantMcpGrant, owner: McpPolicyEnvelope): McpPolicyEnvelope {
  const effective = effectiveBrokerPolicy(grant, owner)
  const tools = owner.tools.map((tool) => ({
    ...tool,
    enabled: effective.enabled && effective.allowedReadTools.includes(tool.name),
  }))
  return {
    ...owner,
    server: { ...owner.server, id: grant.grantId, url: redactMcpUrl(owner.server.url) },
    policy: {
      version: grant.policy.version,
      enabled: grant.policy.enabled,
      readOnly: true,
      surfaces: grant.policy.surfaces,
      allowedReadTools: grant.policy.allowedReadTools,
      maxCallsPerRun: grant.policy.maxCallsPerRun,
    },
    tools,
    blockedToolCount: tools.filter((tool) => !tool.enabled).length,
  }
}

export function redactMcpUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}

export function isPolicyEnvelope(value: unknown): value is McpPolicyEnvelope {
  if (!isPlainObject(value) || !isPlainObject(value.server) || !isPlainObject(value.policy)) return false
  return (
    typeof value.server.id === "string" &&
    typeof value.server.name === "string" &&
    typeof value.server.url === "string" &&
    typeof value.server.status === "string" &&
    typeof value.server.vendorId === "string" &&
    typeof value.policy.version === "number" &&
    typeof value.policy.enabled === "boolean" &&
    value.policy.readOnly === true &&
    isStoredSurfacePolicy(value.policy.surfaces) &&
    Array.isArray(value.policy.allowedReadTools) &&
    typeof value.policy.maxCallsPerRun === "number" &&
    Array.isArray(value.tools) &&
    typeof value.blockedToolCount === "number" &&
    typeof value.dataSensitivity === "string"
  )
}

export function isStoredSurfacePolicy(value: unknown): value is McpSurfacePolicy {
  if (!isPlainObject(value)) return false
  const keys = ["chat", "deep-research", "cli", "pr-review", "agent", "memory-index"] as const
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => typeof value[key] === "boolean") &&
    value["memory-index"] === false
  )
}

export function canonicalMcpEndpointUrl(value: URL | string): string | null {
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function timeoutRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("tool timeout"))
    signal.addEventListener("abort", () => reject(new Error("tool timeout")), { once: true })
  })
}

export function failClosedStoredPolicy(version: number): StoredMcpPolicy {
  return {
    version: Number.isSafeInteger(version) && version > 0 ? version : 1,
    enabled: false,
    surfaces: {
      chat: false,
      "deep-research": false,
      cli: false,
      "pr-review": false,
      agent: false,
      "memory-index": false,
    },
    allowedReadTools: [],
    maxCallsPerRun: 0,
  }
}

function isTenantScope(value: string): boolean {
  if (!/^tenant:[1-9]\d*$/.test(value)) return false
  const id = Number(value.slice("tenant:".length))
  return Number.isSafeInteger(id) && id > 0
}

function migrateLegacyMcpState(storage: DurableObjectStorage): void {
  const tables = new Set(
    storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sigilix_mcp_policies', 'sigilix_mcp_runtime_calls')",
      )
      .toArray()
      .map((row) => row.name),
  )
  if (tables.has("sigilix_mcp_policies")) migrateLegacyPolicies(storage)
  if (tables.has("sigilix_mcp_runtime_calls")) migrateLegacyCalls(storage)
}

function migrateLegacyPolicies(storage: DurableObjectStorage): void {
  const rows = storage.sql
    .exec<{
      server_id: string
      version: number
      enabled: number
      chat_enabled: number
      deep_research_enabled: number
      allowed_read_tools: string
      max_calls_per_run: number
    }>(
      `SELECT server_id, version, enabled, chat_enabled, deep_research_enabled,
              allowed_read_tools, max_calls_per_run
         FROM sigilix_mcp_policies`,
    )
    .toArray()
  for (const row of rows) {
    const surfaces: McpSurfacePolicy = {
      chat: row.chat_enabled === 1,
      "deep-research": row.deep_research_enabled === 1,
      cli: false,
      "pr-review": false,
      agent: false,
      "memory-index": false,
    }
    storage.sql.exec(
      `INSERT OR IGNORE INTO sigilix_mcp_policies_v2
         (server_id, version, enabled, surfaces, allowed_read_tools, max_calls_per_run)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.server_id,
      row.version,
      row.enabled,
      JSON.stringify(surfaces),
      row.allowed_read_tools,
      row.max_calls_per_run,
    )
  }
}

function migrateLegacyCalls(storage: DurableObjectStorage): void {
  const rows = storage.sql
    .exec<{ run_id: string; server_id: string; surface: string; call_count: number; updated_at: number }>(
      `SELECT run_id, server_id, surface, call_count, updated_at
         FROM sigilix_mcp_runtime_calls
        WHERE surface IN ('chat', 'deep-research')`,
    )
    .toArray()
  for (const row of rows) {
    storage.sql.exec(
      `INSERT OR IGNORE INTO sigilix_mcp_runtime_calls_v2
         (run_id, server_id, surface, call_count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.run_id,
      row.server_id,
      row.surface,
      row.call_count,
      row.updated_at,
    )
  }
}
