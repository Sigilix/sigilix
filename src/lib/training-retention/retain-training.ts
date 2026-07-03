// sig-training-retention-wiring — the shared call-site wrapper that offers a
// just-captured, HIGH-SIGNAL record to the consent-gated training store.
//
// WHY THIS EXISTS: the operational capture surfaces (review-memory dismissal,
// the /v1/verify oracle, the agent runner) each want to offer their data to the
// training corpus WITHOUT duplicating the flag-first no-op guard or the
// owner/repo → installationId resolution. This module centralises both and then
// hands off to `retainForTraining` — the ONE sanctioned, gated + redacting
// writer. It NEVER writes the store itself and NEVER bypasses the gate.
//
// FLAG-FIRST NO-OP (the launch-default guarantee): every function checks the
// master retention flag FIRST and returns immediately when it is off (the
// default today). The record is built LAZILY via a `build` closure, so with the
// flag off NOTHING is constructed and — for the repo variant — NO tenancy lookup
// runs. The capture path is therefore byte-identical to before this wiring when
// retention is off. The pre-check only ever early-returns `false`; it is strictly
// MORE conservative than the real gate (never more permissive), which still runs
// inside `retainForTraining` (flag AND per-org consent) and redacts before store.
//
// Best-effort: never throws — a retention fault must never break a capture path.

import { resolveTrainingRetentionMode, retainForTraining, type TrainingRecord } from "@/src/features/training-consent"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"

/**
 * Resolve the installation id for a repo the way the org-memory mirror does:
 * the LIVE, webhook-populated D1 `repo` registry first, the static
 * `OPENCLAW_GITHUB_INSTALLATION_MAP` env var second. `null` when neither
 * resolves — the caller then skips retention silently.
 *
 * PRE-FLAG-ON CORRECTNESS GATE (see the feature README): this registry is only as
 * authoritative as `upsertTenantAndRepo`, which on a `repo_id` conflict refreshes
 * `full_name` but NOT `installation_id`. After a repo transfer / reinstall the row
 * can therefore carry a STALE installation id, so retention could gate against —
 * and partition under — the wrong org. This is a pre-existing property shared with
 * the org-mirror seam and is HARMLESS while the retention flag is off (nothing is
 * written). Before the flag is ever turned on, repo-coordinate resolution MUST be
 * made authoritative (registry `installation_id` refreshed on conflict and fail-
 * closed on ambiguity, or resolution threaded from the webhook's `installation.id`).
 */
async function resolveInstallationIdForRepo(env: Env, owner: string, repo: string): Promise<number | null> {
  const fromD1 = await lookupRepoByFullName(env, `${owner}/${repo}`)
  if (fromD1) return fromD1.installationId
  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  return lookup.ok ? lookup.installationId : null
}

/**
 * Offer a record to the training store for a KNOWN installation. Flag-first:
 * returns `false` without building the record or touching consent/store I/O when
 * the retention flag is off (launch default). Otherwise builds the record and
 * hands it to `retainForTraining`, which gates (flag AND consent) then redacts
 * before storing. Returns true only when a redacted record was actually written.
 * Never throws.
 */
export async function retainTrainingRecord(
  env: Env,
  installationId: number,
  build: () => TrainingRecord,
): Promise<boolean> {
  if (resolveTrainingRetentionMode(env) !== "on") return false
  try {
    return await retainForTraining(env, installationId, build())
  } catch {
    return false
  }
}

/**
 * As {@link retainTrainingRecord}, but for a capture site that only has repo
 * coordinates: resolves owner/repo → installationId first (D1 registry, then the
 * static installation map). Same flag-first no-op guarantee — with the flag off,
 * NO tenancy lookup and NO record build happen. An unresolvable installation
 * skips retention (returns false). Never throws.
 */
export async function retainTrainingRecordForRepo(
  env: Env,
  owner: string,
  repo: string,
  build: () => TrainingRecord,
): Promise<boolean> {
  if (resolveTrainingRetentionMode(env) !== "on") return false
  try {
    const installationId = await resolveInstallationIdForRepo(env, owner, repo)
    if (installationId === null) return false
    return await retainForTraining(env, installationId, build())
  } catch {
    return false
  }
}
