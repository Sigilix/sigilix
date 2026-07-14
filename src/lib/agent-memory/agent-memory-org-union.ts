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
// PRECEDENCE is FLAG-GATED (OPENCLAW_SURFACE_MEMORY_APPLY — the SAME flag #946/#947
// reuse; see unionSeatAndOrgMemory):
//   - off (default) — SEAT-WINS, additive-only: seat first, org appended, a seat
//                     result winning any id collision. Byte-identical to before.
//   - on            — ORG-PRECEDENCE (founder decision): an org guardrail is
//                     inviolable. Org first + labeled authoritative; a seat entry
//                     that conflicts with an org rule (same id OR same content) is
//                     DROPPED; the surviving seat entries follow, labeled as
//                     applying only where they do not conflict with org policy. A
//                     seat preference can ADD non-conflicting context but can NEVER
//                     override, weaken, or suppress an org guardrail.

import { loadLearnings, type LearningEntry, type SurfaceMemoryApplyMode } from "@/src/features/learnings"
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

// ON-mode precedence labels. The org label marks a guardrail INVIOLABLE; the seat
// label matches the portal-chat wording (agent-memory-chat-surface.ts's
// renderSeatMemoryForPrompt) so a seat preference reads as subordinate to org
// policy the same way everywhere it surfaces.
const ORG_AUTHORITATIVE_LABEL = "[org policy — inviolable]"
const SEAT_SUBORDINATE_LABEL = "[your preference — applies only where it does not conflict with org policy]"

/**
 * Normalize content for a seat↔org collision check: drop a leading `[tag] `
 * (e.g. an org rule's `[required] `) and fold case + surrounding whitespace, so a
 * seat preference that RESTATES an org rule collides even when only the polarity
 * tag differs. Used only in ON (org-precedence) mode.
 */
function normalizeForCollision(content: string): string {
  return content
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim()
    .toLowerCase()
}

/**
 * Merge seat-memory results with org-memory additions. Precedence is FLAG-GATED on
 * OPENCLAW_SURFACE_MEMORY_APPLY (`mode`; the SAME flag #946/#947 reuse), so one flag
 * flips the whole apply-everywhere program:
 *
 *   - "off" (default) — SEAT-WINS, additive-only, byte-identical to before this
 *     slice: seat entries stay first in their existing order; org additions are
 *     appended, each org entry whose id is NOT already present (a seat result wins
 *     any id collision). Contents are untouched.
 *
 *   - "on" — ORG-PRECEDENCE (founder decision — org guardrails are inviolable): org
 *     entries come FIRST, relabeled authoritative; a seat entry that CONFLICTS with
 *     an org rule — same id OR same (tag-stripped) content — is DROPPED; the
 *     surviving seat entries follow, relabeled as applying only where they do not
 *     conflict with org policy. A seat preference can ADD non-conflicting context
 *     but can never override, weaken, or suppress an org guardrail.
 *
 * In practice a real id collision can't occur (seat ids are `mem_<uuid>`, org ids
 * are rendered `org:<learningId>` — disjoint namespaces by construction); the
 * id/content collision guards stay as defense-in-depth for the inviolable-org
 * property. STRUCTURAL SAFETY (both modes): a seat entry is a free-text
 * `AgentMemoryQueryResult` (no learnings `polarity`), so it can never be a
 * `polarity:"suppress"/"require"` learning and can never reach
 * `decideLearningSuppressions` — a seat preference can only add context.
 */
export function unionSeatAndOrgMemory(
  seat: readonly AgentMemoryQueryResult[],
  org: readonly AgentMemoryQueryResult[],
  mode: SurfaceMemoryApplyMode = "off",
): AgentMemoryQueryResult[] {
  if (mode === "on") {
    // ORG-PRECEDENCE: org first + authoritative label; a conflicting seat entry is
    // dropped (org wins by id OR by tag-stripped content); the rest follow, labeled
    // subordinate.
    const orgIds = new Set(org.map((r) => r.id))
    const orgContents = new Set(org.map((r) => normalizeForCollision(r.content)))
    const seatKept = seat.filter((r) => !orgIds.has(r.id) && !orgContents.has(normalizeForCollision(r.content)))
    return [
      ...org.map((r) => ({ ...r, content: `${ORG_AUTHORITATIVE_LABEL} ${r.content}` })),
      ...seatKept.map((r) => ({ ...r, content: `${SEAT_SUBORDINATE_LABEL} ${r.content}` })),
    ]
  }
  // OFF (default): SEAT-WINS, additive-only — preserved byte-for-byte.
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
