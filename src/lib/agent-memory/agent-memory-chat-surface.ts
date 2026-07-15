// Surface memory apply — the READ side for the PORTAL CHAT answer path.
//
// The portal agent chat (`agent-portal-route.ts` — composer + run) captures no
// memory of its own, and until this slice it READ none either: an org guardrail
// an admin taught, a repo fact, or the signed-in developer's OWN seat
// conventions never shaped a portal-chat run's prompt. This closes that gap for
// the PRIVATE portal surface.
//
// SCOPE — this is the ONE surface that also applies SEAT memory. Slack/Linear are
// SHARED channels, so `renderSurfaceMemoryForPrompt` (org∪repo only) is correct
// there — a seat memory must never leak to another person. The portal chat is
// single-signed-in-user, so it additionally applies THAT user's OWN seat memory
// (their `agent-memory:*` records), and no one else's.
//
// PRECEDENCE (founder decision — org guardrails are inviolable):
//   1. ORG guardrails  — "[org policy — must follow]"  (highest; from #946)
//   2. REPO facts      — repo-scope learnings           (middle; from #946)
//   3. SEAT preferences — "[your preference — applies only where it does not
//                          conflict with org policy]"   (lowest)
// Enforced BOTH by render order + explicit labels the model reads AND
// STRUCTURALLY: seat content is free-text `AgentMemoryRecord` (a decision /
// preference), NEVER a learnings entry with `polarity:"suppress"/"require"`, so
// it can never reach `decideLearningSuppressions` — a seat preference can only
// ADD non-conflicting context, it can never suppress or require a finding.
//
// Gated behind OPENCLAW_SURFACE_MEMORY_APPLY ("off" default / "on"), the SAME
// flag #946 reuses. Off ⇒ this returns "" immediately: no KV read, no injection.
//
// Fail-soft: every leg (org∪repo, seat) degrades to "" on any error — the chat
// answer proceeds WITHOUT memory, never blocked. Never throws.
//
// Cross-tenant: `installationId` + `repo` are the session-authorized target the
// route already proved the caller controls (`userControlsRepo`); the seat
// `userId` is derived from the trusted session identity — never message content.

import { applySurfaceMemory, resolveSurfaceMemoryApplyMode, type MemoryProvenance } from "@/src/features/learnings"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import type { AuthedSession } from "@/src/lib/auth-middleware"
import type { Env } from "@/src/shared/types/env"
import { resolveSessionStableUserId } from "./agent-memory-crud-route"
import { personalMemoryUserId } from "./agent-memory-personal-subject"
import { listRecords } from "./storage"
import type { AgentMemoryRecord } from "./types"

// Cap on how many seat memories are rendered into one chat prompt — an additive
// budget bounding the prompt (mirrors MAX_ORG_MEMORY_ENTRIES in
// agent-memory-org-union.ts). Newest-first, so a busy user's latest conventions win.
export const MAX_SEAT_MEMORY_ENTRIES = 20
// KV list page size for the seat read — one bounded page is enough (we render at
// most MAX_SEAT_MEMORY_ENTRIES); KV's per-call max is 1000.
const SEAT_LIST_LIMIT = 100

/** Parse a record's ISO ts to epoch ms for the newest-first sort. Unparseable →
 *  0 (sorts last), matching agent-memory-org-union.ts's `learningTs`. */
function recordTs(s: string): number {
  const n = Date.parse(s)
  return Number.isNaN(n) ? 0 : n
}

/**
 * Render the signed-in user's OWN seat memories as a LOWEST-precedence prompt
 * block. Pure. Returns "" for []. Every line carries the explicit precedence
 * caveat label so the model reads seat as subordinate to the org/repo guidance
 * above it. Seat content is plain free-text context — it NEVER emits a
 * learnings polarity tag ([require]/[suppress-as-context]), so it structurally
 * cannot suppress or require a finding.
 */
export function renderSeatMemoryForPrompt(records: ReadonlyArray<AgentMemoryRecord>): string {
  if (records.length === 0) return ""
  const ordered = [...records].sort((a, b) => recordTs(b.ts) - recordTs(a.ts)).slice(0, MAX_SEAT_MEMORY_ENTRIES)
  return [
    "## Your personal conventions (seat memory)",
    "These are your own preferences. An org policy above always takes precedence — apply a personal convention only where it does not conflict with org policy.",
    ...ordered.map(
      (r) => `- [your preference — applies only where it does not conflict with org policy] ${r.content.trim()}`,
    ),
  ].join("\n")
}

