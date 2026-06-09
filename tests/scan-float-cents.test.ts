// SIG-317 Part 4a — fractional-cents money-math detector. ZERO P0/P1 FP bar, so
// every SKIP test is a precision guard. P2 advisory: it surfaces an integer-cents
// value multiplied by a non-integer operand without rounding; the logic
// specialist judges whether the multiplier is really fractional.

import { describe, it, expect } from "vitest"
import { scanFractionalCentsMath as scan } from "@/features/ast-rules/domain/scan-float-cents"

describe("scanFractionalCentsMath — FLAGS the bug", () => {
  it("flags `amountCents * (1 - rate)` (pr/10 D12)", () => {
    expect(scan("return amountCents * (1 - rate);")).toHaveLength(1)
  })
  it("flags `amountCents * fraction` (pr/11 D10)", () => {
    expect(scan("return amountCents * fraction;")).toHaveLength(1)
  })
  it("flags a decimal-literal multiplier `priceCents * 0.5`", () => {
    expect(scan("const half = priceCents * 0.5;")).toHaveLength(1)
  })
  it("flags cents on the RIGHT `rate * amountCents`", () => {
    expect(scan("const x = rate * amountCents;")).toHaveLength(1)
  })
  it("flags a snake_case `amount_cents * pct`", () => {
    expect(scan("return amount_cents * pct;")).toHaveLength(1)
  })
})

describe("scanFractionalCentsMath — SKIPS (precision guards)", () => {
  it("does NOT flag an integer-literal multiplier `cents * 2` / `cents * 100`", () => {
    expect(scan("return amountCents * 2;")).toHaveLength(0)
    expect(scan("return amountCents * 100;")).toHaveLength(0)
    expect(scan("return amountCents * 1_000;")).toHaveLength(0)
  })
  it("does NOT flag when wrapped in Math.round / floor / ceil / trunc", () => {
    expect(scan("return Math.round(amountCents * rate);")).toHaveLength(0)
    expect(scan("return Math.floor(amountCents * rate);")).toHaveLength(0)
    expect(scan("return Math.trunc(priceCents * pct);")).toHaveLength(0)
  })
  it("does NOT flag integer-coercion `~~` or `| 0`", () => {
    expect(scan("const x = ~~(amountCents * rate);")).toHaveLength(0)
    expect(scan("const x = (amountCents * rate) | 0;")).toHaveLength(0)
  })
  it("does NOT flag a MULTI-LINE Math.round wrapping the multiply (CodeRabbit #307)", () => {
    expect(scan("return Math.round(\n  amountCents * rate\n);")).toHaveLength(0)
    expect(scan("const x = Math.floor(\n  priceCents * pct,\n);")).toHaveLength(0)
  })
  it("does NOT flag a non-cents identifier `quantity * rate`", () => {
    expect(scan("const x = quantity * rate;")).toHaveLength(0)
  })
  it("does NOT flag addition / division (not a fractional multiply)", () => {
    expect(scan("const t = a.amountCents + b.taxCents;")).toHaveLength(0)
    expect(scan("const d = amountCents / 100;")).toHaveLength(0)
  })
  it("does NOT flag a multiply inside a comment or string", () => {
    expect(scan("// const x = amountCents * rate;")).toHaveLength(0)
    expect(scan("const s = 'amountCents * rate';")).toHaveLength(0)
  })
  it("is a no-op on source with no `*`", () => {
    expect(scan("const x = amountCents;")).toHaveLength(0)
  })

  // FP vectors caught by the dual review (code-reviewer + DeepSeek).
  it("does NOT flag a `*=` compound assignment (code-review HIGH)", () => {
    expect(scan("totalCents *= rate;")).toHaveLength(0)
    expect(scan("subtotalCents *= 2;")).toHaveLength(0) // also: don't bypass the int guard
    expect(scan("netCents *= (1 - discount);")).toHaveLength(0)
  })
  it("does NOT flag the `**` exponent operator (DeepSeek)", () => {
    expect(scan("const x = amountCents ** 2;")).toHaveLength(0)
    expect(scan("const x = amountCents ** rate;")).toHaveLength(0)
  })
  it("does NOT flag an integer-valued float literal `* 1.0` (DeepSeek)", () => {
    expect(scan("return amountCents * 1.0;")).toHaveLength(0)
    expect(scan("return amountCents * 100.00;")).toHaveLength(0)
  })
  it("does NOT flag an integer-coercion call `* parseInt(x)` (DeepSeek)", () => {
    expect(scan("return amountCents * parseInt(s);")).toHaveLength(0)
    expect(scan("return amountCents * Number(q);")).toHaveLength(0)
  })
})

describe("scanFractionalCentsMath — structure", () => {
  it("reports the correct line", () => {
    const src = `a\nb\nreturn amountCents * fraction;`
    expect(scan(src)[0]!.line).toBe(3)
  })
  it("does not double-count a single multiply", () => {
    expect(scan("return amountCents * fraction;")).toHaveLength(1)
  })
})
