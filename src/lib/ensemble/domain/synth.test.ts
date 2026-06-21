// SIG-484: the per-verdict synth-input cap selector. The shadow-purity contract lives
// here: `synthInputCapFor` must return the raised cap ONLY when the source-floor-low flag
// is `on` (the caller passes `flags.synthSourceFloorLow === "on"`) — never in `shadow`,
// because raising the cap changes the synth INPUT (and thus the posted review).

import { describe, expect, it } from "vitest"
import { synthInputCapFor, SPECIALIST_VERDICT_TOKEN_CAP_HIGH } from "./synth"

describe("synthInputCapFor (SIG-484)", () => {
  it("off/shadow (floorLowOn=false) → default cap (undefined = 8k)", () => {
    // The caller passes `=== "on"`, so off AND shadow both arrive here as false → 8k.
    // This is the load-bearing shadow-purity guard: shadow must NOT raise the cap.
    expect(synthInputCapFor(false, false)).toBeUndefined()
  })

  it("on (floorLowOn=true) → the bounded HIGH cap", () => {
    expect(synthInputCapFor(false, true)).toBe(SPECIALIST_VERDICT_TOKEN_CAP_HIGH)
  })

  it("multi-batch uncaps (Infinity), winning over the floor-low flag", () => {
    expect(synthInputCapFor(true, false)).toBe(Number.POSITIVE_INFINITY)
    expect(synthInputCapFor(true, true)).toBe(Number.POSITIVE_INFINITY)
  })

  it("the HIGH cap is a BOUNDED raise, not removal (per the DeepSeek sign-off)", () => {
    expect(Number.isFinite(SPECIALIST_VERDICT_TOKEN_CAP_HIGH)).toBe(true)
    expect(SPECIALIST_VERDICT_TOKEN_CAP_HIGH).toBe(16_000)
  })
})
