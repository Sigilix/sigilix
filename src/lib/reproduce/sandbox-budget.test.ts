// SIG-477 PR-2 — tests for the per-PR aggregate sandbox budget.

import { describe, it, expect } from "vitest"
import { createSandboxBudget } from "./sandbox-budget"

describe("createSandboxBudget", () => {
  it("admits runs until the cumulative estimate would exceed the total", () => {
    const b = createSandboxBudget(1000)
    expect(b.tryConsume(400)).toBe(true)
    expect(b.spent()).toBe(400)
    expect(b.remaining()).toBe(600)
    expect(b.tryConsume(400)).toBe(true)
    expect(b.spent()).toBe(800)
    // 800 + 300 > 1000 → refused, and nothing is reserved.
    expect(b.tryConsume(300)).toBe(false)
    expect(b.spent()).toBe(800)
    // A smaller run that still fits is admitted.
    expect(b.tryConsume(200)).toBe(true)
    expect(b.spent()).toBe(1000)
    expect(b.remaining()).toBe(0)
  })

  it("admits a run that exactly fills the remaining budget", () => {
    const b = createSandboxBudget(500)
    expect(b.tryConsume(500)).toBe(true)
    expect(b.tryConsume(1)).toBe(false)
  })

  it("treats a non-positive or non-finite estimate as a zero-cost probe (always admitted)", () => {
    const b = createSandboxBudget(100)
    expect(b.tryConsume(0)).toBe(true)
    expect(b.tryConsume(-50)).toBe(true)
    expect(b.tryConsume(Number.NaN)).toBe(true)
    expect(b.tryConsume(Number.POSITIVE_INFINITY)).toBe(true)
    expect(b.spent()).toBe(0)
    // The real budget is untouched.
    expect(b.tryConsume(100)).toBe(true)
    expect(b.tryConsume(1)).toBe(false)
  })

  it("fails closed: a non-positive or non-finite total yields a zero budget", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = createSandboxBudget(bad)
      expect(b.tryConsume(1)).toBe(false)
      // ...but a zero-cost probe is still admitted.
      expect(b.tryConsume(0)).toBe(true)
      expect(b.spent()).toBe(0)
      expect(b.remaining()).toBe(0)
    }
  })

  it("never reports negative remaining", () => {
    const b = createSandboxBudget(10)
    expect(b.tryConsume(10)).toBe(true)
    expect(b.remaining()).toBe(0)
    expect(b.tryConsume(5)).toBe(false)
    expect(b.remaining()).toBe(0)
  })
})
