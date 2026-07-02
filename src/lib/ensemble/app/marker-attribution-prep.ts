// Post-synth self-tag MARKER ATTRIBUTION step (app layer).
//
// Both the SDK-guidance packs (`[sdk:<packId>]`) and the config-as-code custom
// rules (`[repo-rule:<id>]`) let a specialist self-report which prompt-injected
// guidance shaped a finding by appending a marker to that finding's body. This
// helper runs both attribution gates over BOTH renderable scopes (the anchored
// `precisionKept` set AND the body-only `renderableUnanchoredRaw` set) so a
// marker never leaks into either surface, and returns the (possibly re-stamped)
// `precisionKept` array.
//
// Pure/sync composition of `applySdkGuidanceAttribution` +
// `applyCustomRuleAttribution` — carved out of render-prep verbatim (same calls,
// same order) to keep that phase file within its size budget. Each gate is a
// no-op unless its own mode flag is `on`; neither ever drops a finding.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { MatchedSdkPack } from "@/src/lib/sdk-packs"
import type { MatchedSigilixCustomRule } from "@/src/lib/sigilix-config"
import { applySdkGuidanceAttribution } from "./sdk-guidance-attribution-prep"
import { applyCustomRuleAttribution } from "./custom-rules-attribution-prep"

export interface ApplyMarkerAttributionsArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  /** The anchored kept set — re-stamped in place and returned. */
  precisionKept: PrReviewFinding[]
  /** The body-only renderable set — stamped in place (a marker must never leak here either). */
  renderableUnanchoredRaw: PrReviewFinding[]
  /** Packs actually injected into this review (undefined ⇒ none). */
  matchedSdkPacks?: readonly MatchedSdkPack[]
  /** Custom rules actually injected into this review (undefined ⇒ none). */
  matchedCustomRules?: readonly MatchedSigilixCustomRule[]
}

/**
 * Run the SDK-guidance + custom-rule attribution gates over both renderable
 * scopes and return the re-stamped `precisionKept` array. Never throws; never
 * changes either array's length. Accepts the full render-prep args object
 * (extra props ignored) so the call site stays a single spread.
 */
export function applyMarkerAttributions(a: ApplyMarkerAttributionsArgs): PrReviewFinding[] {
  const { env, owner, repo, prNumber, renderableUnanchoredRaw } = a
  const matchedSdkPacks = a.matchedSdkPacks ?? []
  const matchedCustomRules = a.matchedCustomRules ?? []
  let precisionKept = a.precisionKept
  // BOTH scopes — a marker must never leak into a body-only comment either.
  precisionKept = applySdkGuidanceAttribution({ env, owner, repo, prNumber, kept: precisionKept, matchedSdkPacks })
  applySdkGuidanceAttribution({ env, owner, repo, prNumber, kept: renderableUnanchoredRaw, matchedSdkPacks })
  precisionKept = applyCustomRuleAttribution({ env, owner, repo, prNumber, kept: precisionKept, matchedCustomRules })
  applyCustomRuleAttribution({ env, owner, repo, prNumber, kept: renderableUnanchoredRaw, matchedCustomRules })
  return precisionKept
}
