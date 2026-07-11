/**
 * Tenant-broker authorization grants stored beside MCP connections in the
 * existing MCP_CONNECTIONS Durable Object. The registry is deliberately
 * synchronous: SQLite-backed DO storage serializes each transition, and a
 * revoke is no longer visible to a runtime caller as soon as `revoke` returns.
 *
 * `ownerScope` is the stable portal seat that authorized the tenant grant. It
 * must be a real `session:<subject>` scope; tenant scopes and anonymous
 * placeholders are rejected so a bearer token can never manufacture a human
 * authorization record.
 */

import { narrowMcpPolicy, type StoredMcpPolicy } from "./runtime-policy"

const DEFAULT_SURFACES = JSON.stringify({
  chat: false,
  "deep-research": false,
  cli: false,
  "pr-review": false,
  agent: false,
  "memory-index": false,
})

const GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sigilix_mcp_tenant_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  owner_scope TEXT NOT NULL,
  server_id TEXT NOT NULL,
  creator_subject TEXT NOT NULL,
  server_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'revoked')),
  policy_version INTEGER NOT NULL DEFAULT 0,
  policy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (policy_enabled IN (0, 1)),
  policy_surfaces TEXT NOT NULL DEFAULT '${DEFAULT_SURFACES}',
  policy_allowed_read_tools TEXT NOT NULL DEFAULT '[]',
  policy_max_calls_per_run INTEGER NOT NULL DEFAULT 0
    CHECK (policy_max_calls_per_run >= 0 AND policy_max_calls_per_run <= 4),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at >= 0),
  failed_at INTEGER CHECK (failed_at IS NULL OR failed_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS sigilix_mcp_tenant_grants_open_owner_server
  ON sigilix_mcp_tenant_grants(owner_scope, server_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS sigilix_mcp_tenant_grants_status_created
  ON sigilix_mcp_tenant_grants(status, created_at);
`

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export type TenantMcpGrantStatus = "pending" | "active" | "failed" | "revoked"

export interface TenantMcpGrant {
  grantId: string
  ownerScope: string
  serverId: string
  creatorSubject: string
  serverUrl: string
  status: TenantMcpGrantStatus
  policy: StoredMcpPolicy
  createdAt: number
  updatedAt: number
  activatedAt: number | null
  failedAt: number | null
  revokedAt: number | null
}

export interface CreatePendingTenantMcpGrantArgs {
  grantId: string
  ownerScope: string
  serverId: string
  creatorSubject: string
  serverUrl: string
}

export type CreatePendingTenantMcpGrantResult =
  | { outcome: "created"; grant: TenantMcpGrant }
  | { outcome: "existing"; grant: TenantMcpGrant }

type TenantMcpGrantRow = {
  grant_id: string
  owner_scope: string
  server_id: string
  creator_subject: string
  server_url: string
  status: string
  policy_version: number
  policy_enabled: number
  policy_surfaces: string
  policy_allowed_read_tools: string
  policy_max_calls_per_run: number
  created_at: number
  updated_at: number
  activated_at: number | null
  failed_at: number | null
  revoked_at: number | null
}

interface TenantMcpGrantRegistryOptions {
  now?: () => number
}

export class TenantMcpGrantRegistry {
  private readonly now: () => number

  constructor(
    private readonly storage: DurableObjectStorage,
    options: TenantMcpGrantRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    storage.sql.exec(GRANTS_SCHEMA)
  }

  /**
   * Persist one pre-minted opaque authorization attempt. A retry for the same
   * seat and server returns the existing pending/active row instead of
   * creating a second OAuth flow. The partial unique index is the final
   * invariant guard.
   */
  createPending(args: CreatePendingTenantMcpGrantArgs): CreatePendingTenantMcpGrantResult {
    assertId("grantId", args.grantId)
    assertOwnerScope(args.ownerScope)
    assertId("serverId", args.serverId)
    assertId("creatorSubject", args.creatorSubject)
    assertServerUrl(args.serverUrl)

    return this.storage.transactionSync(() => {
      const matchingId = this.readByGrantId(args.grantId)
      if (matchingId) {
        if (
          matchingId.ownerScope === args.ownerScope &&
          matchingId.serverId === args.serverId &&
          matchingId.serverUrl === args.serverUrl &&
          (matchingId.status === "pending" || matchingId.status === "active")
        ) {
          return { outcome: "existing", grant: matchingId }
        }
        throw new TypeError("grantId already exists")
      }
      const existing = this.readOpenForOwnerServer(args.ownerScope, args.serverId)
      if (existing) return { outcome: "existing", grant: existing }

      const at = this.readNow()
      this.storage.sql.exec(
        `INSERT INTO sigilix_mcp_tenant_grants
           (grant_id, owner_scope, server_id, creator_subject, server_url, status,
            policy_version, policy_enabled, policy_surfaces, policy_allowed_read_tools,
            policy_max_calls_per_run, created_at, updated_at, activated_at, failed_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, '[]', 0, ?, ?, NULL, NULL, NULL)`,
        args.grantId,
        args.ownerScope,
        args.serverId,
        args.creatorSubject,
        args.serverUrl,
        DEFAULT_SURFACES,
        at,
        at,
      )
      return { outcome: "created", grant: this.readByGrantId(args.grantId)! }
    })
  }

  /** Pending → active. Repeated activation returns the byte-stable active row. */
  activate(grantId: string): TenantMcpGrant | null {
    assertId("grantId", grantId)
    return this.storage.transactionSync(() => {
      const current = this.readByGrantId(grantId)
      if (!current || current.status !== "pending") return current
      const at = this.readNow()
      this.storage.sql.exec(
        `UPDATE sigilix_mcp_tenant_grants
            SET status = 'active', updated_at = ?, activated_at = ?
          WHERE grant_id = ? AND status = 'pending'`,
        at,
        at,
        grantId,
      )
      return this.readByGrantId(grantId)
    })
  }

  /** Pending → failed. Active and terminal grants are never downgraded. */
  fail(grantId: string): TenantMcpGrant | null {
    assertId("grantId", grantId)
    return this.storage.transactionSync(() => {
      const current = this.readByGrantId(grantId)
      if (!current || current.status !== "pending") return current
      const at = this.readNow()
      this.storage.sql.exec(
        `UPDATE sigilix_mcp_tenant_grants
            SET status = 'failed', updated_at = ?, failed_at = ?
          WHERE grant_id = ? AND status = 'pending'`,
        at,
        at,
        grantId,
      )
      return this.readByGrantId(grantId)
    })
  }

  /** Only an active grant is usable as a tenant-broker authorization. */
  getActive(grantId: string): TenantMcpGrant | null {
    assertId("grantId", grantId)
    const grant = this.readByGrantId(grantId)
    return grant?.status === "active" ? grant : null
  }

  get(grantId: string): TenantMcpGrant | null {
    assertId("grantId", grantId)
    return this.readByGrantId(grantId)
  }

  updatePolicy(grantId: string, value: unknown): { grant: TenantMcpGrant } | { error: string } | null {
    assertId("grantId", grantId)
    return this.storage.transactionSync(() => {
      const current = this.readByGrantId(grantId)
      if (!current || current.status !== "active") return null
      const narrowed = narrowMcpPolicy(current.serverUrl, value, current.policy.version)
      if (!narrowed.ok) return { error: narrowed.error }
      const policy = narrowed.policy
      const at = this.readNow()
      this.storage.sql.exec(
        `UPDATE sigilix_mcp_tenant_grants
            SET policy_version = ?, policy_enabled = ?, policy_surfaces = ?,
                policy_allowed_read_tools = ?, policy_max_calls_per_run = ?, updated_at = ?
          WHERE grant_id = ? AND status = 'active'`,
        policy.version,
        policy.enabled ? 1 : 0,
        JSON.stringify(policy.surfaces),
        JSON.stringify(policy.allowedReadTools),
        policy.maxCallsPerRun,
        at,
        grantId,
      )
      return { grant: this.readByGrantId(grantId)! }
    })
  }

  /** List grants that may still become, or already are, usable. */
  listOpen(ownerScope?: string): TenantMcpGrant[] {
    if (ownerScope !== undefined) assertOwnerScope(ownerScope)
    const rows = ownerScope
      ? this.storage.sql
          .exec<TenantMcpGrantRow>(
            `${GRANT_COLUMNS}
               WHERE status IN ('pending', 'active') AND owner_scope = ?
               ORDER BY created_at ASC, grant_id ASC`,
            ownerScope,
          )
          .toArray()
      : this.storage.sql
          .exec<TenantMcpGrantRow>(
            `${GRANT_COLUMNS}
               WHERE status IN ('pending', 'active')
               ORDER BY created_at ASC, grant_id ASC`,
          )
          .toArray()
    return rows.map(mapGrantRow)
  }

  /**
   * Immediately revoke any known grant. A repeat is a no-op that preserves the
   * original revocation time; the open-grant unique slot is released inline.
   */
  revoke(grantId: string): TenantMcpGrant | null {
    assertId("grantId", grantId)
    return this.storage.transactionSync(() => {
      const current = this.readByGrantId(grantId)
      if (!current || current.status === "revoked") return current
      const at = this.readNow()
      this.storage.sql.exec(
        `UPDATE sigilix_mcp_tenant_grants
            SET status = 'revoked', updated_at = ?, revoked_at = ?
          WHERE grant_id = ? AND status <> 'revoked'`,
        at,
        at,
        grantId,
      )
      return this.readByGrantId(grantId)
    })
  }

  /**
   * Expire pending rows created before `cutoffMs`. They become failed rather
   * than disappearing so the authorization attempt remains auditable while no
   * longer occupying the one-open-grant slot.
   */
  gcStalePending(cutoffMs: number): number {
    assertTimestamp("cutoffMs", cutoffMs)
    return this.storage.transactionSync(() => {
      const at = this.readNow()
      return this.storage.sql.exec(
        `UPDATE sigilix_mcp_tenant_grants
            SET status = 'failed', updated_at = ?, failed_at = ?
          WHERE status = 'pending' AND created_at < ?`,
        at,
        at,
        cutoffMs,
      ).rowsWritten
    })
  }

  private readOpenForOwnerServer(ownerScope: string, serverId: string): TenantMcpGrant | null {
    const row = this.storage.sql
      .exec<TenantMcpGrantRow>(
        `${GRANT_COLUMNS}
           WHERE owner_scope = ? AND server_id = ? AND status IN ('pending', 'active')
           ORDER BY created_at ASC, grant_id ASC
           LIMIT 1`,
        ownerScope,
        serverId,
      )
      .toArray()[0]
    return row ? mapGrantRow(row) : null
  }

  private readByGrantId(grantId: string): TenantMcpGrant | null {
    const row = this.storage.sql.exec<TenantMcpGrantRow>(`${GRANT_COLUMNS} WHERE grant_id = ?`, grantId).toArray()[0]
    return row ? mapGrantRow(row) : null
  }

  private readNow(): number {
    const at = this.now()
    assertTimestamp("timestamp", at)
    return at
  }
}

const GRANT_COLUMNS = `SELECT grant_id, owner_scope, server_id, creator_subject, server_url, status,
                              policy_version, policy_enabled, policy_surfaces,
                              policy_allowed_read_tools, policy_max_calls_per_run,
                              created_at, updated_at, activated_at, failed_at, revoked_at
                         FROM sigilix_mcp_tenant_grants`

function mapGrantRow(row: TenantMcpGrantRow): TenantMcpGrant {
  if (!isGrantStatus(row.status)) throw new Error("invalid tenant MCP grant status in storage")
  const policy = parseStoredPolicy(row)
  return {
    grantId: row.grant_id,
    ownerScope: row.owner_scope,
    serverId: row.server_id,
    creatorSubject: row.creator_subject,
    serverUrl: row.server_url,
    status: row.status,
    policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    failedAt: row.failed_at,
    revokedAt: row.revoked_at,
  }
}

function parseStoredPolicy(row: TenantMcpGrantRow): StoredMcpPolicy {
  try {
    const surfaces = JSON.parse(row.policy_surfaces) as StoredMcpPolicy["surfaces"]
    const allowedReadTools = JSON.parse(row.policy_allowed_read_tools) as unknown
    if (
      !Number.isSafeInteger(row.policy_version) ||
      row.policy_version < 0 ||
      !isSurfacePolicy(surfaces) ||
      !Array.isArray(allowedReadTools) ||
      allowedReadTools.some((name) => typeof name !== "string" || !SAFE_ID_RE.test(name)) ||
      !Number.isSafeInteger(row.policy_max_calls_per_run) ||
      row.policy_max_calls_per_run < 0 ||
      row.policy_max_calls_per_run > 4
    ) {
      throw new TypeError("invalid policy")
    }
    return {
      version: row.policy_version,
      enabled: row.policy_enabled === 1,
      surfaces,
      allowedReadTools,
      maxCallsPerRun: row.policy_max_calls_per_run,
    }
  } catch {
    return {
      version: Number.isSafeInteger(row.policy_version) && row.policy_version > 0 ? row.policy_version : 1,
      enabled: false,
      surfaces: JSON.parse(DEFAULT_SURFACES) as StoredMcpPolicy["surfaces"],
      allowedReadTools: [],
      maxCallsPerRun: 0,
    }
  }
}

function isSurfacePolicy(value: unknown): value is StoredMcpPolicy["surfaces"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = ["chat", "deep-research", "cli", "pr-review", "agent", "memory-index"]
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => typeof record[key] === "boolean") &&
    record["memory-index"] === false
  )
}

function assertServerUrl(value: string): void {
  if (value.length === 0 || value.length > 2_048) throw new TypeError("invalid serverUrl")
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new TypeError("invalid serverUrl")
    }
  } catch {
    throw new TypeError("invalid serverUrl")
  }
}

function isGrantStatus(value: string): value is TenantMcpGrantStatus {
  return value === "pending" || value === "active" || value === "failed" || value === "revoked"
}

function assertOwnerScope(value: string): void {
  if (!value.startsWith("session:")) throw new TypeError("invalid ownerScope")
  const subject = value.slice("session:".length)
  if (!SAFE_ID_RE.test(subject) || subject === "anon" || subject === "anonymous") {
    throw new TypeError("invalid ownerScope")
  }
}

function assertId(name: "serverId" | "creatorSubject" | "grantId", value: string): void {
  if (!SAFE_ID_RE.test(value)) throw new TypeError(`invalid ${name}`)
}

function assertTimestamp(name: "timestamp" | "cutoffMs", value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`)
}
