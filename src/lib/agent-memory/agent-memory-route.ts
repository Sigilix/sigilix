// Agent-memory store — PUT /v1/memory + POST /v1/memory/query route handlers.
//
// The local CLI agent persists durable per-(user, repo) memories and retrieves
// the semantically-relevant ones to ground a turn. Auth is the same static bearer
// ($OPENCLAW_SIGILIX_API_KEY) the other /v1 routes use, checked from the HEADER
// before the body read (an unauthorized caller can't force a large buffer).
//
// SOFT-FAIL BY DESIGN (spec): retrieval is grounding, not a verdict, so a
// transient backend failure must NOT 500 —
//   - QUERY: an embed/Vectorize/KV failure → `{ results: [] }` (200). 500 ONLY
//     on an unexpected throw outside the soft seams.
//   - WRITE: an embed/Vectorize failure still attempts the KV write and returns
//     200 with a `stored` flag, so the record persists even when the vector
//     leg degrades. 500 only on an unexpected throw.

import type { Env } from "@/src/shared/types/env"
import { resolveApiKey } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import type { AgentMemoryKind, AgentMemoryQueryResult, AgentMemoryRecord } from "./types"
import { ALL_AGENT_MEMORY_KINDS } from "./types"
import { readHashId, readRecord, writeHashPointer, writeRecord } from "./storage"
import { queryMemoryIds, upsertMemoryVector } from "./retrieval"

// Memories are short (a decision / preference / task note), so the body is tiny —
// the same cap the /v1/context turn-query route uses. Shared with the extract
// route (an exchange is a couple of chat turns, well under this).
export const MAX_BODY_BYTES = 64 * 1024
// Vectorize topK before the ts-sort + post-trim.
const DEFAULT_TOP_K = 8
// Default returned count after sorting newest-first; body `limit` overrides, capped.
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

// ─── SHA-256 (content dedup) ─────────────────────────────────

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ─── PUT /v1/memory — write ──────────────────────────────────

interface WriteBody {
  userId: string
  repoId: string
  kind: AgentMemoryKind
  content: string
}

function isKind(value: unknown): value is AgentMemoryKind {
  return typeof value === "string" && (ALL_AGENT_MEMORY_KINDS as readonly string[]).includes(value)
}

function parseWriteBody(raw: unknown): WriteBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.userId !== "string" || b.userId.trim() === "") return "userId (non-empty string) is required"
  if (typeof b.repoId !== "string" || b.repoId.trim() === "") return "repoId (non-empty string) is required"
  if (!isKind(b.kind)) return `kind must be one of: ${ALL_AGENT_MEMORY_KINDS.join(", ")}`
  if (typeof b.content !== "string" || b.content.trim() === "") return "content (non-empty string) is required"
  // Canonicalize the tenant scope to ONE form (lowercased) so the KV keyspace and
  // the Vectorize namespace derive from the same value — otherwise a write with
  // `repoId: "Sigilix/Boreas"` and a query for `"sigilix/boreas"` would match the
  // (lowercased-namespace) vector but miss the (cased-key) KV record on hydrate.
  return { userId: canonicalTenantId(b.userId), repoId: canonicalTenantId(b.repoId), kind: b.kind, content: b.content }
}

/** Canonical tenant id — trimmed + lowercased. The single normalization point so
 *  KV keys and the Vectorize namespace agree (`memoryNamespace` also lowercases). */
export function canonicalTenantId(value: string): string {
  return value.trim().toLowerCase()
}

/** Outcome of {@link storeMemoryFact}: the record id plus the same per-leg flags
 *  the PUT response surfaces. `deduped` is true when an exact-content record
 *  already existed (no second copy written); `stored`/`vectorStored` report the
 *  KV + Vectorize legs of a fresh write (both true on a deduped hit). */
export interface StoreMemoryFactResult {
  id: string
  deduped: boolean
  stored: boolean
  vectorStored: boolean
}

/**
 * The single per-fact write path: SHA-256 content dedup → (on a fresh write)
 * embed + Vectorize upsert + KV record + dedup pointer. Shared by `PUT /v1/memory`
 * and `POST /v1/memory/extract` so the dedup/persist logic lives in ONE place.
 *
 * Tenant ids are assumed already canonicalized by the caller (both call sites
 * canonicalize at parse time). May throw (a crypto/KV throw) — the caller owns
 * the error boundary (PUT → 500; extract → soft-fail to 0 stored).
 */
export async function storeMemoryFact(
  env: Env,
  args: { userId: string; repoId: string; kind: AgentMemoryKind; content: string },
): Promise<StoreMemoryFactResult> {
  const { userId, repoId, kind, content } = args
  const hash = await sha256Hex(content)

  // Dedup: an exact-content record under this tenant → return its id, no write.
  const existingId = await readHashId(env, userId, repoId, hash)
  if (existingId !== null) {
    return { id: existingId, deduped: true, stored: true, vectorStored: true }
  }

  const id = `mem_${crypto.randomUUID()}`
  const ts = new Date().toISOString()
  const record: AgentMemoryRecord = { schemaVersion: 1, id, userId, repoId, kind, content, ts, hash }

  // Vector leg first (soft — a failure degrades but never aborts the KV write).
  const vectorStored = await upsertMemoryVector(env, { id, userId, repoId, kind, content, ts })
  const stored = await writeRecord(env, record)
  // Only set the dedup pointer once the write is FULLY durable (record + vector):
  // a partial write (vector failed) must stay re-writable so a later identical
  // request re-attempts the vector instead of being deduped away forever.
  if (stored && vectorStored) await writeHashPointer(env, record)
  return { id, deduped: false, stored, vectorStored }
}

