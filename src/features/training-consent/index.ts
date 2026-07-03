// sig-training-data-consent — feature barrel. Cross-feature / lib callers import
// from HERE only (COMPLIANCE §1: never an internal path).
//
// DELIBERATELY does NOT export the raw store writer (`storeTrainingRecord`) or its
// key helpers: the ONLY public write path is `retainForTraining`, which is gated
// (flag + consent) and redacts first. Keeping the ungated writer feature-internal
// (only its own adapters/tests reach it) removes any way for a future caller to
// write the training store while bypassing the consent gate.
export { readConsentRecord, upsertConsentRecord } from "./adapters/consent-store"
export { readPlanForInstallation } from "./adapters/plan-lookup"
export { mayRetainForTraining, resolveConsent } from "./adapters/gate"
export { retainForTraining } from "./adapters/retain"
export { purgeTrainingData } from "./adapters/training-store"
export { resolveTrainingRetentionMode } from "./domain/mode"
export type { TrainingRetentionMode } from "./domain/mode"
export { OPT_OUT_PLANS, normalizePlan, resolveDefaultConsent } from "./domain/plan-default"
export { redactText, redactTrainingRecord } from "./domain/redact"
export type { ConsentDecision, ConsentRecord, ConsentSource, TrainingRecord, TrainingRecordKind } from "./domain/types"
