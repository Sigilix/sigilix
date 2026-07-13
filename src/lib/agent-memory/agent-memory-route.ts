// Agent-memory store — PUT /v1/memory + POST /v1/memory/query route handlers.
//
// The local CLI agent persists durable per-(authenticated user, repo) memories
// and retrieves the semantically-relevant ones to ground a turn. Authentication
// is checked from the header before the body read (an unauthorized caller cannot
// force a large buffer). The body userId is retained only for wire compatibility;
// it never selects the owner namespace.
//
// SOFT-FAIL BY DESIGN (spec): retrieval is grounding, not a verdict, so a
// transient backend failure must NOT 500 —
//   - QUERY: an embed/Vectorize/KV failure → `{ results: [] }` (200). 500 ONLY
//     on an unexpected throw outside the soft seams.
//   - WRITE: an embed/Vectorize failure still attempts the KV write and returns
//     200 with a `stored` flag, so the record persists even when the vector
//     leg degrades. 500 only on an unexpected throw.

import type { Env } from "@/src/shared/types/env"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { readCliAppMemoryContext, resolveAppMemoryCliMode, type AppMemoryCliMode } from "@/src/features/app-memory"
import { resolveCliOrgMemoryMode } from "@/src/features/learnings"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import type { AgentMemoryKind, AgentMemoryQueryResult, AgentMemoryRecord } from "./types"
import { ALL_AGENT_MEMORY_KINDS } from "./types"
import { readHashId, readRecord, writeHashPointer, writeRecord } from "./storage"
import { queryMemoryIds, upsertMemoryVector } from "./retrieval"
import { loadOrgMemoryForCli, unionSeatAndOrgMemory } from "./agent-memory-org-union"
import {
  canonicalTenantId,
  personalMemoryUserId,
  resolveApiPersonalMemoryUserId,
  resolveApiStableUserId,
} from "./agent-memory-personal-subject"

