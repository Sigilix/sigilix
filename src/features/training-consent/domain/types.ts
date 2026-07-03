// sig-training-data-consent — pure domain types for the consent-gated training store.
//
// Leaf module: no imports, no I/O. Shared by the pure resolvers (plan-default,
// redact) and the I/O adapters (consent-store, training-store, gate, retain).

/**
 * The consent decision for whether Sigilix MAY retain an org's data in the
 * long-term training corpus. Deliberately BINARY — there is no third
 * "unknown"/"pending" state that a fail-open bug could exploit. The absence of
 * an explicit record is resolved to one of these two by a fail-closed default.
 */
export type ConsentDecision = "granted" | "denied"

/** Where a persisted consent decision came from (audit / provenance). */
export type ConsentSource = "portal-admin" | "api" | "onboarding" | "system-default"

/** A persisted consent record (one row per installation in data_learning_consent). */
export interface ConsentRecord {
  installationId: number
  consent: ConsentDecision
  /** The actor who set it — an admin GitHub login, or `system:<reason>`. */
  setBy: string
  /** ISO-8601 timestamp of the last change. */
  setAt: string
  source: ConsentSource
  /** The org's resolved plan at the moment consent was recorded (audit). */
  planAtGrant: string | null
}

/**
 * The KINDS of user data that COULD feed the training corpus. Each maps to a
 * capture surface identified in the data-capture audit. Used as an R2 key
 * segment so a partition can be listed/purged per (installation, kind).
 *
 * - `review-finding` — a Sigilix finding paired with its human accept/dismiss
 *   verdict and any correction reply (the "was Sigilix right" dismissal corpus).
 * - `learning` — an extracted preference/rule (the org-memory mirror seam).
 * - `chat` — a portal/agent chat turn.
 * - `codebase-chunk` — an indexed code chunk.
 * - `fix-diff` — a before/after edit pair with the verification-oracle verdict
 *   (the /v1/verify path — the "how a flagged issue got fixed" corpus).
 * - `agent-trajectory` — an agent-runner task paired with its terminal outcome
 *   (ticket → PR-opened / no-change / error — the "what worked" corpus).
 */
export type TrainingRecordKind =
  | "review-finding"
  | "learning"
  | "chat"
  | "codebase-chunk"
  | "fix-diff"
  | "agent-trajectory"

/**
 * A single record staged for the training corpus. `payload` is arbitrary
 * capture-surface content (a finding, a learning rule, a chat turn, a code
 * chunk) that MUST pass through redaction before it is ever stored — that
 * invariant is enforced structurally by `retainForTraining`, which redacts
 * before calling the store and is the ONLY sanctioned writer.
 */
export interface TrainingRecord {
  kind: TrainingRecordKind
  /** Stable-ish id for the record (used in the object key; dedupe is best-effort). */
  id: string
  /** The raw captured text/JSON. Redacted in-place by redactTrainingRecord. */
  payload: string
  /** Optional structured context (repo, PR number, ...). Also redacted. */
  meta?: Record<string, string>
}
