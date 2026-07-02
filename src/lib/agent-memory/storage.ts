// Agent-memory store — KV storage layer.
//
// Reuses the existing `OPENCLAW_STATE` KV namespace (no new binding). Two
// keyspaces:
//
//   agent-memory:<userId>:<repoId>:<id>        → the AgentMemoryRecord JSON
//   agent-memory-hash:<userId>:<repoId>:<hash> → the id of a same-content record
//
// The hash key is the exact-duplicate dedup index (spec): before a write the
// route SHA-256s `content`, probes the hash key, and if a record already exists
// returns its id instead of writing a second copy.
//
// Soft contract (mirrors review-memory/storage.ts): reads validate-after-parse
// and NEVER throw — a KV throw / corrupt JSON / schema mismatch returns null with
// telemetry. Writes report success via a boolean rather than throwing, so a
// transient KV failure degrades the response (a `stored` flag) instead of 500ing.

import type { AgentMemoryKind, AgentMemoryRecord } from "./types"
import { ALL_AGENT_MEMORY_KINDS } from "./types"
import type { Env } from "@/src/shared/types/env"

// Records live indefinitely (agent long-term memory); no TTL. A future
// portal/D1 migration owns retention (mirrors the review-memory KV→D1 plan).

// ─── Key derivation ──────────────────────────────────────────

export function recordKey(userId: string, repoId: string, id: string): string {
  return `agent-memory:${userId}:${repoId}:${id}`
}

export function hashKey(userId: string, repoId: string, hash: string): string {
  return `agent-memory-hash:${userId}:${repoId}:${hash}`
}

// ─── Telemetry helper ────────────────────────────────────────

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

// ─── Validation (validate-after-parse) ───────────────────────

function isAgentMemoryKind(value: unknown): value is AgentMemoryKind {
  return typeof value === "string" && (ALL_AGENT_MEMORY_KINDS as readonly string[]).includes(value)
}

function isValidRecord(value: unknown): value is AgentMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1) return false
  if (typeof r.id !== "string" || r.id === "") return false
  if (typeof r.userId !== "string" || r.userId === "") return false
  if (typeof r.repoId !== "string" || r.repoId === "") return false
  if (!isAgentMemoryKind(r.kind)) return false
  if (typeof r.content !== "string") return false
  if (typeof r.ts !== "string") return false
  if (typeof r.hash !== "string") return false
  return true
}

// ─── Reads (never throw) ─────────────────────────────────────

/**
 * Get one KV key and validate-after-parse it into a record. Returns null on a
 * missing key, corrupt JSON, schema mismatch, or a KV throw (each telemetered by
 * the exact key). The single hydration primitive shared by {@link readRecord},
 * {@link listRecords}, and {@link findRecordByIdUnderPrefix}. Never throws.
 */
async function getAndValidate(env: Env, key: string): Promise<AgentMemoryRecord | null> {
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (err) {
    emitTelemetry("agent-memory-read-failed", { key, err: err instanceof Error ? err.message : String(err) })
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    emitTelemetry("agent-memory-corrupt-record", { key, reason: "json-parse-failed" })
    return null
  }
  if (!isValidRecord(parsed)) {
    emitTelemetry("agent-memory-corrupt-record", { key, reason: "schema-mismatch" })
    return null
  }
  return parsed
}

/**
 * Read one record by id. Returns null on missing key, corrupt JSON, schema
 * mismatch, or a KV throw (telemetered). Never throws.
 */
export async function readRecord(
  env: Env,
  userId: string,
  repoId: string,
  id: string,
): Promise<AgentMemoryRecord | null> {
  return getAndValidate(env, recordKey(userId, repoId, id))
}

// ─── List / find (never throw on the list leg) ───────────────

/** One page of listed records + the KV cursor (absent when the page is the last). */
export interface ListRecordsPage {
  records: AgentMemoryRecord[]
  cursor?: string
}

/**
 * List (a page of) records whose KV key starts with `prefix`, hydrating +
 * validating each. Pagination uses KV's native `list({prefix, limit, cursor})`
 * cursor, so following the returned cursor yields the remaining records with no
 * duplicates. FAIL-SOFT: a `.list()` throw returns `{ records: [] }` (no cursor),
 * telemetered — never throws (the list route degrades to an empty page, never a
 * 500). A per-key hydrate failure (missing / corrupt / schema-mismatch) skips
 * that one key via {@link getAndValidate}. Defensively skips any
 * `agent-memory-hash:` dedup-pointer key — those live under a different keyspace
 * so an `agent-memory:` prefix never surfaces them, but the guard survives a
 * future key-layout change.
 */
export async function listRecords(
  env: Env,
  prefix: string,
  opts: { limit: number; cursor?: string },
): Promise<ListRecordsPage> {
  let page: KVNamespaceListResult<unknown, string>
  try {
    page = await env.OPENCLAW_STATE.list({ prefix, limit: opts.limit, ...(opts.cursor ? { cursor: opts.cursor } : {}) })
  } catch (err) {
    emitTelemetry("agent-memory-list-failed", { prefix, err: err instanceof Error ? err.message : String(err) })
    return { records: [] }
  }
  const records: AgentMemoryRecord[] = []
  for (const key of page.keys) {
    if (key.name.startsWith("agent-memory-hash:")) continue
    const record = await getAndValidate(env, key.name)
    if (record !== null) records.push(record)
  }
  const cursor = page.list_complete ? undefined : page.cursor
  return { records, ...(cursor ? { cursor } : {}) }
}

