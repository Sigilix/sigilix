// SIG-298 follow-on — "SDK guidance packs" v1 barrel.

export type { SdkPack, SdkPackMatchers, SdkPackRule, SdkPacksMode, MatchedSdkPack } from "./types"
export { resolveSdkPacksMode } from "./mode"
export { detectSdkPacks, MAX_MATCHED_PACKS, MAX_TOTAL_RULES } from "./detect"
export { renderSdkGuidanceForPrompt } from "./render"
export { resolveSdkGuidance } from "./resolve"
export type { ResolveSdkGuidanceResult } from "./resolve"
export { parseSdkGuidanceMarkers } from "./attribution"
export type { ParsedSdkGuidanceMarkers } from "./attribution"
export { SDK_PACKS } from "./packs/index"
