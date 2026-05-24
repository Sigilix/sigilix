import { describe, expect, it } from "vitest"
import { mapWithConcurrency } from "../src/lib/bounded-concurrency"

describe("mapWithConcurrency", () => {
  it("preserves input order while limiting active tasks", async () => {
    let active = 0
    let maxActive = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return n * 10
    })

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(out).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 50 },
    ])
  })

  it("captures rejections without stopping later tasks", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom")
      return n
    })

    expect(out[0]).toEqual({ status: "fulfilled", value: 1 })
    expect(out[1]?.status).toBe("rejected")
    expect(out[2]).toEqual({ status: "fulfilled", value: 3 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "normalizes non-finite concurrency %s without skipping tasks",
    async (concurrency) => {
      let active = 0
      let maxActive = 0
      const out = await mapWithConcurrency([1, 2, 3], concurrency, async (n) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return n
      })

      expect(maxActive).toBe(1)
      expect(out).toEqual([
        { status: "fulfilled", value: 1 },
        { status: "fulfilled", value: 2 },
        { status: "fulfilled", value: 3 },
      ])
    },
  )
})
