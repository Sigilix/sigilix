// SIG-298 follow-on — formatSdkGuidanceAttribution: the quiet <sub>
// provenance line rendered under a finding the model tagged with SDK
// guidance, mirroring formatLearningAttribution's shape.

import { describe, expect, it } from "vitest"

import { formatSdkGuidanceAttribution } from "./finding-format"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/checkout.ts",
    line: 10,
    score: 4,
    category: "security",
    headline: "h",
    body: "b",
    ...overrides,
  } as PrReviewFinding
}

describe("formatSdkGuidanceAttribution", () => {
  it("returns empty string when the finding has no sdkGuidance attribution", () => {
    expect(formatSdkGuidanceAttribution(finding())).toBe("")
  })

  it("renders the vendor and docs url in a quiet <sub> line", () => {
    const f = finding({ sdkGuidance: { packId: "stripe", vendor: "Stripe", docsUrl: "https://stripe.com/docs" } })
    const rendered = formatSdkGuidanceAttribution(f)
    expect(rendered).toContain("<sub>")
    expect(rendered).toContain("via Stripe SDK guidance")
    expect(rendered).toContain("https://stripe.com/docs")
  })

  it("HTML-escapes the vendor field", () => {
    const f = finding({ sdkGuidance: { packId: "x", vendor: "<script>alert(1)</script>", docsUrl: "https://x.com" } })
    const rendered = formatSdkGuidanceAttribution(f)
    expect(rendered).not.toContain("<script>")
    expect(rendered).toContain("&lt;script&gt;")
  })

  it("never claims a partner/endorsement relationship", () => {
    const f = finding({ sdkGuidance: { packId: "stripe", vendor: "Stripe", docsUrl: "https://stripe.com/docs" } })
    const rendered = formatSdkGuidanceAttribution(f).toLowerCase()
    expect(rendered).not.toMatch(/\bpartner/)
    expect(rendered).not.toMatch(/\bendorse/)
  })
})
