// SIG-298 follow-on — renderSdkGuidanceForPrompt: empty-input contract, the
// ≤12-total-rule cap across matched packs, and the id/vendor/docsUrl surface
// the model needs to emit an attribution marker.

import { describe, expect, it } from "vitest"

import { renderSdkGuidanceForPrompt } from "./render"
import { MAX_TOTAL_RULES } from "./detect"
import type { MatchedSdkPack, SdkPack, SdkPackRule } from "./types"

function rule(id: string): SdkPackRule {
  return { id, title: `Title ${id}`, guidance: `Guidance for ${id}.`, severityHint: "P2" }
}

function pack(id: string, ruleCount: number): SdkPack {
  return {
    id,
    vendor: `Vendor ${id}`,
    docsUrl: `https://example.com/${id}`,
    matchers: { packages: [id], importPatterns: [] },
    rules: Array.from({ length: ruleCount }, (_, i) => rule(`${id}-r${i}`)),
  }
}

function matched(p: SdkPack): MatchedSdkPack {
  return { pack: p, matchedPaths: ["src/a.ts"] }
}

describe("renderSdkGuidanceForPrompt", () => {
  it("returns empty string for no matched packs", () => {
    expect(renderSdkGuidanceForPrompt([])).toBe("")
  })

  it("renders the pack id, vendor, and docs url so the model can emit an attribution marker", () => {
    const block = renderSdkGuidanceForPrompt([matched(pack("stripe", 2))])
    expect(block).toContain("Vendor stripe")
    expect(block).toContain("`stripe`")
    expect(block).toContain("https://example.com/stripe")
    expect(block).toContain("[sdk:<packId>]")
  })

  it("renders every rule for a single matched pack under the total cap", () => {
    const block = renderSdkGuidanceForPrompt([matched(pack("stripe", 3))])
    expect(block).toContain("Title stripe-r0")
    expect(block).toContain("Title stripe-r1")
    expect(block).toContain("Title stripe-r2")
  })

  it("caps total rendered rules at MAX_TOTAL_RULES across multiple matched packs", () => {
    // Two packs whose combined rule count exceeds the cap.
    const p1 = pack("a", 8)
    const p2 = pack("b", 8)
    const block = renderSdkGuidanceForPrompt([matched(p1), matched(p2)])
    const ruleLineCount = (block.match(/^- \[P\d\]/gm) ?? []).length
    expect(ruleLineCount).toBe(MAX_TOTAL_RULES)
    // First pack's rules are fully rendered (8 <= 12); the remainder of the
    // budget (4) goes to the second pack's first 4 rules.
    for (let i = 0; i < 8; i++) expect(block).toContain(`Title a-r${i}`)
    for (let i = 0; i < 4; i++) expect(block).toContain(`Title b-r${i}`)
    expect(block).not.toContain("Title b-r4")
  })

  it("severity hint tag prefixes each rule line", () => {
    const block = renderSdkGuidanceForPrompt([matched(pack("stripe", 1))])
    expect(block).toMatch(/^- \[P2\] \*\*Title stripe-r0\*\*/m)
  })
})
