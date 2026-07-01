// Agent-memory — Seat∪Org memory layering, slice 3 (CLI read side).
//
// Unions the caller-installation's ORG-scope review learnings into the
// AgentMemoryQueryResult shape POST /v1/memory/query already returns, so a
// developer's CLI session inherits what the team's PR reviews taught the org
// — not just that developer's own seat memory. The flagship of the Seat∪Org
// memory-layering arc (Phase 1: capture, Phase 2: PR-review apply, this
// slice: the CLI read side).
//
// Gated behind OPENCLAW_CLI_ORG_MEMORY (three-state off/shadow/on — see the
// route's own mode branch in agent-memory-route.ts and the flag's doc in
// env.ts / resolveCliOrgMemoryMode).
//
// Fail-soft, matching org-apply.ts: the LEGACY global key (no single
// installation to scope an org corpus to) or any loadLearnings error/empty
// corpus all degrade to "no org entries" — logged, never thrown, never
// blocking the seat-memory response.
//
// ADDITIVE ONLY: this module never removes or suppresses a seat-memory
// result — it only ever renders MORE context for the CLI's model to read.

import { loadLearnings, type LearningEntry } from "@/src/features/learnings"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import type { Env } from "@/src/shared/types/env"
import type { AgentMemoryQueryResult } from "./types"

// Caps how many org-learning rules get unioned into one CLI memory response —
// an additive budget, independent of the seat-memory `limit`/topK (mirrors
// MAX_LEARNINGS in api-context-route.ts).
export const MAX_ORG_MEMORY_ENTRIES = 20

/** One readable line per org rule, matching api-context-route.ts's
 *  `formatLearning` convention so the same learning reads the same way
 *  everywhere it surfaces. */
function formatOrgLearningContent(entry: LearningEntry): string {
  const tag = entry.polarity === "suppress" ? "[dismissed] " : entry.polarity === "require" ? "[required] " : ""
  const cat = entry.category ? ` (${entry.category})` : ""
  return `${tag}${entry.rule.trim()}${cat}`
}

/** Parse a learning's createdTs to epoch ms for the newest-first sort.
 *  Unparseable → 0 (sorts last), matching agent-memory-route.ts's `tsMs`. */
function learningTs(s: string): number {
  const n = Date.parse(s)
  return Number.isNaN(n) ? 0 : n
}

function toAgentMemoryResult(entry: LearningEntry): AgentMemoryQueryResult {
  return {
    // `org:` prefix keeps an org-rendered id out of the seat-memory `mem_...`
    // id space, so a dedup-by-id check can never accidentally collide the two.
    id: `org:${entry.id}`,
    kind: "preference",
    content: formatOrgLearningContent(entry),
    ts: entry.createdTs,
    // Org rules are a flat inclusion (not a Vectorize-ranked semantic hit) — 1
    // is a neutral high score so a score-sorting consumer never ranks an org
    // rule below a seat hit (the route itself appends them, it does not re-sort).
    score: 1,
  }
}

export interface OrgMemoryForCli {
  entries: AgentMemoryQueryResult[]
  truncated: boolean
}

/**
 * Merge seat-memory results with org-memory additions, deduped by id — a seat
 * result wins any collision (the CLI's own memory is authoritative over an
 * org-wide rule that happens to render the same id). Seat entries stay first,
 * in their existing order; org additions are appended in their existing
 * order. In practice a real collision can't occur (seat ids are `mem_<uuid>`,
 * org ids are rendered `org:<learningId>` — disjoint namespaces by
 * construction), but the dedup guard stays as defense-in-depth.
 */
export function unionSeatAndOrgMemory(
  seat: readonly AgentMemoryQueryResult[],
  org: readonly AgentMemoryQueryResult[],
): AgentMemoryQueryResult[] {
  const seatIds = new Set(seat.map((r) => r.id))
  const additions = org.filter((r) => !seatIds.has(r.id))
  return [...seat, ...additions]
}

/**
 * Load the caller-installation's org-scope learnings, rendered into the same
 * shape POST /v1/memory/query already returns (newest-first, capped at
 * {@link MAX_ORG_MEMORY_ENTRIES}). Never throws — an unresolvable (legacy
 * global key) installation, an empty corpus, or a KV/parse error all degrade
 * to `{ entries: [], truncated: false }`.
 */
export async function loadOrgMemoryForCli(env: Env, callerInstallationId: number): Promise<OrgMemoryForCli> {
  // The legacy global key has no single org to scope a learnings corpus to —
  // same fail-soft posture as an unresolvable installation elsewhere in the
  // Seat∪Org arc (org-apply.ts's "no_installation" skip).
  if (callerInstallationId === LEGACY_TENANT_INSTALLATION_ID) {
    return { entries: [], truncated: false }
  }
  try {
    const store = await loadLearnings(env, "org", String(callerInstallationId))
    const orgEntries = store?.entries ?? []
    const sorted = [...orgEntries].sort((a, b) => learningTs(b.createdTs) - learningTs(a.createdTs))
    const truncated = sorted.length > MAX_ORG_MEMORY_ENTRIES
    return { entries: sorted.slice(0, MAX_ORG_MEMORY_ENTRIES).map(toAgentMemoryResult), truncated }
  } catch {
    // loadLearnings never throws (its own internal try/catch) — this is
    // belt-and-suspenders against an unexpected throw in the sort/map above.
    return { entries: [], truncated: false }
  }
}
