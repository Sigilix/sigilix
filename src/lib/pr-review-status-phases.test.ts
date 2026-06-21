import { describe, expect, it } from "vitest"
import { finalStatusUpdate } from "@/src/lib/pr-review-status-phases"

const ARGS = { owner: "o", repo: "r", prNumber: 7 } as const

describe("finalStatusUpdate proof threading (SIG-471)", () => {
  it("threads `proof` onto the posted snapshot when reviewMeta carries it", () => {
    const update = finalStatusUpdate({
      status: "posted",
      ...ARGS,
      reviewMeta: { findingsCount: 3, proof: { verified: 0, reproduced: 0, grounded: 2, model: 1 } },
    })
    expect(update).not.toBeNull()
    expect(update!.phase).toBe("posted")
    expect(update!.proof).toEqual({ verified: 0, reproduced: 0, grounded: 2, model: 1 })
  })

  it("omits `proof` from the snapshot when reviewMeta has none", () => {
    const update = finalStatusUpdate({
      status: "posted",
      ...ARGS,
      reviewMeta: { findingsCount: 0 },
    })
    expect(update).not.toBeNull()
    expect(update!.proof).toBeUndefined()
    expect("proof" in update!).toBe(false)
  })

  it("omits `proof` when reviewMeta itself is absent", () => {
    const update = finalStatusUpdate({ status: "posted", ...ARGS })
    expect(update).not.toBeNull()
    expect(update!.proof).toBeUndefined()
  })
})

describe("finalStatusUpdate skip footer (SIG-475)", () => {
  it("returns null for an empty-delta skip (skipped + no reviewMeta) so the prior footer is preserved", () => {
    // The incremental empty-delta skip posts no review + carries no reviewMeta; it
    // MUST NOT overwrite the prior review's footer (real count + Manage) with a
    // misleading "Skipped · 0 findings". Reverting the guard returns a snapshot here.
    expect(finalStatusUpdate({ status: "skipped", ...ARGS })).toBeNull()
  })

  it("STILL renders a skipped footer for a first-run skip that carries reviewMeta (label-gate / cost-governor)", () => {
    const update = finalStatusUpdate({ status: "skipped", ...ARGS, reviewMeta: { findingsCount: 0 } })
    expect(update).not.toBeNull()
    expect(update!.phase).toBe("skipped")
  })
})
