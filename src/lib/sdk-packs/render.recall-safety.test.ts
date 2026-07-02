// SIG-298 follow-on — recall-safety: the SDK guidance prompt section may
// only ADD attention to a finding; it must never instruct the model to
// suppress, drop, downgrade, omit, skip, or ignore ANY finding — including
// one the attribution marker doesn't apply to. Structural test on the
// rendered template itself (not on model behavior).

import { describe, expect, it } from "vitest"

import { renderSdkGuidanceForPrompt } from "./render"
import { SDK_PACKS } from "./packs/index"
import type { MatchedSdkPack } from "./types"

// Phrases that would instruct the model to withhold or weaken a finding.
// A hit here on the rendered block (outside of an explicit "never do X"
// negation) would be a recall-safety regression.
const DISMISSAL_PATTERNS = [
  /\bsuppress(?:es|ed|ing)?\b/i,
  /\bdo not (?:report|flag|surface|mention)\b/i,
  /\bskip (?:reporting|flagging|this (?:finding|issue))\b/i,
  /\bignore (?:this|that|the) (?:finding|issue|bug)\b/i,
  /\bdowngrade\b/i,
  /\bomit\b/i,
  /\bsoften\b/i,
  /\blower the (?:severity|score)\b/i,
]

function allMatchedPacks(): MatchedSdkPack[] {
  return SDK_PACKS.map((pack) => ({ pack, matchedPaths: ["src/a.ts"] }))
}

describe("renderSdkGuidanceForPrompt — recall safety", () => {
  it("contains an explicit non-suppression instruction for the attribution marker", () => {
    const block = renderSdkGuidanceForPrompt(allMatchedPacks())
    expect(block).toMatch(/NEVER[\s\S]*?suppress/i)
  })

  it("never instructs the model to suppress, downgrade, omit, or ignore ANY finding", () => {
    const block = renderSdkGuidanceForPrompt(allMatchedPacks())
    // Strip the one sentence that legitimately discusses suppression (in
    // the negative — "NEVER ... suppress") before scanning for dismissal
    // language elsewhere in the block.
    const withoutSafetyClause = block.replace(/If one of these rules[\s\S]*$/, "")
    for (const pattern of DISMISSAL_PATTERNS) {
      expect(withoutSafetyClause).not.toMatch(pattern)
    }
  })

  it("frames the guidance as additive context, not a directive that limits review scope", () => {
    const block = renderSdkGuidanceForPrompt(allMatchedPacks())
    expect(block).toMatch(/ADDITIONAL context/i)
    expect(block).toMatch(/never (?:replace|limit)/i)
  })

  it("every individual pack rule's guidance text avoids dismissal language", () => {
    for (const pack of SDK_PACKS) {
      for (const rule of pack.rules) {
        for (const pattern of DISMISSAL_PATTERNS) {
          expect(rule.guidance).not.toMatch(pattern)
        }
      }
    }
  })
})
