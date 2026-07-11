import type { OfficialMcpVendor } from "@/src/shared/domain/runtime-app-registry"

export const MCP_MEMORY_DIMENSIONS = 768
export const MCP_MEMORY_MAX_PER_GRANT = 64
export const MCP_MEMORY_MAX_PER_TENANT = 256
export const MCP_MEMORY_MAX_CONTENT_CHARS = 12_000
export const MCP_MEMORY_TTL_MS = 24 * 60 * 60 * 1_000

const EMBEDDING_BYTES = MCP_MEMORY_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const SHA256_RE = /^[a-f0-9]{64}$/

const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sigilix_mcp_memory_v1 (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  grant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) <= ${MCP_MEMORY_MAX_CONTENT_CHARS}),
  embedding BLOB NOT NULL CHECK (length(embedding) = ${EMBEDDING_BYTES}),
  source_at INTEGER NOT NULL CHECK (source_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > source_at),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (installation_id, grant_id, provider, tool_name, input_hash)
);
CREATE INDEX IF NOT EXISTS sigilix_mcp_memory_v1_grant
  ON sigilix_mcp_memory_v1(installation_id, grant_id);
CREATE INDEX IF NOT EXISTS sigilix_mcp_memory_v1_expiry
  ON sigilix_mcp_memory_v1(expires_at);
