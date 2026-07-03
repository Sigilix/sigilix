// sig-training-data-consent — the master retention-mode flag resolver (pure).
//
// SIGILIX_TRAINING_RETENTION_MODE is the FEATURE-LEVEL kill switch, distinct from
// (and layered on top of) per-org consent. It exists so that — until the legal
// prerequisites are in place (see the feature README) — NOTHING is ever written
// to the training store even for a consented org. Default OFF: the gate treats
// any value other than the exact string "on" as off, so an unset/typo/blank env
// can never enable retention.

/** Retention feature mode. "on" = the store may be written (subject to consent). */
export type TrainingRetentionMode = "off" | "on"

/**
 * Resolve the master retention flag. FAIL-CLOSED: only the exact string "on"
 * (case-sensitive, trimmed) enables it; everything else — unset, "", "ON",
 * "true", "shadow", anything — is "off".
 */
export function resolveTrainingRetentionMode(env: { SIGILIX_TRAINING_RETENTION_MODE?: string }): TrainingRetentionMode {
  return env.SIGILIX_TRAINING_RETENTION_MODE?.trim() === "on" ? "on" : "off"
}
