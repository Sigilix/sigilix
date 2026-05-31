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

// The marker-building declaration is the "start of the posting path" landmark
// the ordering guards anchor on. One lookup, validated once (CodeRabbit #257).
function findingMarkersIdx(): number {
  const idx = ENSEMBLE.indexOf("findingMarkers: Array<string | null>")
  expect(idx).toBeGreaterThan(0)
  return idx
}

describe("SIG-276 Phase 3 — shadow output is consumer-less (structural)", () => {
  it("the Site-2 block exists and emits review-memory-claim-shadow", () => {
    expect(ENSEMBLE).toContain('event: "review-memory-claim-shadow"')
    expect(ENSEMBLE).toContain("shadowMatchReviewMemoryClaims(")
  })

  it("`shadowRows` is block-scoped to Site 2 — never referenced at/after findingMarkers", () => {
    const lastShadowRows = ENSEMBLE.lastIndexOf("shadowRows")
    expect(lastShadowRows).toBeGreaterThan(0)
    // Its last mention must precede the marker-building / posting path.
    expect(lastShadowRows).toBeLessThan(findingMarkersIdx())
  })

  it("`shadowMemoriesForPhase3` is read only before the posting path (never by markers/soften/submission)", () => {
    const lastHolderUse = ENSEMBLE.lastIndexOf("shadowMemoriesForPhase3")
    expect(lastHolderUse).toBeGreaterThan(0)
    expect(lastHolderUse).toBeLessThan(findingMarkersIdx())
  })

  it("the shadow event truncates headSha to 7 chars (house style)", () => {
    // Within the shadow emit block, the headSha field uses the 7-char slice.
    const shadowIdx = ENSEMBLE.indexOf('event: "review-memory-claim-shadow"')
    expect(shadowIdx).toBeGreaterThanOrEqual(0) // guard: -1 would slice misleadingly
    const window = ENSEMBLE.slice(shadowIdx, shadowIdx + 400)
    expect(window).toContain("headSha: headSha.slice(0, 7)")
  })

  it("SIG-280: the durable shadow KV write lives in the Site-2 block (before the posting path)", () => {
    const markersIdx = findingMarkersIdx()
    // Anchor on the exact KV key expression for the durable corpus record.
    const kvKeyIdx = ENSEMBLE.indexOf("review-memory-claim-shadow:${reverseTs}")
    expect(kvKeyIdx).toBeGreaterThanOrEqual(0) // durable corpus record exists
    expect(kvKeyIdx).toBeLessThan(markersIdx) // gated block, not posting path
    // shadowEvent (the durable payload) must be fully contained in the Site-2
    // block: it appears (build + log + KV put) and NEVER at/after findingMarkers.
    const lastShadowEvent = ENSEMBLE.lastIndexOf("shadowEvent")
    expect(lastShadowEvent).toBeGreaterThanOrEqual(0)
    expect(lastShadowEvent).toBeLessThan(markersIdx)
  })
})
