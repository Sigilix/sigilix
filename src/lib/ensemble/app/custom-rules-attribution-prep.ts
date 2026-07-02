// Config-as-code — the custom-rule ATTRIBUTION gate (app layer). Mirrors
// `sdk-guidance-attribution-prep.ts`'s shape: this adapts the post-synth kept
// finding set to the pure `parseCustomRuleMarkers` domain core and stamps the
// render-prep-only `repoRule` attribution field.
//
// A custom rule is prompt-level context the model may or may not have actually
// used, so it can't be re-derived post-hoc (unlike the learnings suppress
// gate, which re-derives attribution deterministically). The model is
// instructed (in `renderCustomRulesForPrompt`) to self-report by appending a
// `[repo-rule:<id>]` marker to a finding's body. This gate parses that marker
// out of every kept finding's body, strips it from the user-visible text
// (never leak raw marker syntax to the PR), and — only for a marker whose id
// matches a rule that was ACTUALLY injected into this review's context —
// stamps `finding.repoRule` for the renderer's quiet attribution line.
//
// RECALL-SAFETY: this gate only ever strips a marker and/or adds an
// attribution stamp. It never removes, demotes, or otherwise changes a
// finding's severity/content — there is no suppression path here.
//
// `off` ⇒ no-op, byte-identical output (the rules section was never injected).
// `on` ⇒ strip + attribute.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseCustomRuleMarkers } from "@/src/shared/domain/config/custom-rules-attribution"
import { resolveConfigAsCodeMode } from "@/src/lib/sigilix-config"
import type { MatchedSigilixCustomRule } from "@/src/lib/sigilix-config"
import type { Env } from "@/src/shared/types/env"

export interface ApplyCustomRuleAttributionArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  /** The post-suppression kept findings. Stamping `repoRule` mutates these in place — same runtime-only-field convention `applySdkGuidanceAttribution` uses for `sdkGuidance`. */
  kept: PrReviewFinding[]
  /** The rules `assembleSpecialistPrompts` actually injected into this review's prompts. Empty in off, or when nothing matched. */
  matchedCustomRules: readonly MatchedSigilixCustomRule[]
}

/**
 * Parse + strip `[repo-rule:<id>]` markers from every kept finding's body, and
 * stamp `repoRule` attribution when the referenced rule was actually injected
 * into this review. Best-effort — never throws (a parse issue on one finding
 * just leaves its body untouched).
 */
export function applyCustomRuleAttribution(args: ApplyCustomRuleAttributionArgs): PrReviewFinding[] {
  const { env, owner, repo, prNumber, kept, matchedCustomRules } = args
  const mode = resolveConfigAsCodeMode(env)
  if (mode !== "on") return kept

  const ruleById = new Map(matchedCustomRules.map((m) => [m.rule.id, m.rule]))
  let attributedCount = 0
  for (const finding of kept) {
    if (typeof finding.body !== "string" || finding.body.length === 0) continue
    const { text, ruleIds } = parseCustomRuleMarkers(finding.body)
    if (text === finding.body) continue
    finding.body = text
    // First matched rule id wins — one attribution line per finding, mirroring
    // the SDK-guidance gate's one-attribution-per-finding convention.
    const attributedRule = ruleIds.map((id) => ruleById.get(id)).find((r) => r !== undefined)
    if (attributedRule) {
      finding.repoRule = { id: attributedRule.id, rule: attributedRule.rule }
      attributedCount++
    }
  }
  if (attributedCount > 0) {
    console.log(
      JSON.stringify({
        event: "custom-rule-attributed",
        owner,
        repo,
        prNumber,
        mode,
        matchedRuleIds: matchedCustomRules.map((m) => m.rule.id),
        attributedCount,
      }),
    )
  }
  return kept
}
