import { describe, expect, it } from "vitest"
import { finalStatusUpdate } from "@/src/lib/pr-review-status-phases"

const ARGS = { owner: "o", repo: "r", prNumber: 7 } as const

describe("finalStatusUpdate proof threading (SIG-471)", () => {
  it("threads `proof` onto the posted snapshot when reviewMeta carries it", () => {
    const update = finalStatusUpdate({
      status: "posted",
      ...ARGS,
      reviewMeta: { findingsCount: 3, proof: { verified: 0, grounded: 2, model: 1 } },
    })
    expect(update).not.toBeNull()
    expect(update!.phase).toBe("posted")
    expect(update!.proof).toEqual({ verified: 0, grounded: 2, model: 1 })
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
