import { describe, expect, it } from "vitest"
import { createCounter, addToCounter, estimateCount, mergeCounters } from "@/src/shared/domain/distinct-counter"

const SALT = "test-salt"
const addMany = (n: number, prefix = "tenant") => {
  let c = createCounter()
  for (let i = 0; i < n; i++) c = addToCounter(c, `${prefix}-${i}`, SALT)
  return c
}

describe("distinct-counter (linear counting)", () => {
  it("estimates 0 for an empty counter", () => {
    expect(estimateCount(createCounter())).toBe(0)
  })

  it("is idempotent — the same id added repeatedly counts once", () => {
    let c = createCounter()
    for (let i = 0; i < 10; i++) c = addToCounter(c, "same-tenant", SALT)
    expect(estimateCount(c)).toBe(1)
  })

  it("estimates small N accurately (the K=5 regime)", () => {
    expect(estimateCount(addMany(5))).toBe(5) // exact at the low end — what the gate depends on
    expect(estimateCount(addMany(1))).toBe(1)
  })

  it("estimates moderate N within a few percent", () => {
    const est = estimateCount(addMany(500))
    expect(est).toBeGreaterThan(470)
    expect(est).toBeLessThan(530) // linear counting is ~unbiased well past this
  })

  it("stores NO identity — state is just a number-array bitmap", () => {
    const c = addToCounter(createCounter(), "acme-corp-secret-tenant", SALT)
    const json = JSON.stringify(c)
    expect(json).not.toContain("acme-corp-secret-tenant")
    expect(c.words.every((w) => typeof w === "number")).toBe(true)
  })

  it("returns m when the bitmap is saturated", () => {
    // force saturation by setting every bit
    const c = { m: 64, words: new Array(2).fill(-1) } // 64 bits all set
    expect(estimateCount(c)).toBe(64)
  })

  it("merges two counters as a set union (dedupes overlap)", () => {
    const a = addMany(5, "x") // x-0..x-4
    let b = a // start from a, add 5 more distinct + re-add an overlapping one
    for (let i = 5; i < 10; i++) b = addToCounter(b, `x-${i}`, SALT)
    const merged = mergeCounters(a, b)
    expect(estimateCount(merged)).toBe(10) // union of {x0..x4} and {x0..x9} = 10 distinct
  })
})