/** Cap on how many KV list pages a single delete-by-id lookup will walk. A delete
 *  only ever scans ONE tenant's own prefix; this bounds a pathological tenant. */
const MAX_FIND_SCAN_PAGES = 50
/** KV list page size for the delete-by-id scan (KV's per-call maximum). */
const FIND_SCAN_PAGE_SIZE = 1000

/**
 * Find the record with id `id` whose KV key starts with `prefix` (the caller's
 * own tenant prefix — so a hit is by construction owned by the caller). Scans key
 * NAMES (cheap) matching the terminal `:<id>` segment, then hydrates + validates
 * only the single candidate and confirms `record.id === id`. Walks up to
 * {@link MAX_FIND_SCAN_PAGES} pages. Returns null on not-found or a `.list()`
 * throw (telemetered). Never throws.
 */
export async function findRecordByIdUnderPrefix(
  env: Env,
  prefix: string,
  id: string,
): Promise<AgentMemoryRecord | null> {
  const suffix = `:${id}`
  let cursor: string | undefined
  for (let seen = 0; seen < MAX_FIND_SCAN_PAGES; seen++) {
    let page: KVNamespaceListResult<unknown, string>
    try {
      page = await env.OPENCLAW_STATE.list({ prefix, limit: FIND_SCAN_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    } catch (err) {
      emitTelemetry("agent-memory-list-failed", { prefix, err: err instanceof Error ? err.message : String(err) })
      return null
    }
    for (const key of page.keys) {
      if (key.name.startsWith("agent-memory-hash:")) continue
      if (!key.name.endsWith(suffix)) continue
      const record = await getAndValidate(env, key.name)
      if (record !== null && record.id === id) return record
    }
    if (page.list_complete) return null
    cursor = page.cursor
  }
  return null
}

/**
 * Look up the id of an existing record whose content hashes to `hash`, or null.
 * Never throws (a KV failure → null, telemetered → the caller writes a fresh
 * record rather than incorrectly deduping).
 */
export async function readHashId(env: Env, userId: string, repoId: string, hash: string): Promise<string | null> {
  try {
    const id = await env.OPENCLAW_STATE.get(hashKey(userId, repoId, hash))
    return id !== null && id !== "" ? id : null
  } catch (err) {
    emitTelemetry("agent-memory-read-failed", {
      key: hashKey(userId, repoId, hash),
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// ─── Writes (report success, never throw) ────────────────────

/**
 * Persist the record JSON. Returns true on success. The load-bearing write — the
 * route reports this as the `stored` flag. Never throws (a KV failure → false,
 * telemetered).
 */
export async function writeRecord(env: Env, record: AgentMemoryRecord): Promise<boolean> {
  const rKey = recordKey(record.userId, record.repoId, record.id)
  try {
    await env.OPENCLAW_STATE.put(rKey, JSON.stringify(record))
    return true
  } catch (err) {
    emitTelemetry("agent-memory-write-failed", {
      key: rKey,
      stage: "record",
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Write the content-hash → id dedup pointer. The route calls this ONLY when the
 * full write landed (record KV + vector upsert): a future identical write then
 * short-circuits to the existing id. Deliberately NOT written when the vector leg
 * failed — otherwise the pointer would dedup away the retry that would finally
 * land the vector, leaving the memory permanently absent from query. Best-effort
 * (a pointer-write failure just means a later identical write re-stores rather
 * than dedups — recall-safe). Never throws.
 */
export async function writeHashPointer(env: Env, record: AgentMemoryRecord): Promise<void> {
  const hKey = hashKey(record.userId, record.repoId, record.hash)
  try {
    await env.OPENCLAW_STATE.put(hKey, record.id)
  } catch (err) {
    emitTelemetry("agent-memory-write-failed", {
      key: hKey,
      stage: "hash",
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── Delete ──────────────────────────────────────────────────

/**
 * Delete BOTH KV keys for a record — the content-hash dedup pointer
 * (`agent-memory-hash:<userId>:<repoId>:<hash>`) FIRST, then the record itself —
 * so a later identical write is not deduped away against a now-absent record.
 *
 * ORDER MATTERS (data-loss guard): the pointer is deleted before the record. If
 * the pointer delete throws (a KV fault), the record is still fully intact and the
 * whole delete is safely retryable. If instead the RECORD were deleted first and
 * the pointer delete then threw, we'd be left with an orphaned pointer aimed at a
 * dead id — a future identical write would dedup against it and silently persist
 * nothing (the record would never come back). Deleting the pointer first means the
 * worst case is a harmless orphaned RECORD (still readable/re-deletable), never an
 * orphaned pointer.
 *
 * Deletes are derived from the record's OWN fields (userId/repoId/id/hash), so the
 * caller must have already loaded + ownership-checked it. May throw (a KV delete
 * fault) — the route owns the error boundary (→ 500), matching the write path's
 * 500-on-unexpected-throw.
 */
export async function deleteRecordAndPointer(env: Env, record: AgentMemoryRecord): Promise<void> {
  await env.OPENCLAW_STATE.delete(hashKey(record.userId, record.repoId, record.hash))
  await env.OPENCLAW_STATE.delete(recordKey(record.userId, record.repoId, record.id))
}
