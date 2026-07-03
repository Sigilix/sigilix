// sig-free-tier-entitlements — feature barrel. Cross-feature / lib callers import
// from HERE only (COMPLIANCE §2: never an internal layer path).
//
// The paid/free boundary is defined by exactly two things, both re-exported here:
// `ENTITLED_TIERS` (the tiers) and `isFeatureEntitled` (the policy). Surfaces call
// `resolveEntitlement` (the gate) and act on `decision.blocked`.
export { ENTITLED_TIERS, isFeatureEntitled, normalizePlan, type EntitledFeature } from "./domain/entitlements"
export { resolveEntitlementsMode, type EntitlementsMode } from "./domain/mode"
export { upsellFor } from "./domain/upsell"
export { readInstallationPlan } from "./adapters/d1-plan-read"
export { resolveEntitlement, type EntitlementDecision } from "./adapters/gate"
