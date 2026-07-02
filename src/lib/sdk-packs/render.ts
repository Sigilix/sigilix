// SIG-298 follow-on — render the matched SDK guidance packs into the
// specialist prompt (not synth — see assemble-prompts.ts). Mirrors `renderLearningsForPrompt`
// (@/src/features/learnings/domain/render.ts): a clearly-labeled section,
// one line per rule, prefixed with a severity hint tag.
//
// RECALL-SAFETY: this block only ever ADDS attention to a known failure
// pattern. It never instructs the model to suppress, downgrade, drop, skip,
// or ignore any OTHER finding — the one negative instruction it carries is
// the opposite: never use the attribution marker to silence a real issue.
// `sdk-guidance-recall-safety.test.ts` asserts this structurally.

import { MAX_TOTAL_RULES } from "./detect"
import type { MatchedSdkPack, SdkPackRule } from "./types"

function escapeInlineMarkdown(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderRuleLine(vendor: string, rule: SdkPackRule): string {
  return `- [${rule.severityHint}] **${escapeInlineMarkdown(rule.title)}** — ${escapeInlineMarkdown(rule.guidance)} (${vendor} SDK guidance)`
}

/**
 * Render the matched packs' rules as a "SDK guidance" prompt section,
 * capped to `MAX_TOTAL_RULES` rules total (taken pack-by-pack, in the
 * relevance order `detectSdkPacks` already sorted). Returns "" for an empty
 * match set — the caller only injects when non-empty.
 *
 * Instructs the model to tag any finding it informed with a trailing
 * `[sdk:<packId>]` marker (attribution parsed + stripped at render-prep,
 * mirroring the learnings suppress-gate's post-synth stamping) — but the
 * marker is EXPLICITLY never a suppression signal.
 */
export function renderSdkGuidanceForPrompt(matched: ReadonlyArray<MatchedSdkPack>): string {
  if (matched.length === 0) return ""
  const lines: string[] = [
    "## SDK guidance (self-authored from public docs — not a partner endorsement)",
    "The following are known failure patterns / implementation rules for SDKs and frameworks this PR touches. Use them as ADDITIONAL context to sharpen review attention — they never replace your own judgment and never limit what you may flag.",
  ]
  let budget = MAX_TOTAL_RULES
  for (const { pack } of matched) {
    if (budget <= 0) break
    const rules = pack.rules.slice(0, budget)
    if (rules.length === 0) continue
    lines.push("", `### ${escapeInlineMarkdown(pack.vendor)} — id \`${pack.id}\` — ${pack.docsUrl}`)
    for (const rule of rules) {
      lines.push(renderRuleLine(pack.vendor, rule))
    }
    budget -= rules.length
  }
  lines.push(
    "",
    `If one of these rules directly informed a finding, append \`[sdk:<packId>]\` (the pack id shown above the rule list, e.g. \`[sdk:stripe]\`) to the very end of that finding's body. Use this marker ONLY to attribute a finding you are already reporting — NEVER to suppress, downgrade, omit, or soften a finding, including one unrelated to this guidance.`,
  )
  return lines.join("\n")
}