/**
 * Load the signed-in caller's OWN seat memory for the authorized installation,
 * rendered as the lowest-precedence prompt block. Returns "" when the session
 * has no resolvable stable identity, when there is nothing to apply, or on any
 * read fault. Never throws. Reads ONLY the caller's own
 * `agent-memory:inst:<installationId>:user:<stableUserId>:` keyspace — a seat
 * memory is never read for any other user, and never surfaces on a shared
 * (Slack/Linear) surface.
 */
async function loadSeatMemoryBlock(env: Env, installationId: number, session: AuthedSession): Promise<string> {
  try {
    const stableUserId = await resolveSessionStableUserId(env, session)
    if (!stableUserId) return ""
    const userId = personalMemoryUserId(installationId, stableUserId)
    // The caller's own personal keyspace, exactly (crud-route's personalPrefix).
    const prefix = `agent-memory:${userId}:`
    const { records } = await listRecords(env, prefix, { limit: SEAT_LIST_LIMIT })
    return renderSeatMemoryForPrompt(records)
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "chat-surface-seat-memory-failed",
        installationId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return ""
  }
}

/**
 * The assembled memory a portal-chat run should apply. `block` is the prompt text
 * (the applied grounding); `provenance` is the display-only "show your work" summary
 * of the applied org∪repo learnings (only when SIGILIX_MEMORY_PROVENANCE is on).
 */
export interface ChatSurfaceMemory {
  block: string
  /**
   * Display-only #955-shape provenance for the applied ORG∪REPO learnings. Seat
   * memory is `AgentMemoryRecord` (not a `LearningEntry`), so it is not represented
   * in this LearningEntry-based shape — a follow-up may extend the vocabulary.
   */
  provenance?: MemoryProvenance
}

/**
 * The org∪repo∪(own-seat) memory block a portal-chat run's prompt should carry,
 * with ORG guardrails labeled/ordered above repo facts above the caller's own
 * seat preferences. `block` is "" when the flag is off (a true no-op: no KV read),
 * when there is nothing to apply, or on any load failure. Never throws.
 *
 * `installationId` is the numeric GitHub App installation the session was already
 * authorized to control; `repo` is that same authorized `owner/name`. The numeric
 * repo id (the repo-scope learnings subject) is resolved from D1 — a repo with no
 * row yet contributes org+seat alone. `session` is the trusted portal session the
 * caller's seat identity is derived from.
 */
export async function renderChatSurfaceMemoryForPrompt(args: {
  env: Env
  installationId: number
  repo: { owner: string; name: string }
  session: AuthedSession
}): Promise<ChatSurfaceMemory> {
  const { env, installationId, repo, session } = args
  // OFF: no KV read, no seat read, no injection — byte-identical to before.
  if (resolveSurfaceMemoryApplyMode(env) === "off") return { block: "" }

  // ORG∪REPO — reuse #946's helper (org labeled above repo). ONE read yields both
  // the applied block AND its display-only provenance, so the note can never describe
  // a different set than the block. Guard the D1 lookup outside its own try/catch so a
  // lookup fault degrades to org-only / "" (and no provenance).
  let orgRepoBlock = ""
  let provenance: MemoryProvenance | undefined
  try {
    const repoLookup = await lookupRepoByFullName(env, `${repo.owner}/${repo.name}`)
    const applied = await applySurfaceMemory({ env, installationId, repoId: repoLookup?.repoId ?? null })
    orgRepoBlock = applied.block
    provenance = applied.provenance
  } catch {
    orgRepoBlock = ""
  }

  // SEAT — the signed-in caller's OWN preferences, lowest precedence.
  const seatBlock = await loadSeatMemoryBlock(env, installationId, session)

  // Order reinforces the labels: org∪repo (org first) above the seat block.
  const block = [orgRepoBlock, seatBlock].filter((b) => b !== "").join("\n\n")

  // `provenance` (org∪repo only) is undefined when SIGILIX_MEMORY_PROVENANCE is off →
  // no field on the wire → byte-identical response. Seat memory is a separate record
  // type not represented in this LearningEntry-based shape. Display-only, never gates.
  return { block, ...(provenance ? { provenance } : {}) }
}
