// sig-training-data-consent — retainForTraining: the ONLY sanctioned writer to
// the training store. It composes the guarantees in ONE place so every call site
// inherits them:
//   1. GATE  — mayRetainForTraining (master flag AND per-org consent). No-ops
//              (returns false) when the gate is closed — which is the launch
//              default, so wiring a call site in now writes NOTHING.
//   2. REDACT — redactTrainingRecord runs BEFORE the store call. The store never
//              sees an un-redacted record; the ordering is structural (redact →
//              store on the next line), not left to the caller.
//   3. STORE  — storeTrainingRecord into the per-installation R2 partition.
// Best-effort + never throws: a capture path that opts to retain must never be
// broken by a retention fault.

import { mayRetainForTraining } from "@/src/features/training-consent/adapters/gate"
import { storeTrainingRecord } from "@/src/features/training-consent/adapters/training-store"
import { redactTrainingRecord } from "@/src/features/training-consent/domain/redact"
import type { TrainingRecord } from "@/src/features/training-consent/domain/types"
import type { Env } from "@/src/shared/types/env"

/**
 * Retain one record for training IFF the gate allows it. Returns true only when a
 * (redacted) record was actually written. A no-op (returns false) when the gate
 * is closed — flag off, consent denied, or the store binding absent. Never throws.
 */
export async function retainForTraining(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TRAINING_RETENTION_MODE" | "SIGILIX_TRAINING_DATA">,
  installationId: number,
  record: TrainingRecord,
): Promise<boolean> {
  try {
    if (!(await mayRetainForTraining(env, installationId))) return false
    // REDACT before STORE — this ordering is the pre-store redaction guarantee.
    const redacted = redactTrainingRecord(record)
    return await storeTrainingRecord(env, installationId, redacted)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "training-retain-failed",
        installationId,
        kind: record.kind,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}
