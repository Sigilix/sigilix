// Surface memory apply — the READ side for Slack + Linear ANSWERS.
//
// Slack Q&A (`runQa`) and Linear mention-reply CAPTURE instructive learnings
// into the ORG-scope corpus, but until this slice they never READ them back —
// so a guardrail an admin taught in Slack/Linear never shaped a Slack/Linear
// answer. This closes that gap: it loads the org ∪ repo learnings and renders
// them as a prompt block the answer path injects.
//
// SCOPE (deliberately narrow): ORG + REPO scope ONLY. SEAT/personal memory is
// NEVER read here — these are SHARED channels, and a seat memory must never
// leak to another person. (Seat∪org for the private CLI/chat surfaces is a
// separate gate, `resolveCliOrgMemoryMode`.)
//
// Gated behind OPENCLAW_SURFACE_MEMORY_APPLY ("off" default / "on"). Off ⇒ this
// returns "" immediately: no KV read, no injection — the answer stays
// byte-identical to today. This is what lets it ship dark and be flipped later.
//
// Fail-soft, matching org-apply.ts / org-mirror.ts: `loadLearnings` never throws
// (internal try/catch → null), and any unexpected throw here degrades to ""
// (answer WITHOUT memory) — logged, never thrown, never blocks the answer.
//
// Cross-tenant: `installationId` and `repoId` are resolved by the CALLER from
// the trusted scope / installation mapping (never from message content), so a
// Slack channel / Linear team only ever loads ITS installation's memory.

import { resolveSurfaceMemoryApplyMode } from "@/src/features/learnings/domain/mode"
import { resolveAppliedMemoryProvenance, type MemoryProvenance } from "@/src/features/learnings/domain/provenance"
import { renderSurfaceLearningsForPrompt } from "@/src/features/learnings/domain/render"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"
import { loadLearnings } from "./store"

/**
 * Load + render the org ∪ repo learnings a Slack / Linear answer should apply,
 * as a prompt block. Returns "" when the flag is off (a true no-op: no KV read),
 * when there is nothing to apply, or on any load failure. Never throws.
 *
 * `repoId` is the NUMERIC GitHub repo id (the repo-scope learnings subject id);
 * pass `null` when it can't be resolved (a repo with no D1 row yet) — the block
 * then carries org-scope learnings alone. `installationId` is the org-scope
 * learnings subject id.
 */
export async function renderSurfaceMemoryForPrompt(args: {
  env: Env
  installationId: number
  repoId: number | null
}): Promise<string> {
  const { env, installationId, repoId } = args
  // OFF: no KV read, no injection — byte-identical to before this slice.
  if (resolveSurfaceMemoryApplyMode(env) === "off") return ""

  try {
    const merged = await loadSurfaceMergedEntries(env, installationId, repoId)
    return renderSurfaceLearningsForPrompt(merged)
  } catch (err) {
    logSurfaceMemoryFailure("surface-memory-apply-failed", installationId, repoId, err)
    return ""
  }
}

/**
 * Load the SAME org ∪ repo applied set `renderSurfaceMemoryForPrompt` renders — the
 * single source of truth for "what memory shaped this surface answer". Union deduped
 * by id (a repo copy wins a collision), matching `loadEffectiveLearnings`; a learning
 * mirrored repo→org shares its content-addressed id, so it applies exactly once.
 */
async function loadSurfaceMergedEntries(
  env: Env,
  installationId: number,
  repoId: number | null,
): Promise<LearningEntry[]> {
  const [orgStore, repoStore] = await Promise.all([
    loadLearnings(env, "org", String(installationId)),
    repoId != null ? loadLearnings(env, "repo", String(repoId)) : Promise.resolve(null),
  ])
  const orgEntries = orgStore?.entries ?? []
  const repoEntries = repoStore?.entries ?? []
  const repoIds = new Set(repoEntries.map((e) => e.id))
  return [...repoEntries, ...orgEntries.filter((e) => !repoIds.has(e.id))]
}

/** The applied org ∪ repo memory for a surface: the rendered prompt block plus its
 *  display-only #955-shape provenance (present only when the flag is on). */
export interface SurfaceMemoryApplied {
  block: string
  provenance?: MemoryProvenance
}

/**
 * Apply the org ∪ repo surface memory in ONE read: render the prompt block AND — from
 * the SAME merged set — its display-only "show your work" provenance. Because the block
 * and the provenance come from one load, the note can never describe a different set
 * than the answer actually applied (no re-read, no TOCTOU).
 *
 * `block` is "" when the apply gate is off (a true no-op: no KV read), when there is
 * nothing to apply, or on any load failure. `provenance` is present only when
 * `SIGILIX_MEMORY_PROVENANCE` is "on" AND the applied set is non-empty; otherwise
 * absent → byte-identical to before.
 *
 * RECALL-SAFETY: `provenance` is DISPLAY-ONLY — it is derived from `merged` and never
 * gates/reorders/suppresses what `block` renders; a `suppress`-polarity rule is counted
 * but its text is never surfaced (see `buildMemoryProvenance`). Fail-soft: any load
 * fault degrades to `{ block: "" }` (never throws — memory must never block an answer).
 */
export async function applySurfaceMemory(args: {
  env: Env
  installationId: number
  repoId: number | null
}): Promise<SurfaceMemoryApplied> {
  const { env, installationId, repoId } = args
  // OFF: no KV read, no injection — byte-identical to before this slice.
  if (resolveSurfaceMemoryApplyMode(env) === "off") return { block: "" }

  try {
    const merged = await loadSurfaceMergedEntries(env, installationId, repoId)
    const block = renderSurfaceLearningsForPrompt(merged)
    // Provenance from the SAME merged set — flag-gated (undefined when off).
    const provenance = resolveAppliedMemoryProvenance(env, merged)
    return { block, ...(provenance ? { provenance } : {}) }
  } catch (err) {
    logSurfaceMemoryFailure("surface-memory-apply-failed", installationId, repoId, err)
    return { block: "" }
  }
}

function logSurfaceMemoryFailure(event: string, installationId: number, repoId: number | null, err: unknown): void {
  console.log(
    JSON.stringify({
      event,
      installationId,
      repoId,
      err: err instanceof Error ? err.message : String(err),
    }),
  )
}
