// SIG-318 P2: precision-profile feature barrel — the ONLY legal cross-feature
// import surface. External consumers reach this feature via
// `@/features/precision-profile`; its internal layers (domain / adapters) stay
// private behind this re-export. No logic here.

export { loadPrecisionProfile, recordOutcome } from "./adapters/store"
export { applyPrecisionProfile, SUPPRESS_FLOOR_TIER } from "./domain/apply"
export { resolvePrecisionMode } from "./domain/mode"
export { BOOST_THRESHOLD, SUPPRESS_THRESHOLD, isCategoryBoosted, isPatternSuppressed } from "./domain/ema"
export type { PrecisionProfile, PrecisionMode, FindingOutcome } from "./domain/types"
