// SIG-276 Phase 3 — structural guard: the shadow matcher output must be
// CONSUMER-LESS. A static source scan asserting the Site-2 shadow data is
// never referenced in the posting path (markers / soften / submission),
// so a future refactor cannot silently wire shadow telemetry into behavior.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const ENSEMBLE = readFileSync(
  resolve(here, "../src/lib/triage-pr-review-ensemble.ts"),
  "utf8",
)

describe("SIG-276 Phase 3 — shadow output is consumer-less (structural)", () => {
  it("the Site-2 block exists and emits review-memory-claim-shadow", () => {
    expect(ENSEMBLE).toContain('event: "review-memory-claim-shadow"')
    expect(ENSEMBLE).toContain("shadowMatchReviewMemoryClaims(")
  })

  it("`shadowRows` is block-scoped to Site 2 — never referenced at/after findingMarkers", () => {
    const findingMarkersIdx = ENSEMBLE.indexOf("const findingMarkers")
    expect(findingMarkersIdx).toBeGreaterThan(0)
    const lastShadowRows = ENSEMBLE.lastIndexOf("shadowRows")
    expect(lastShadowRows).toBeGreaterThan(0)
    // Its last mention must precede the marker-building / posting path.
    expect(lastShadowRows).toBeLessThan(findingMarkersIdx)
  })

  it("`shadowMemoriesForPhase3` is read only before the posting path (never by markers/soften/submission)", () => {
    const findingMarkersIdx = ENSEMBLE.indexOf("const findingMarkers")
    const lastHolderUse = ENSEMBLE.lastIndexOf("shadowMemoriesForPhase3")
    expect(lastHolderUse).toBeGreaterThan(0)
    expect(lastHolderUse).toBeLessThan(findingMarkersIdx)
  })

  it("the shadow event truncates headSha to 7 chars (house style)", () => {
    // Within the shadow emit block, the headSha field uses the 7-char slice.
    const shadowIdx = ENSEMBLE.indexOf('event: "review-memory-claim-shadow"')
    expect(shadowIdx).toBeGreaterThanOrEqual(0) // guard: -1 would slice misleadingly
    const window = ENSEMBLE.slice(shadowIdx, shadowIdx + 400)
    expect(window).toContain("headSha: headSha.slice(0, 7)")
  })
})
