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
 * Read one record by id. Returns null on missing key, corrupt JSON, schema
 * mismatch, or a KV throw (telemetered). Never throws.
 */
export async function readRecord(
  env: Env,
  userId: string,
  repoId: string,
  id: string,
): Promise<AgentMemoryRecord | null> {
  const key = recordKey(userId, repoId, id)
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