`

export interface McpMemoryRecord {
  id: string
  installationId: number
  grantId: string
  provider: OfficialMcpVendor
  toolName: string
  inputHash: string
  content: string
  embedding: Float32Array
  sourceAt: number
  expiresAt: number
  policyVersion: number
}

export interface McpMemoryWriteArgs extends Omit<McpMemoryRecord, "embedding"> {
  embedding: readonly number[]
}

export type McpMemoryWriteResult =
  | { outcome: "stored" }
  | { outcome: "replaced" }
  | { outcome: "denied" }
  | { outcome: "capacity" }

type MemoryRow = {
  id: string
  installation_id: number
  grant_id: string
  provider: string
  tool_name: string
  input_hash: string
  content: string
  embedding: ArrayBuffer
  source_at: number
  expires_at: number
  policy_version: number
}

/**
 * Tenant-local MCP memory source of truth. Every mutation is synchronous and
 * serialized by the owning Durable Object SQLite database. The store never
 * receives provider credentials or raw tool arguments.
 */
export class TenantMcpMemoryIndex {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(MEMORY_SCHEMA)
  }

  writeIfAuthorized(args: McpMemoryWriteArgs, authorize: () => boolean): McpMemoryWriteResult {
    validateWrite(args)
    const blob = encodeEmbedding(args.embedding)
    return this.storage.transactionSync(() => {
      if (!authorize()) return { outcome: "denied" }
      this.storage.sql.exec("DELETE FROM sigilix_mcp_memory_v1 WHERE expires_at <= ?", args.sourceAt)
      const existing = this.storage.sql
        .exec<{ id: string }>("SELECT id FROM sigilix_mcp_memory_v1 WHERE id = ?", args.id)
        .toArray()[0]
      if (!existing) {
        const grantCount = count(
          this.storage,
          "SELECT COUNT(*) AS count FROM sigilix_mcp_memory_v1 WHERE installation_id = ? AND grant_id = ?",
          args.installationId,
          args.grantId,
        )
        const tenantCount = count(
          this.storage,
          "SELECT COUNT(*) AS count FROM sigilix_mcp_memory_v1 WHERE installation_id = ?",
          args.installationId,
        )
        if (grantCount >= MCP_MEMORY_MAX_PER_GRANT || tenantCount >= MCP_MEMORY_MAX_PER_TENANT) {
          return { outcome: "capacity" }
        }
      }
      this.storage.sql.exec(
        `INSERT INTO sigilix_mcp_memory_v1
           (id, installation_id, grant_id, provider, tool_name, input_hash, content,
            embedding, source_at, expires_at, policy_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           embedding = excluded.embedding,
           source_at = excluded.source_at,
           expires_at = excluded.expires_at,
           policy_version = excluded.policy_version,
           updated_at = excluded.updated_at`,
        args.id,
        args.installationId,
        args.grantId,
        args.provider,
        args.toolName,
        args.inputHash,
        args.content,
        blob,
        args.sourceAt,
        args.expiresAt,
        args.policyVersion,
        args.sourceAt,
        args.sourceAt,
      )
      return { outcome: existing ? "replaced" : "stored" }
    })
  }

  listCandidates(installationId: number, grantIds: readonly string[], now: number): McpMemoryRecord[] {
    assertInstallationId(installationId)
    assertTimestamp(now)
    const uniqueGrantIds = [...new Set(grantIds)]
    if (uniqueGrantIds.length === 0) return []
    if (uniqueGrantIds.length > 32 || uniqueGrantIds.some((grantId) => !SAFE_ID_RE.test(grantId))) {
      throw new TypeError("invalid grant ids")
    }
    return this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM sigilix_mcp_memory_v1 WHERE expires_at <= ?", now)
      const placeholders = uniqueGrantIds.map(() => "?").join(", ")
      const rows = this.storage.sql
        .exec<MemoryRow>(
          `SELECT id, installation_id, grant_id, provider, tool_name, input_hash,
                  content, embedding, source_at, expires_at, policy_version
             FROM sigilix_mcp_memory_v1
            WHERE installation_id = ? AND expires_at > ? AND grant_id IN (${placeholders})
            ORDER BY source_at DESC, id ASC`,
          installationId,
          now,
          ...uniqueGrantIds,
        )
        .toArray()
      const records: McpMemoryRecord[] = []
      for (const row of rows) {
        const record = mapRow(row)
        if (record) records.push(record)
      }
      return records
    })
  }

  expireRecord(
    installationId: number,
    id: string,
    expectedExpiresAt: number,
    now: number,
  ): { outcome: "deleted" | "missing" | "stale" } | { outcome: "early"; rescheduleAt: number } {
    assertInstallationId(installationId)
    if (!SAFE_ID_RE.test(id)) throw new TypeError("invalid memory id")
    assertTimestamp(expectedExpiresAt)
    assertTimestamp(now)
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{
          expires_at: number
        }>("SELECT expires_at FROM sigilix_mcp_memory_v1 WHERE id = ? AND installation_id = ?", id, installationId)
        .toArray()[0]
      if (!row) {
        return now < expectedExpiresAt ? { outcome: "early", rescheduleAt: expectedExpiresAt } : { outcome: "missing" }
      }
      if (row.expires_at !== expectedExpiresAt) return { outcome: "stale" }
      if (row.expires_at > now) return { outcome: "early", rescheduleAt: row.expires_at }
      this.storage.sql.exec(
        `DELETE FROM sigilix_mcp_memory_v1
          WHERE id = ? AND installation_id = ? AND expires_at = ? AND expires_at <= ?`,
        id,
        installationId,
        expectedExpiresAt,
        now,
      )
      return { outcome: "deleted" }
    })
  }

  purgeGrant(grantId: string): number {
    if (!SAFE_ID_RE.test(grantId)) throw new TypeError("invalid grant id")
    return this.storage.sql.exec("DELETE FROM sigilix_mcp_memory_v1 WHERE grant_id = ?", grantId).rowsWritten
  }
}

export interface ScoredMcpMemoryRecord {
  record: McpMemoryRecord
  score: number
}

export function scoreMcpMemoryRecords(
  records: readonly McpMemoryRecord[],
  queryEmbedding: readonly number[],
): ScoredMcpMemoryRecord[] {
  const query = normalizeEmbedding(queryEmbedding)
  const scored = records.map((record) => ({ record, score: cosineSimilarity(record.embedding, query) }))
  return scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.record.sourceAt - left.record.sourceAt ||
      left.record.id.localeCompare(right.record.id),
  )
}

export async function canonicalMcpInputHash(value: Record<string, unknown>): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalJson(value)))
}

export async function mcpMemoryRecordId(args: {
  installationId: number
  grantId: string
  provider: OfficialMcpVendor
  toolName: string
  inputHash: string
}): Promise<string> {
  assertInstallationId(args.installationId)
  if (!SAFE_ID_RE.test(args.grantId) || !SAFE_ID_RE.test(args.provider) || !SAFE_ID_RE.test(args.toolName)) {
    throw new TypeError("invalid memory provenance")
  }
  if (!SHA256_RE.test(args.inputHash)) throw new TypeError("invalid input hash")
  return sha256Hex(
    [String(args.installationId), args.grantId, args.provider, args.toolName, args.inputHash].join("\u0000"),
  )
}

function validateWrite(args: McpMemoryWriteArgs): void {
  if (!SAFE_ID_RE.test(args.id) || !SAFE_ID_RE.test(args.grantId) || !SAFE_ID_RE.test(args.provider)) {
    throw new TypeError("invalid memory identity")
  }
  if (!SAFE_ID_RE.test(args.toolName) || !SHA256_RE.test(args.inputHash)) {
    throw new TypeError("invalid memory provenance")
  }
  assertInstallationId(args.installationId)
  assertTimestamp(args.sourceAt)
  assertTimestamp(args.expiresAt)
  if (args.expiresAt <= args.sourceAt || args.expiresAt - args.sourceAt > MCP_MEMORY_TTL_MS) {
    throw new TypeError("invalid memory expiry")
  }
  if (!Number.isSafeInteger(args.policyVersion) || args.policyVersion < 0) {
    throw new TypeError("invalid policy version")
  }
  if (!args.content.trim() || args.content.length > MCP_MEMORY_MAX_CONTENT_CHARS) {
    throw new TypeError("invalid memory content")
  }
}

function count(storage: DurableObjectStorage, sql: string, ...bindings: unknown[]): number {
  const row = storage.sql.exec<{ count: number }>(sql, ...bindings).toArray()[0]
  return Number(row?.count ?? 0)
}

function mapRow(row: MemoryRow): McpMemoryRecord | null {
  const embedding = decodeEmbedding(row.embedding)
  if (
    !embedding ||
    !SAFE_ID_RE.test(row.id) ||
    !SAFE_ID_RE.test(row.grant_id) ||
    !SAFE_ID_RE.test(row.provider) ||
    !SAFE_ID_RE.test(row.tool_name) ||
    !SHA256_RE.test(row.input_hash) ||
    !Number.isSafeInteger(row.installation_id) ||
    row.installation_id <= 0 ||
    !Number.isSafeInteger(row.source_at) ||
    !Number.isSafeInteger(row.expires_at) ||
    !Number.isSafeInteger(row.policy_version)
  ) {
    return null
  }
  return {
    id: row.id,
    installationId: row.installation_id,
    grantId: row.grant_id,
    provider: row.provider as OfficialMcpVendor,
    toolName: row.tool_name,
    inputHash: row.input_hash,
    content: row.content,
    embedding,
    sourceAt: row.source_at,
    expiresAt: row.expires_at,
    policyVersion: row.policy_version,
  }
}

function encodeEmbedding(values: readonly number[]): ArrayBuffer {
  const normalized = normalizeEmbedding(values)
  const copy = new Uint8Array(EMBEDDING_BYTES)
  copy.set(new Uint8Array(normalized.buffer))
  return copy.buffer
}

function decodeEmbedding(value: unknown): Float32Array | null {
  const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes) return null
  if (bytes.byteLength !== EMBEDDING_BYTES) return null
  const copy = new Uint8Array(EMBEDDING_BYTES)
  copy.set(bytes)
  const decoded = new Float32Array(copy.buffer)
  return [...decoded].every(Number.isFinite) ? decoded : null
}

function normalizeEmbedding(values: readonly number[]): Float32Array {
  if (values.length !== MCP_MEMORY_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("invalid memory embedding")
  }
  return Float32Array.from(values)
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < MCP_MEMORY_DIMENSIONS; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalJson((value as Record<string, unknown>)[key])
  }
  return out
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assertInstallationId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("invalid installation id")
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid timestamp")
}
