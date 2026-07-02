// #155 onboarding-backend slice 3 FOUNDER ADDENDUM — feed the portal setup
// wizard's answers into the EXISTING learnings store as initial repo/org
// memory context, instead of letting them sit inert in the onboarding KV
// blob (onboarding-submit-route.ts).
//
// Only three fields feed memory — marketing data (fullName, challenges,
// companySize, hearAbout, model) is NEVER written to a learning:
//   repoDescriptions[fullName] -> REPO-scope learning
//     ("Repo context (from onboarding): <description>")
//   links[] {from,label,to}    -> ORG-scope learning
//     ("Cross-repo: <from> <label> <to> (from onboarding)")
//   conventions                -> ORG-scope learning
//     ("Team conventions (from onboarding): <text>")
//
// SCOPING (security-critical — "never let one session write another org's
// scope"): a repo's memory is only written when BOTH hold:
//   (a) the platform DB has a `repo` row for that full_name — the PR
//       webhook upserts this table (d1-tenant-store.ts), so a repo picked
//       in the wizard before its first PR simply has no row yet, and we
//       skip it (soft-fail, same race auth-setup-route.ts already accepts
//       for the `tenant` row) rather than guess an installation_id, and
//   (b) the session's githubUserId is linked to that repo's
//       installation_id via `account_tenant` (isLinkedToInstallation — the
//       SAME fail-closed authorization check POST/DELETE /v1/keys already
//       uses). The installation_id NEVER comes from client input — it is
//       always read back from the `repo` row the platform DB owns, so a
//       forged full_name can at worst resolve to a repo the caller
//       genuinely controls (isLinkedToInstallation still gates it) or to
//       nothing at all (lookup miss -> skip).
// Org-scope writes (links, conventions) fan out to every DISTINCT
// installation_id that at least one AUTHORIZED repoDescriptions entry
// resolved to in this same call — there's no other signal for "which org"
// a cross-repo link belongs to. If nothing resolved, org-scope writes are
// skipped entirely.
//
// IDEMPOTENT: every entry's id is `computeLearningId(normalizedRule)` — a
// content hash — and `appendLearning` upserts by id (store-ops.ts's
// `upsertEntry` replaces the existing entry's `lastAppliedTs`/`appliedCount`
// on an id collision instead of duplicating), so re-submitting the
// identical wizard answers is a no-op duplication-wise.
//
// BEST-EFFORT: every write here is wrapped so a learnings-store or D1
// failure is logged and swallowed — it can never fail the onboarding POST,
// which has already durably stored the raw payload by the time this runs.

import { appendLearning, classifyLearningMemory, computeLearningId, normalizeRule } from "@/src/features/learnings"
import type { LearningEntry } from "@/src/features/learnings"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import { isLinkedToInstallation } from "@/src/lib/api-key-store"
import type { OnboardingPayload } from "@/src/lib/onboarding-submit-route"
import type { Env } from "@/src/shared/types/env"

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

async function writeLearning(
  env: Env,
  scope: "repo" | "org",
  subjectId: string,
  rawRule: string,
  authorLogin: string,
): Promise<void> {
  const rule = normalizeRule(rawRule)
  if (rule.length === 0) return
  const id = await computeLearningId(rule)
  const createdTs = new Date().toISOString()
  const { type, lifespanAnchor } = classifyLearningMemory({ sourceKind: "command", polarity: "context" })
  const entry: LearningEntry = {
    id,
    rule,
    polarity: "context",
    category: null,
    pathGlob: null,
    scope,
    subjectId,
    // "command" is the closest existing LearningSourceKind for a
    // human-authored, durable statement (see classify.ts) — the
    // onboarding provenance itself is carried in the rule text
    // ("... (from onboarding)"), matching the plain-language tagging
    // convention every other capture surface in this feature uses.
    source: { kind: "command" },
    createdTs,
    appliedCount: 0,
    authorLogin,
    type,
    lifespanAnchor,
  }
  const appended = await appendLearning(env, scope, subjectId, entry, Date.parse(createdTs))
  log(appended ? "onboarding-memory-capture-written" : "onboarding-memory-capture-skipped", {
    scope,
    subjectId,
    learningId: id,
    ...(appended ? {} : { reason: "append-failed" }),
  })
}

/**
 * Resolve + authorize one wizard-selected repo. Returns its installationId
 * only when BOTH the `repo` row exists AND the caller's session is linked
 * to that installation — otherwise null (skip, logged).
 */
async function resolveAuthorizedRepo(
  env: Env,
  githubUserId: number,
  fullName: string,
): Promise<{ repoId: number; installationId: number } | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  const found = await lookupRepoByFullName(env, fullName)
  if (!found) {
    log("onboarding-memory-capture-skipped", { fullName, reason: "repo-not-registered" })
    return null
  }
  const authorized = await isLinkedToInstallation(env.SIGILIX_PLATFORM_DB, String(githubUserId), found.installationId)
  if (!authorized) {
    log("onboarding-memory-capture-skipped", {
      fullName,
      installationId: found.installationId,
      reason: "not-linked-to-installation",
    })
    return null
  }
  return found
}

/**
 * Best-effort — never throws, never affects the caller's response. See the
 * file header for the field-by-field mapping + the security-critical
 * scoping rule.
 */
export async function captureOnboardingMemory(
  env: Env,
  githubUserId: number,
  payload: OnboardingPayload,
): Promise<void> {
  try {
    const authorLogin = String(githubUserId)
    const authorizedInstallationIds = new Set<number>()

    const repoDescriptions = payload.repoDescriptions ?? {}
    for (const [fullName, description] of Object.entries(repoDescriptions)) {
      if (!description || description.trim().length === 0) continue
      const resolved = await resolveAuthorizedRepo(env, githubUserId, fullName)
      if (!resolved) continue
      authorizedInstallationIds.add(resolved.installationId)
      await writeLearning(
        env,
        "repo",
        String(resolved.repoId),
        `Repo context (from onboarding): ${description}`,
        authorLogin,
      )
    }

    if (authorizedInstallationIds.size === 0) {
      const hasOrgContent = (payload.links?.length ?? 0) > 0 || Boolean(payload.conventions?.trim())
      if (hasOrgContent) {
        log("onboarding-memory-capture-skipped", { reason: "no-authorized-installation-for-org-scope" })
      }
      return
    }

    for (const installationId of authorizedInstallationIds) {
      const orgSubjectId = String(installationId)
      for (const link of payload.links ?? []) {
        await writeLearning(
          env,
          "org",
          orgSubjectId,
          `Cross-repo: ${link.from} ${link.label} ${link.to} (from onboarding)`,
          authorLogin,
        )
      }
      const conventions = payload.conventions?.trim()
      if (conventions) {
        await writeLearning(env, "org", orgSubjectId, `Team conventions (from onboarding): ${conventions}`, authorLogin)
      }
    }
  } catch (error) {
    log("onboarding-memory-capture-failed", { err: error instanceof Error ? error.message : String(error) })
  }
}