/**
 * PUT /v1/memory — embed `content` → upsert to Vectorize (tenant namespace) +
 * store the record in KV. Exact-duplicate dedup via a content-hash KV pointer:
 * a re-write of identical content returns the existing id without a second copy.
 * 503 until keyed; 401 on a bad bearer; 400/413 on a bad/oversized body; 200 on
 * success or graceful degrade (`stored` flag); 500 only on an unexpected throw.
 */
export async function handleMemoryWriteRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further — this store's tenant scope is the
  // caller-asserted userId/repoId body fields, a different axis from the
  // installation-based one the resolver returns.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  if (!(await resolveApiKey(request, env))) return json({ error: "unauthorized" }, 401)

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseWriteBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  try {
    const result = await storeMemoryFact(env, parsed)
    if (result.deduped) {
      return json({ id: result.id, stored: true, deduped: true }, 200)
    }
    return json({ id: result.id, stored: result.stored, vectorStored: result.vectorStored }, 200)
  } catch (err) {
    return json({ error: "memory_write_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
}

// ─── POST /v1/memory/query — semantic retrieve ───────────────

interface QueryBody {
  userId: string
  repoId: string
  query: string
  limit?: number
}

function parseQueryBody(raw: unknown): QueryBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.userId !== "string" || b.userId.trim() === "") return "userId (non-empty string) is required"
  if (typeof b.repoId !== "string" || b.repoId.trim() === "") return "repoId (non-empty string) is required"
  if (typeof b.query !== "string" || b.query.trim() === "") return "query (non-empty string) is required"
  if (b.limit !== undefined && (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit <= 0)) {
    return "limit must be a positive integer"
  }
  return {
    userId: canonicalTenantId(b.userId),
    repoId: canonicalTenantId(b.repoId),
    query: b.query,
    ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
  }
}

/**
 * Parse a record's `ts` to epoch ms for the newest-first sort. `ts` is ISO-8601;
 * an unparseable value → 0 (sorts last under desc) so a corrupt record can't jump
 * to the top of the results.
 */
function tsMs(ts: string): number {
  const n = Date.parse(ts)
  return Number.isNaN(n) ? 0 : n
}

/**
 * POST /v1/memory/query — embed the query → Vectorize topK query (tenant
 * namespace) → hydrate records from KV → sort newest-first → return top `limit`.
 * 503 until keyed; 401 on a bad bearer; 400/413 on a bad/oversized body. SOFT:
 * any retrieval-path failure (embed / Vectorize / KV) → `{ results: [] }` (200),
 * NEVER 500; 500 only on an unexpected throw.
 */
export async function handleMemoryQueryRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further — see handleMemoryWriteRoute's comment.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  if (!(await resolveApiKey(request, env))) return json({ error: "unauthorized" }, 401)

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseQueryBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  // Fetch at least `limit` vector hits — a larger requested `limit` (up to
  // MAX_LIMIT) must not be starved by the default topK before the slice.
  const topK = Math.max(DEFAULT_TOP_K, limit)

  try {
    // Semantic hits (soft — returns [] on any embed/query failure).
    const hits = await queryMemoryIds(env, {
      userId: parsed.userId,
      repoId: parsed.repoId,
      query: parsed.query,
      topK,
    })

    // Hydrate from KV (soft — a missing/corrupt record is skipped, not fatal).
    const results: AgentMemoryQueryResult[] = []
    for (const hit of hits) {
      let record: AgentMemoryRecord | null
      try {
        record = await readRecord(env, parsed.userId, parsed.repoId, hit.id)
      } catch (err) {
        // readRecord is itself soft, but belt-and-suspenders: never let a single
        // hydrate failure collapse the whole query into a 500.
        emitTelemetry("agent-memory-hydrate-failed", {
          id: hit.id,
          err: err instanceof Error ? err.message : String(err),
        })
        record = null
      }
      if (record === null) continue
      results.push({ id: record.id, kind: record.kind, content: record.content, ts: record.ts, score: hit.score })
    }

    results.sort((a, b) => tsMs(b.ts) - tsMs(a.ts))
    return json({ results: results.slice(0, limit) }, 200)
  } catch (err) {
    // Defensive: the legs above are soft, so this only fires on a truly
    // unexpected throw. Still answer with empty results, not 500 — retrieval is
    // grounding, and an honest "no memory" beats a hard error for the agent.
    emitTelemetry("agent-memory-query-unexpected", { err: err instanceof Error ? err.message : String(err) })
    return json({ results: [] }, 200)
  }
}
