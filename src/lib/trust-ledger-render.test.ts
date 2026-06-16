// SIG Trust Ledger v0 — the pure markdown emitters (Kimi's design). Covers the
// trust pill/tier mapping, the summary segment math, and the collapse-on-empty
// behaviour.

import { describe, expect, it } from "vitest"
import { trustPill, trustSubTag, renderTrustSummary } from "@/src/lib/trust-ledger-render"
import type { FindingTrust } from "@/src/lib/triage-pr-review"
import type { ReviewBadgeAssetName } from "@/src/lib/badge-assets"

// stub: return the asset name so we can assert WHICH glyph a tier maps to.
const badge = (n: ReviewBadgeAssetName): string => `<${n}>`
const t = (tier: FindingTrust["tier"], over: Partial<FindingTrust> = {}): { trust: FindingTrust } => ({
  trust: { tier, ...over },
})

describe("trustPill / trustSubTag — tier → pill (honest wording)", () => {
  it("runner-confirmed → the cyan VERIFIED runner pill (reserved for a receipt)", () => {
    expect(trustPill(t("runner-confirmed").trust, badge)).toBe("<runner-verified>")
    expect(trustSubTag(t("runner-confirmed").trust)).toBe(" · VERIFIED")
  })
  it("the grounded tiers → the slate GROUNDED pill (evidence, not proof)", () => {
    for (const tier of ["deterministic-grounded", "worker-token-confirmed", "grounded-model"] as const) {
      expect(trustPill(t(tier).trust, badge)).toBe("<trust-grounded>")
      expect(trustSubTag(t(tier).trust)).toBe(" · GROUNDED")
    }
  })
  it("body-only-ungrounded OR no trust → the muted MODEL pill (no authority)", () => {
    expect(trustPill(t("body-only-ungrounded").trust, badge)).toBe("<trust-model>")
    expect(trustPill(undefined, badge)).toBe("<trust-model>")
    expect(trustSubTag(undefined)).toBe(" · MODEL")
  })
})

describe("renderTrustSummary", () => {
  it("builds the segmented line: counts + Proof + Quiet", () => {
    const inline = [t("runner-confirmed"), t("runner-confirmed"), t("grounded-model")]
    const body = [
      t("grounded-model", { demoteReason: "outside-diff" }),
      t("body-only-ungrounded", { demoteReason: "verification-refuted" }),
    ]
    const out = renderTrustSummary({
      inlineFindings: inline,
      bodyFindings: body,
      counts: { suppressed: 4, demotedToBody: 2 },
    })
    // grounded counts ALL grounded-tier findings (the inline grounded-model + the
    // outside-diff body grounded-model) = 2; a finding can be outside-diff AND grounded.
    expect(out).toBe(
      "**5 findings** · 3 inline · 1 outside diff · 1 PR-level · **Proof**: 2 runner-verified · 2 grounded · **Quiet**: 4 suppressed · 2 demoted to body",
    )
  })

  it("collapses zero segments (no Proof / Quiet when zero)", () => {
    const out = renderTrustSummary({
      inlineFindings: [t("body-only-ungrounded")],
      bodyFindings: [],
      counts: { suppressed: 0, demotedToBody: 0 },
    })
    expect(out).toBe("**1 finding** · 1 inline")
  })

  it("returns null on a clean approve (no findings, no quiet)", () => {
    expect(
      renderTrustSummary({
        inlineFindings: [],
        bodyFindings: [],
        counts: { suppressed: 0, demotedToBody: 0 },
      }),
    ).toBeNull()
  })

  it("shows the Quiet line even with zero findings (suppressed-only review)", () => {
    expect(
      renderTrustSummary({
        inlineFindings: [],
        bodyFindings: [],
        counts: { suppressed: 3, demotedToBody: 0 },
      }),
    ).toBe("**0 findings** · **Quiet**: 3 suppressed")
  })
})
