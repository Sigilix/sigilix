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
// INSTALLATION RESOLUTION (fixed post-launch — see SIG org-learnings-isolation):
// prefer the LIVE, webhook-populated D1 `repo` registry
// (`lookupRepoByFullName`, `src/features/tenancy`) over the static,
// manually-curated `OPENCLAW_GITHUB_INSTALLATION_MAP` env var. The D1 row is
// upserted by every real PR webhook (`upsertTenantAndRepo`), so it is
// authoritative for any repo that has ever had a Sigilix-reviewed PR —
// exactly the repos this mirror fires for. The env-var map was built for
// callers with no webhook-derived id at all (the Linear @-mention handler,
// Slack scoping) and was never guaranteed to enumerate every installed repo;
// relying on it here as the ONLY source meant this mirror silently no-op'd
// for any repo missing from that hand-maintained list — which, in
// production, was effectively every repo (`learnings:org:*` stayed at 0 keys
// despite the flag being "on" and dozens of repo-scope learnings landing
// fine). It stays as a fallback so a repo covered only by the static map
// (no D1 row yet) still resolves.
//
// Fail-soft, matching the rest of the capture pipeline: an unresolvable
// installation (no D1 row AND no OPENCLAW_GITHUB_INSTALLATION_MAP entry, or a
// D1 error) skips the org write silently, logged, never throws. Callers
// invoke this AFTER the repo-scope `appendLearning` has already succeeded, so
// a failure here can never undo or block that write, and (being awaited
// inline at the same call sites as the repo write) never surfaces to the
// caller as anything but a resolved promise.
//
// ISOLATION INVARIANT (hard rule — do not weaken): this is the ONLY writer of
// `learnings:org:*` learning entries that mirrors an existing record (the
// other, `onboarding-memory-capture.ts`, gates its own direct org write on
// `isLinkedToInstallation`). Every caller of `mirrorLearningToOrgScope` MUST
// pass an `entry` that was captured from a PR-review surface (inline review
// reply, top-level PR comment, or a GitHub @sigilix Q&A mention) — i.e. a
// `LearningEntry` whose `source.kind` is `"inline-reply" | "top-level" | "qa"`.
// A per-user/per-seat capture (the CLI's `agent-memory:*` keyspace) must NEVER
// be routed through this function or through `appendLearning(env, "org", ...)`
// directly — seat memory and org memory are deliberately separate KV
// keyspaces (`agent-memory:*` vs `learnings:org:*`) with no shared writer, and
// that separation — not this function's fail-soft skip — is what makes a
// seat→org leak structurally impossible today. See
// `src/lib/agent-memory/agent-memory-route.isolation.test.ts` for the
// regression test (runs the real CLI seat-write path and asserts it never
// emits a `learnings:*` key).

import { resolveOrgMemoryCaptureMode } from "@/src/features/learnings/domain/mode"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import { retainForTraining } from "@/src/features/training-consent"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"
import { appendLearning } from "./store"

/**
 * Resolve the installation id to mirror an org-scope learning into. Live D1
 * `repo` registry first (real, webhook-populated), the static
 * `OPENCLAW_GITHUB_INSTALLATION_MAP` env var second. `null` when neither
 * resolves — the caller logs `org-memory-capture-skipped` and returns.
 */
async function resolveOrgMirrorInstallationId(env: Env, owner: string, repo: string): Promise<number | null> {
  const fromD1 = await lookupRepoByFullName(env, `${owner}/${repo}`)
  if (fromD1) return fromD1.installationId
  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  return lookup.ok ? lookup.installationId : null
}

export async function mirrorLearningToOrgScope(args: {
  env: Env
  owner: string
  repo: string
  entry: LearningEntry
}): Promise<void> {
  const { env, owner, repo, entry } = args
  try {
    if (resolveOrgMemoryCaptureMode(env) === "off") return

    const installationId = await resolveOrgMirrorInstallationId(env, owner, repo)
    if (installationId === null) {
      console.log(
        JSON.stringify({
          event: "org-memory-capture-skipped",
          owner,
          repo,
          learningId: entry.id,
          reason: "no_installation",
        }),
      )
      return
    }

    const orgSubjectId = String(installationId)
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

    // sig-training-data-consent WIRING SEAM (flagged-off by default). This is the
    // representative integration point: a just-captured learning is offered to the
    // consent-gated training store. `retainForTraining` is INERT here today — it
    // returns immediately without any I/O because the SIGILIX_TRAINING_RETENTION_MODE
    // master flag defaults OFF (and, even flipped on, only writes for a consenting
    // org into the SEPARATE R2 partition — never the operational learnings KV). The
    // OTHER capture surfaces the audit identified (review findings, portal/agent
    // chat, the codebase index) each have their own future seam and are deliberately
    // NOT wired in this scaffold. Best-effort; never affects the org-mirror result.
    if (appended) {
      await retainForTraining(env, installationId, {
        kind: "learning",
        id: entry.id,
        payload: entry.rule,
        meta: { owner, repo, scope: entry.scope, polarity: entry.polarity },
      })
    }
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
