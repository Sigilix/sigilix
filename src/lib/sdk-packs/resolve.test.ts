// SIG-298 follow-on — resolveSdkGuidance: the exact off/shadow/on decision
// assemble-prompts.ts wires directly. This is the seam "shadow detects but
// never injects" hinges on, tested without constructing the full
// assemble-prompts args surface.

import { describe, expect, it } from "vitest"

import { resolveSdkGuidance } from "./resolve"
import type { SdkPack } from "./types"

const STRIPE: SdkPack = {
  id: "stripe",
  vendor: "Stripe",
  docsUrl: "https://stripe.com/docs",
  matchers: { packages: ["stripe"], importPatterns: [] },
  rules: [{ id: "r1", title: "t", guidance: "g", severityHint: "P2" }],
}

const DIFF_WITH_STRIPE = [
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1,1 +1,2 @@",
  '+"stripe": "^14.0.0",',
].join("\n")

describe("resolveSdkGuidance", () => {
  it("off: returns no matches and no block, regardless of the diff", () => {
    const result = resolveSdkGuidance("off", DIFF_WITH_STRIPE, [STRIPE])
    expect(result.matched).toEqual([])
    expect(result.block).toBe("")
  })

  it("shadow: detects matches but never renders the injectable block", () => {
    const result = resolveSdkGuidance("shadow", DIFF_WITH_STRIPE, [STRIPE])
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]!.pack.id).toBe("stripe")
    expect(result.block).toBe("")
  })

  it("on: detects matches AND renders the injectable block", () => {
    const result = resolveSdkGuidance("on", DIFF_WITH_STRIPE, [STRIPE])
    expect(result.matched).toHaveLength(1)
    expect(result.block.length).toBeGreaterThan(0)
    expect(result.block).toContain("stripe")
  })

  it("shadow/on with no match: matches empty, block empty", () => {
    const unrelatedDiff = "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n@@ -0,0 +1,1 @@\n+export const y = 1"
    expect(resolveSdkGuidance("shadow", unrelatedDiff, [STRIPE])).toEqual({ matched: [], block: "" })
    expect(resolveSdkGuidance("on", unrelatedDiff, [STRIPE])).toEqual({ matched: [], block: "" })
  })
})
