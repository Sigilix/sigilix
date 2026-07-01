// Seat∪Org memory layering — Phase 1 (write side only).
//
// Additive + SHADOW-SAFE: mirrors a just-captured repo-scope learning into the
// ORG scope keyspace (`learnings:org:<installationId>`) so a later "apply org
// learnings in review" slice has a corpus to read from. Nothing reads
// `learnings:org:*` yet — retrieval, suppression, and the Memory Gardener
// decay pass are all untouched — so this write has ZERO effect on review
// behavior today.
//
// Gated behind OPENCLAW_ORG_MEMORY_CAPTURE ("off" default / "on"). Off ⇒ this
// returns immediately: no installation-id resolution, no KV read/write, no
// telemetry — the repo-scope capture call site stays byte-identical.
//
// Fail-soft, matching the rest of the capture pipeline: an unresolvable
// installation (missing/malformed OPENCLAW_GITHUB_INSTALLATION_MAP entry)
// skips the org write silently, logged, never throws. Callers invoke this
// AFTER the repo-scope `appendLearning` has already succeeded, so a failure
// here can never undo or block that write, and (being awaited inline at the
// same call sites as the repo write) never surfaces to the caller as
// anything but a resolved promise.

import { resolveOrgMemoryCaptureMode } from "@/src/features/learnings/domain/mode"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"
import { appendLearning } from "./store"

export async function mirrorLearningToOrgScope(args: {
  env: Env
  owner: string
  repo: string
  entry: LearningEntry
}): Promise<void> {
  const { env, owner, repo, entry } = args
  try {
    if (resolveOrgMemoryCaptureMode(env) === "off") return

    const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (!lookup.ok) {
      console.log(
        JSON.stringify({
          event: "org-memory-capture-skipped",
          owner,
          repo,
          learningId: entry.id,
          reason: lookup.reason,
        }),
      )
      return
    }

    const orgSubjectId = String(lookup.installationId)
    const orgEntry: LearningEntry = { ...entry, scope: "org", subjectId: orgSubjectId }
    const appended = await appendLearning(env, "org", orgSubjectId, orgEntry, Date.parse(entry.createdTs))
    console.log(
      JSON.stringify({
        event: appended ? "org-memory-capture-written" : "org-memory-capture-skipped",
        owner,
        repo,
        learningId: entry.id,
        orgSubjectId,
        ...(appended ? {} : { reason: "append-failed" }),
      }),
    )
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "org-memory-capture-failed",
        owner,
        repo,
        learningId: entry.id,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
