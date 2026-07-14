// Agent-memory — personal-convention read for the CLI query path.
//
// A signed-in user's repo-agnostic "My conventions" (written by the portal's
// session-authed POST /v1/memory, #950) live under the reserved sentinel repoId
// (PERSONAL_CONVENTION_REPO_ID = "*"), which means their vectors sit in the
// `<userId>/*` Vectorize NAMESPACE — a different namespace than the
// `<userId>/<repoId>` one POST /v1/memory/query is scoped to. This module is the
// deferred dual-namespace read-union: it semantically queries the caller's OWN
// sentinel namespace and hydrates the hits, so a personal convention surfaces in
// the CLI regardless of which repo the session is in.
//
// Gated by the caller on OPENCLAW_SURFACE_MEMORY_APPLY (the single flag the
// apply-everywhere program rides — #946/#947/#948 reuse it): off (default) means
// this module is never called (no sentinel query, byte-identical response).
//
// SEAT ISOLATION: `userId` is the SAME authenticated personal subject
// (`inst:<installationId>:user:<stableUserId>`) the route derived for the seat
// query — never body-supplied — and the Vectorize namespace + KV keyspace are
// both keyed by it, so this read can only ever surface the caller's OWN
// conventions.
//
// Fail-soft, matching the seat query's contract: an embed/query/hydrate failure
// degrades to "no conventions" (telemetered by the underlying soft seams), never
// throws, never costs the caller its repo-scoped seat results.

import type { Env } from "@/src/shared/types/env"
import { PERSONAL_CONVENTION_REPO_ID } from "./agent-memory-personal-subject"
import { queryMemoryIds } from "./retrieval"
import { readRecord } from "./storage"
import type { AgentMemoryQueryResult, AgentMemoryRecord } from "./types"

// Caps how many personal conventions get unioned into one CLI memory response —
// an additive budget, independent of the seat-memory `limit`/topK (mirrors
// MAX_ORG_MEMORY_ENTRIES in agent-memory-org-union.ts and
// MAX_SEAT_MEMORY_ENTRIES in agent-memory-chat-surface.ts).
export const MAX_PERSONAL_CONVENTION_ENTRIES = 20

/** Parse a record's ISO ts to epoch ms for the newest-first sort. Unparseable →
 *  0 (sorts last), matching agent-memory-route.ts's `tsMs`. */
function recordTs(s: string): number {
  const n = Date.parse(s)
  return Number.isNaN(n) ? 0 : n
}

export interface PersonalConventionMemory {
  entries: AgentMemoryQueryResult[]
  truncated: boolean
}

/**
 * Semantic query over the caller's OWN repo-agnostic personal-convention bucket
 * (the `<userId>/*` sentinel namespace), hydrated from KV and rendered in the
 * same shape POST /v1/memory/query already returns (newest-first, capped at
 * {@link MAX_PERSONAL_CONVENTION_ENTRIES}). Never throws — an embed/query/KV
 * failure degrades to `{ entries: [], truncated: false }` (the underlying seams
 * telemeter their own failures).
 */
export async function loadPersonalConventionMemoryForCli(
  env: Env,
  args: { userId: string; query: string; topK: number },
): Promise<PersonalConventionMemory> {
  try {
    // Soft — returns [] on any embed/query failure.
    const hits = await queryMemoryIds(env, {
      userId: args.userId,
      repoId: PERSONAL_CONVENTION_REPO_ID,
      query: args.query,
      topK: args.topK,
    })

    // Hydrate from the sentinel KV bucket (soft — a missing/corrupt record is
    // skipped, not fatal; readRecord validates ownership by key construction).
    const results: AgentMemoryQueryResult[] = []
    for (const hit of hits) {
      let record: AgentMemoryRecord | null
      try {
        record = await readRecord(env, args.userId, PERSONAL_CONVENTION_REPO_ID, hit.id)
      } catch {
        record = null
      }
      if (record === null) continue
      results.push({ id: record.id, kind: record.kind, content: record.content, ts: record.ts, score: hit.score })
    }

    results.sort((a, b) => recordTs(b.ts) - recordTs(a.ts))
    // Structurally unreachable via the route today (its topK is capped at
    // MAX_LIMIT = 20 = this cap) — kept as defense-in-depth against a future
    // topK bump, unit-tested directly with an oversized topK.
    const truncated = results.length > MAX_PERSONAL_CONVENTION_ENTRIES
    return { entries: results.slice(0, MAX_PERSONAL_CONVENTION_ENTRIES), truncated }
  } catch {
    // The legs above are soft; belt-and-suspenders against an unexpected throw
    // in the sort/slice — a convention read must never cost the seat response.
    return { entries: [], truncated: false }
  }
}

/**
 * Merge the repo-scoped seat results with the caller's personal conventions —
 * ADDITIVE only: seat results stay first in their existing order (the `limit`
 * budget untouched); conventions are appended, each convention whose id is not
 * already present (a seat result wins any id collision — impossible in practice
 * since both are distinct `mem_<uuid>`s, kept as defense-in-depth). Both sides
 * are SEAT scope (the same user's own memory), so no precedence label applies
 * here — org precedence is applied downstream by `unionSeatAndOrgMemory`, which
 * sees the merged array as `seat` and therefore labels/conflict-drops a
 * convention against an org guardrail exactly like any other seat entry.
 */
export function mergeSeatAndConventionMemory(
  seat: readonly AgentMemoryQueryResult[],
  conventions: readonly AgentMemoryQueryResult[],
): AgentMemoryQueryResult[] {
  const seatIds = new Set(seat.map((r) => r.id))
  const additions = conventions.filter((r) => !seatIds.has(r.id))
  return [...seat, ...additions]
}