export { canonicalTenantId, scopeMemoryUserId } from "./agent-memory-personal-subject"

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
  // Canonicalize repoId so the KV keyspace and Vectorize namespace agree.
  // userId remains normalized only to preserve the existing parsed wire shape;
  // authenticated identity replaces it before any storage/retrieval operation.
  return { userId: canonicalTenantId(b.userId), repoId: canonicalTenantId(b.repoId), kind: b.kind, content: b.content }
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
  // Resolve a real tenant API key, then bind it to the provider-independent
  // user_identity row for its creator. Missing/unprovable identity — including
  // the legacy global key — fails closed before the body is read.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env)
  if ("response" in auth) return auth.response
  const caller = auth.caller
  const personalUserId = await resolveApiPersonalMemoryUserId(env, caller)
  if (personalUserId === null) return json({ error: "memory_identity_unavailable" }, 403)

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
    // `parsed.userId` remains a required wire field for existing CLI clients but
    // is never trusted as ownership. The authenticated identity is authoritative.
    const result = await storeMemoryFact(env, { ...parsed, userId: personalUserId })
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
  includeManagedAppContext?: boolean
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
  if (b.includeManagedAppContext !== undefined && typeof b.includeManagedAppContext !== "boolean") {
    return "includeManagedAppContext must be a boolean"
  }
  return {
    userId: canonicalTenantId(b.userId),
    repoId: canonicalTenantId(b.repoId),
    query: b.query,
    ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
    ...(typeof b.includeManagedAppContext === "boolean"
      ? { includeManagedAppContext: b.includeManagedAppContext }
      : {}),
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

function exactInstallationId(value: number): value is number {
  return Number.isSafeInteger(value) && value > 0
}

async function respondWithManagedAppContext(args: {
  env: Env
  mode: AppMemoryCliMode
  include: boolean
  installationId: number
  stableUserId: string | null
  results: AgentMemoryQueryResult[]
  legacyResponse: Response
}): Promise<Response> {
  if (args.mode === "off" || !args.include || !exactInstallationId(args.installationId)) {
    return args.legacyResponse
  }

  const read = await readCliAppMemoryContext(args.env, {
    installationId: args.installationId,
    personalUserId: args.stableUserId,
  })
  const event = args.mode === "shadow" ? "cli-app-memory-context-shadow" : "cli-app-memory-context-on"
  if (read.status === "unavailable") {
    emitTelemetry(event, {
      available: false,
      personalCandidates: 0,
      personalSelected: 0,
      personalChars: 0,
      personalTruncated: false,
      organizationCandidates: 0,
      organizationSelected: 0,
      organizationChars: 0,
      organizationTruncated: false,
    })
    return args.legacyResponse
  }

  const stats = read.selection.stats
  emitTelemetry(event, {
    available: true,
    personalCandidates: stats.personal.candidateCount,
    personalSelected: stats.personal.selectedCount,
    personalChars: stats.personal.selectedChars,
    personalTruncated: stats.personal.truncated,
    organizationCandidates: stats.organization.candidateCount,
    organizationSelected: stats.organization.selectedCount,
    organizationChars: stats.organization.selectedChars,
    organizationTruncated: stats.organization.truncated,
  })
  if (args.mode === "shadow") return args.legacyResponse
  return json({ results: args.results, appMemories: read.selection.memories }, 200)
}

/**
 * POST /v1/memory/query — embed the query → Vectorize topK query (tenant
 * namespace) → hydrate records from KV → sort newest-first → return top `limit`.
 * 503 until keyed; 401 on a bad bearer; 400/413 on a bad/oversized body. SOFT:
 * any retrieval-path failure (embed / Vectorize / KV) → `{ results: [] }` (200),
 * NEVER 500; 500 only on an unexpected throw.
 *
 * Seat∪Org memory layering — Phase 3 (CLI read side, gated by
 * OPENCLAW_CLI_ORG_MEMORY, see resolveCliOrgMemoryMode): when the flag is
 * "on", these seat-memory results are additionally unioned with the caller
 * installation's org-scope review learnings (deduped by id, seat wins a
 * collision) — see agent-memory-org-union.ts. Default "off" is byte-identical
 * to the seat-only response above; a failure anywhere in the org branch
 * degrades to the seat-only response, never throws.
 *
 * A request may additionally opt into managed CLI app memories with
 * `includeManagedAppContext: true`. OPENCLAW_APP_MEMORY_CLI_MODE keeps this
 * dark by default; shadow performs the bounded D1 read but returns the exact
 * legacy response, while on adds a separate `appMemories` array. The API-key
 * creator's durable identity selects personal rows; body userId is never used.
 */
export async function handleMemoryQueryRoute(request: Request, env: Env): Promise<Response> {
  // The authenticated API-key creator, not body userId, selects the exact
  // personal namespace. Missing/unprovable identity fails closed.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env)
  if ("response" in auth) return auth.response
  const caller = auth.caller
  const mode = resolveAppMemoryCliMode(env)
  const identity = await resolveApiStableUserId(env, caller)
  if (identity.status === "unavailable") return json({ error: "memory_identity_unavailable" }, 403)
  // Off/shadow and legacy-global behavior stays exactly as before: reject an
  // unprovable personal identity before reading the request body. Only an exact
  // installation explicitly rolled on may reach the org-only response branch.
  if (identity.userId === null && (mode !== "on" || !exactInstallationId(caller.installationId))) {
    return json({ error: "memory_identity_unavailable" }, 403)
  }

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

  if (identity.userId === null) {
    const legacyResponse = json({ error: "memory_identity_unavailable" }, 403)
    return respondWithManagedAppContext({
      env,
      mode,
      include: parsed.includeManagedAppContext === true,
      installationId: caller.installationId,
      stableUserId: null,
      results: [],
      legacyResponse,
    })
  }

  const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  // Fetch at least `limit` vector hits — a larger requested `limit` (up to
  // MAX_LIMIT) must not be starved by the default topK before the slice.
  const topK = Math.max(DEFAULT_TOP_K, limit)
  // The SAME authenticated personal subject keys BOTH the vector query and KV
  // hydrate below, or a hit would fail to resolve its record.
  const userId = personalMemoryUserId(caller.installationId, identity.userId)

  let legacyResults: AgentMemoryQueryResult[] = []
  try {
    // Semantic hits (soft — returns [] on any embed/query failure).
    const hits = await queryMemoryIds(env, {
      userId,
      repoId: parsed.repoId,
      query: parsed.query,
      topK,
    })

    // Hydrate from KV (soft — a missing/corrupt record is skipped, not fatal).
    const results: AgentMemoryQueryResult[] = []
    for (const hit of hits) {
      let record: AgentMemoryRecord | null
      try {
        record = await readRecord(env, userId, parsed.repoId, hit.id)
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
    const seatResults = results.slice(0, limit)

    // Seat∪Org memory layering — Phase 3. Isolated in its own try/catch so an
    // unexpected failure in the org branch can NEVER cost the caller its own
    // already-computed seat-memory results (loadOrgMemoryForCli already fails
    // soft internally — this is belt-and-suspenders around the mode/union logic
    // itself).
    try {
      const orgMode = resolveCliOrgMemoryMode(env)
      // OFF: seat-only, immediately — no installation check, no org KV read.
      // This is the byte-identical-to-before path.
      legacyResults = seatResults
      if (orgMode !== "off") {
        const org = await loadOrgMemoryForCli(env, caller.installationId)
        if (org.truncated) {
          emitTelemetry("cli-org-memory-truncated", {
            installationId: caller.installationId,
            kept: org.entries.length,
          })
        }

        if (orgMode === "shadow") {
          emitTelemetry("cli-org-memory-shadow", {
            installationId: caller.installationId,
            count: org.entries.length,
            ids: org.entries.map((e) => e.id),
          })
        } else {
          // ON: seat ∪ org, deduped by id (seat wins any collision), seat first.
          legacyResults = unionSeatAndOrgMemory(seatResults, org.entries)
          emitTelemetry("cli-org-memory-union", {
            installationId: caller.installationId,
            seatCount: seatResults.length,
            orgCount: org.entries.length,
            added: legacyResults.length - seatResults.length,
          })
        }
      }
    } catch (err) {
      emitTelemetry("cli-org-memory-union-failed", {
        installationId: caller.installationId,
        err: err instanceof Error ? err.message : String(err),
      })
      legacyResults = seatResults
    }
  } catch (err) {
    // Defensive: the legs above are soft, so this only fires on a truly
    // unexpected throw. Still answer with empty results, not 500 — retrieval is
    // grounding, and an honest "no memory" beats a hard error for the agent.
    emitTelemetry("agent-memory-query-unexpected", { err: err instanceof Error ? err.message : String(err) })
    legacyResults = []
  }

  const legacyResponse = json({ results: legacyResults }, 200)
  return respondWithManagedAppContext({
    env,
    mode,
    include: parsed.includeManagedAppContext === true,
    installationId: caller.installationId,
    stableUserId: identity.userId,
    results: legacyResults,
    legacyResponse,
  })
}
