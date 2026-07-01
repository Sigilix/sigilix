// Seat∪Org memory layering — Phase 2 (apply/read side).
//
// The ONE union seam. Every PR-review call site that used to read repo-scope
// learnings directly (`loadLearnings(env, "repo", repoId)`) now goes through
// this loader, so the repo→org union is decided in exactly one place — the
// three call sites (prompt injection, synth block, suppress gate) stay a
// one-line swap and never fork the apply/dedup logic.
//
// Gated behind OPENCLAW_ORG_MEMORY_APPLY (three-state off/shadow/on):
//   - "off"   — return repo-scope entries ONLY, immediately: no installation-id
//               resolution, NO `learnings:org:*` KV read. Byte-identical to
//               pre-slice-2 behavior (the critical property this preserves).
//   - "shadow"— ALSO load the org corpus + resolve the installation, LOG the
//               delta (which org learnings WOULD widen the set), but return the
//               repo-scope entries UNCHANGED (bake the signal, output unchanged).
//   - "on"    — return repo ∪ org, deduped by id (a repo copy wins a collision).
//
// Fail-soft, matching org-mirror.ts: an unresolvable installation or ANY
// unexpected throw degrades to repo-only — logged, never thrown, never blocks
// or delays the review. loadLearnings itself never throws (internal try/catch),
// so the only guard needed is around resolveInstallation + the merge.

import { resolveOrgMemoryApplyMode } from "@/src/features/learnings/domain/mode"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"
import { loadLearnings } from "./store"

/**
 * Load the effective learnings set a PR review should apply — repo-scope alone
 * (the default), or repo ∪ org-scope when OPENCLAW_ORG_MEMORY_APPLY is "on".
 * The union is deduped by learning id with the repo copy winning a collision,
 * so a learning mirrored repo→org (which shares its content-addressed id)
 * applies exactly once. Never throws.
 */
export async function loadEffectiveLearnings(args: {
  env: Env
  owner: string
  repo: string
  repoId: number
  prNumber?: number
}): Promise<LearningEntry[]> {
  const { env, owner, repo, repoId, prNumber } = args

  const repoStore = await loadLearnings(env, "repo", String(repoId))
  const repoEntries = repoStore?.entries ?? []

  const mode = resolveOrgMemoryApplyMode(env)
  // OFF: repo-only, immediately — no installation resolution, no org KV read.
  // This is the byte-identical-to-before path.
  if (mode === "off") return repoEntries

  try {
    const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (!lookup.ok) {
      console.log(
        JSON.stringify({
          event: "org-learnings-apply-skipped",
          owner,
          repo,
          prNumber,
          mode,
          reason: lookup.reason,
          repoCount: repoEntries.length,
        }),
      )
      return repoEntries
    }

    const installationId = lookup.installationId
    const orgStore = await loadLearnings(env, "org", String(installationId))
    const orgEntries = orgStore?.entries ?? []

    // Union deduped by id: every repo entry first, then each org entry whose id
    // is NOT already present (repo wins a collision). `additions` is the delta —
    // the org entries that actually widen the set (the shadow signal).
    const repoIds = new Set(repoEntries.map((e) => e.id))
    const additions = orgEntries.filter((e) => !repoIds.has(e.id))
    const merged = [...repoEntries, ...additions]

    if (mode === "shadow") {
      console.log(
        JSON.stringify({
          event: "org-learnings-apply-shadow",
          owner,
          repo,
          prNumber,
          mode: "shadow",
          orgSubjectId: installationId,
          repoCount: repoEntries.length,
          orgCount: orgEntries.length,
          wouldAdd: additions.length,
          addedIds: additions.map((e) => e.id),
          addedCategories: [...new Set(additions.map((e) => e.category).filter((c) => c != null))],
        }),
      )
      // Shadow NEVER changes the applied set — return repo-only.
      return repoEntries
    }

    // ON: apply the union.
    console.log(
      JSON.stringify({
        event: "org-learnings-apply-union",
        owner,
        repo,
        prNumber,
        mode: "on",
        orgSubjectId: installationId,
        repoCount: repoEntries.length,
        orgCount: orgEntries.length,
        added: additions.length,
        addedIds: additions.map((e) => e.id),
      }),
    )
    return merged
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "org-learnings-apply-failed",
        owner,
        repo,
        prNumber,
        mode,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return repoEntries
  }
}
