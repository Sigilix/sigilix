// SIG-304 (review CLI) Phase 1b — DRIFT GUARD: the re-declared CLI palette must
// stay byte-identical to the canonical badge-assets.ts colors. We assert each hex
// appears in the corresponding baked badge SVG (getBadgeSvg is the only exported
// accessor; the style tables themselves are module-private). If badge-assets
// recolours and the palette isn't updated, these tests fail.

import { describe, it, expect } from "vitest"
import { getBadgeSvg } from "@/src/lib/badge-assets"
import type { ReviewBadgeAssetName } from "@/src/lib/badge-assets"
import { SEVERITY_HEX, TRUST_HEX, CATEGORY_HEX, CATEGORY_FALLBACK } from "./palette"

// Assert on the exact `fill="#HEX"` attribute (rect fill = bg/accent, path fill =
// fg) rather than a bare hex substring, so a coincidental occurrence elsewhere in
// the SVG (or a bg/fg swap) can't produce a false pass.
const fill = (hex: string): string => `fill="${hex}"`

describe("palette drift guard vs badge-assets", () => {
  it("severity accents match the badge SVGs", () => {
    expect(getBadgeSvg("p0")).toContain(fill(SEVERITY_HEX.P0))
    expect(getBadgeSvg("p1")).toContain(fill(SEVERITY_HEX.P1))
    expect(getBadgeSvg("p2")).toContain(fill(SEVERITY_HEX.P2))
    expect(getBadgeSvg("p3")).toContain(fill(SEVERITY_HEX.P3))
  })

  it("trust accents match the badge SVGs (VERIFIED is the runner pill)", () => {
    expect(getBadgeSvg("runner-verified")).toContain(fill(TRUST_HEX.VERIFIED))
    expect(getBadgeSvg("trust-reproduced")).toContain(fill(TRUST_HEX.REPRODUCED))
    expect(getBadgeSvg("trust-grounded")).toContain(fill(TRUST_HEX.GROUNDED))
    expect(getBadgeSvg("trust-model")).toContain(fill(TRUST_HEX.MODEL))
  })

  it("category bg (rect) + fg (text) match the badge SVGs", () => {
    for (const [name, { bg, fg }] of Object.entries(CATEGORY_HEX)) {
      const svg = getBadgeSvg(name as ReviewBadgeAssetName)
      expect(svg, `${name} bg`).toContain(fill(bg))
      expect(svg, `${name} fg`).toContain(fill(fg))
    }
  })

  it("CATEGORY_FALLBACK stays locked to the docs category", () => {
    expect(CATEGORY_FALLBACK).toEqual(CATEGORY_HEX.docs)
  })
})
