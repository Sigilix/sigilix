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
    const [orgStore, repoStore] = await Promise.all([
      loadLearnings(env, "org", String(installationId)),
      repoId != null ? loadLearnings(env, "repo", String(repoId)) : Promise.resolve(null),
    ])
    const orgEntries = orgStore?.entries ?? []
    const repoEntries = repoStore?.entries ?? []

    // Union deduped by id — every repo entry, then each org entry whose id is
    // NOT already present (a repo copy wins a collision, matching
    // loadEffectiveLearnings; a learning mirrored repo→org shares its
    // content-addressed id, so it applies exactly once).
    const repoIds = new Set(repoEntries.map((e) => e.id))
    const merged: LearningEntry[] = [...repoEntries, ...orgEntries.filter((e) => !repoIds.has(e.id))]

    return renderSurfaceLearningsForPrompt(merged)
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "surface-memory-apply-failed",
        installationId,
        repoId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return ""
  }
}
