// SIG-298 follow-on — the SDK guidance ATTRIBUTION gate (app layer). Mirrors
// `learnings-suppress-prep.ts`'s shape: this adapts the post-synth kept
// finding set to the pure `parseSdkGuidanceMarkers` domain core and stamps
// the render-prep-only `sdkGuidance` attribution field.
//
// Unlike the learnings suppress gate (which re-derives attribution
// DETERMINISTICALLY from stored rule text), SDK guidance can't be re-derived
// post-hoc — a pack rule is prompt-level context the model may or may not
// have actually used. So the model is instructed (in
// `renderSdkGuidanceForPrompt`) to self-report by appending a
// `[sdk:<packId>]` marker to a finding's body. This gate parses that marker
// out of every kept finding's body, strips it from the user-visible text
// (never leak raw marker syntax to the PR), and — only for a marker whose
// packId matches a pack that was ACTUALLY injected into this review's
// context — stamps `finding.sdkGuidance` for the renderer's quiet
// attribution line.
//
// RECALL-SAFETY: this gate only ever strips a marker and/or adds an
// attribution stamp. It never removes, demotes, or otherwise changes a
// finding's severity/content — there is no suppression path here, unlike
// the learnings suppress gate.
//
// `off`/`shadow` ⇒ no-op, byte-identical output (the guidance section was
// never injected in either mode, so no marker is expected in either). `on`
// ⇒ strip + attribute.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseSdkGuidanceMarkers } from "@/src/lib/sdk-packs/attribution"
import { resolveSdkPacksMode } from "@/src/lib/sdk-packs/mode"
import type { MatchedSdkPack } from "@/src/lib/sdk-packs/types"
import type { Env } from "@/src/shared/types/env"

export interface ApplySdkGuidanceAttributionArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  /** The post-suppression kept findings. Stamping `sdkGuidance` mutates these in place — same runtime-only-field convention `applyLearningSuppressions` uses for `shapedByLearning`. */
  kept: PrReviewFinding[]
  /** The packs `assembleSpecialistPrompts` actually injected into this review's prompts. Empty in off/shadow, or when detection matched nothing. */
  matchedSdkPacks: readonly MatchedSdkPack[]
}

/**
 * Parse + strip `[sdk:<packId>]` markers from every kept finding's body, and
 * stamp `sdkGuidance` attribution when the referenced pack was actually
 * injected into this review. Best-effort — never throws (a parse issue on
 * one finding just leaves its body untouched).
 */
export function applySdkGuidanceAttribution(args: ApplySdkGuidanceAttributionArgs): PrReviewFinding[] {
  const { env, owner, repo, prNumber, kept, matchedSdkPacks } = args
  const mode = resolveSdkPacksMode(env.OPENCLAW_SDK_PACKS_MODE)
  if (mode !== "on") return kept

  const packById = new Map(matchedSdkPacks.map((m) => [m.pack.id, m.pack]))
  let attributedCount = 0
  for (const finding of kept) {
    if (typeof finding.body !== "string" || finding.body.length === 0) continue
    const { text, packIds } = parseSdkGuidanceMarkers(finding.body)
    if (text === finding.body) continue
    finding.body = text
    // First matched pack id wins — one attribution line per finding, matching
    // the learnings suppress gate's one-attribution-per-finding convention.
    const attributedPack = packIds.map((id) => packById.get(id)).find((p) => p !== undefined)
    if (attributedPack) {
      finding.sdkGuidance = {
        packId: attributedPack.id,
        vendor: attributedPack.vendor,
        docsUrl: attributedPack.docsUrl,
      }
      attributedCount++
    }
  }
  if (attributedCount > 0) {
    console.log(
      JSON.stringify({
        event: "sdk-guidance-attributed",
        owner,
        repo,
        prNumber,
        mode,
        matchedPacks: matchedSdkPacks.map((m) => m.pack.id),
        attributedCount,
      }),
    )
  }
  return kept
}
