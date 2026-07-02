// SIG-298 follow-on — the single mode-gated decision point assemble-prompts.ts
// calls: given the rollout mode, the diff, and the pack registry, decide which
// packs matched AND whether to render the injectable prompt block. Extracted
// as a pure function (rather than inlined at the call site) so the off/shadow/on
// contract — the exact thing "shadow detects but never injects" hinges on — is
// directly unit-testable without constructing the full assemble-prompts args.

import { detectSdkPacks } from "./detect"
import { renderSdkGuidanceForPrompt } from "./render"
import type { MatchedSdkPack, SdkPack, SdkPacksMode } from "./types"

export interface ResolveSdkGuidanceResult {
  /** Matched packs — populated in shadow AND on (shadow needs them for telemetry). Empty in off. */
  matched: MatchedSdkPack[]
  /** The renderable prompt section — non-empty ONLY in `on` mode with a match. */
  block: string
}

export function resolveSdkGuidance(
  mode: SdkPacksMode,
  diff: string,
  packs: readonly SdkPack[],
): ResolveSdkGuidanceResult {
  if (mode === "off") return { matched: [], block: "" }
  const matched = detectSdkPacks(diff, packs)
  if (matched.length === 0) return { matched, block: "" }
  return { matched, block: mode === "on" ? renderSdkGuidanceForPrompt(matched) : "" }
}
