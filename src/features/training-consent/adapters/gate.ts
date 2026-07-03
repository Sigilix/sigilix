// sig-training-data-consent — THE GATE. The single source of truth for whether
// an org's data MAY be retained for training. Every write to the training store
// goes through mayRetainForTraining (via retainForTraining). FAIL-CLOSED at every
// branch: the default answer is always "no".

import { readConsentRecord } from "@/src/features/training-consent/adapters/consent-store"
import { readPlanForInstallation } from "@/src/features/training-consent/adapters/plan-lookup"
import { resolveTrainingRetentionMode } from "@/src/features/training-consent/domain/mode"
import { resolveDefaultConsent } from "@/src/features/training-consent/domain/plan-default"
import type { ConsentDecision } from "@/src/features/training-consent/domain/types"
import type { Env } from "@/src/shared/types/env"

/**
 * Resolve the effective consent decision for an installation:
 *   1. an EXPLICIT row in data_learning_consent wins (granted or denied), else
 *   2. the plan-based DEFAULT (fail-closed: personal paid → granted, everything
 *      else incl. team/enterprise/unknown → denied).
 * FAIL-CLOSED: an invalid id, a missing binding, or ANY D1 error → "denied".
 * (readConsentRecord / readPlanForInstallation THROW on a real fault precisely so
 * this catch maps degradation to "denied" rather than a permissive default.)
 */
export async function resolveConsent(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<ConsentDecision> {
  if (!Number.isInteger(installationId) || installationId <= 0) return "denied"
  try {
    const record = await readConsentRecord(env, installationId)
    if (record) return record.consent
    const plan = await readPlanForInstallation(env, installationId)
    return resolveDefaultConsent(plan)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "training-consent-resolve-failed",
        installationId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return "denied"
  }
}

/**
 * The GATE: may we retain this installation's data for training RIGHT NOW?
 * Requires BOTH (a) the master retention flag = "on" AND (b) effective consent =
 * "granted". The flag is checked FIRST, so with the launch default (flag off)
 * this returns false WITHOUT even reading consent — nothing can be written to the
 * store until the flag is deliberately flipped. Never throws (resolveConsent is
 * already fail-closed).
 */
export async function mayRetainForTraining(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TRAINING_RETENTION_MODE">,
  installationId: number,
): Promise<boolean> {
  if (resolveTrainingRetentionMode(env) !== "on") return false
  return (await resolveConsent(env, installationId)) === "granted"
}
