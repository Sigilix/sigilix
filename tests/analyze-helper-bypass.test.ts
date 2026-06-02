// SIG-317 Part 4b — cross-function helper-bypass asymmetry analysis. The output
// is a HINT injected into the logic specialist's prompt (a FACT, not a finding),
// so it can't be a false positive in the posted-review sense — but a noisy/wrong
// hint still wastes the model's attention, so these pin the asymmetry condition.

import { describe, it, expect } from "vitest"
import { analyzeHelperBypass, renderAsymmetryHints } from "../src/lib/ast-rules/analyze-helper-bypass"

// A helper that aggregates `refunds`, a sibling that USES it, and a mutator that
// BYPASSES it — the pr/10 D8 shape, minimised.
const HELPER = `
function refundsTotal(id) {
  const r = pool.query("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE charge_id = $1", [id]);
  return Number(r);
}
`
const MUTATOR_BYPASS = `
function refundCharge(id) {
  pool.query("INSERT INTO refunds (charge_id, amount_cents) VALUES ($1, $2)", [id, amt]);
}
`
const SIBLING_USES = `app.get("/refundable", async (req, res) => { res.json({ x: refundsTotal(req.params.id) }); });`

describe("analyzeHelperBypass", () => {
  it("HINTS a mutator of T that bypasses the aggregation helper over T used elsewhere", () => {
    const m = new Map([["billing.ts", HELPER + MUTATOR_BYPASS], ["api.ts", SIBLING_USES]])
    const hints = analyzeHelperBypass(m)
    expect(hints).toHaveLength(1)
    expect(hints[0]!.fn).toBe("refundCharge")
    expect(hints[0]!.helper).toBe("refundsTotal")
  })

  it("does NOT hint when the mutator DOES call the helper", () => {
    const good = `function refundCharge(id) {
      const prior = refundsTotal(id);
      pool.query("INSERT INTO refunds (charge_id, amount_cents) VALUES ($1, $2)", [id, amt - prior]);
    }`
    const m = new Map([["b.ts", HELPER + good], ["api.ts", SIBLING_USES]])
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("does NOT hint when the helper is never called anywhere (unused)", () => {
    const m = new Map([["b.ts", HELPER + MUTATOR_BYPASS]]) // no SIBLING_USES
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("does NOT hint when there is no aggregation helper (no SUM/COUNT/COALESCE)", () => {
    const plain = `function getRefund(id) { return pool.query("SELECT amount_cents FROM refunds WHERE id = $1", [id]); }`
    const m = new Map([["b.ts", plain + MUTATOR_BYPASS], ["api.ts", `getRefund(x)`]])
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("does NOT hint a mutator of a DIFFERENT table than the helper aggregates", () => {
    const other = `function touchOther(id) { pool.query("UPDATE charges SET status = 'x' WHERE id = $1", [id]); }`
    const m = new Map([["b.ts", HELPER + other], ["api.ts", SIBLING_USES]])
    expect(analyzeHelperBypass(m)).toHaveLength(0) // touchOther mutates charges, helper aggregates refunds
  })

  it("does NOT hint a commented-out mutator", () => {
    const commented = `/* function refundCharge(id) { pool.query("INSERT INTO refunds (charge_id) VALUES ($1)", [id]); } */`
    const m = new Map([["b.ts", HELPER + commented], ["api.ts", SIBLING_USES]])
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("does NOT flag the helper itself as a bypasser", () => {
    const m = new Map([["b.ts", HELPER + MUTATOR_BYPASS], ["api.ts", SIBLING_USES]])
    const hints = analyzeHelperBypass(m)
    expect(hints.every((h) => h.fn !== "refundsTotal")).toBe(true)
  })

  it("is empty on source with no functions", () => {
    expect(analyzeHelperBypass(new Map([["x.ts", "const a = 1;"]]))).toHaveLength(0)
  })

  // Noise-class regressions — the dual review's central concern (a wrong hint
  // nudges the model). The COLUMN MATCH is what keeps these quiet.
  it("does NOT hint a status-only UPDATE (writes a DIFFERENT column than the sum)", () => {
    const status = `function markProcessed(id) { pool.query("UPDATE refunds SET status = 'processed' WHERE id = $1", [id]); }`
    const m = new Map([["b.ts", HELPER + status], ["api.ts", SIBLING_USES]])
    expect(analyzeHelperBypass(m)).toHaveLength(0) // doesn't write amount_cents → safe
  })

  it("does NOT hint an audit-log INSERT (writes a different column than the sum)", () => {
    const audit = `function logRefund(id) { pool.query("INSERT INTO refunds (charge_id, note) VALUES ($1, 'x')", [id]); }`
    const m = new Map([["b.ts", HELPER + audit], ["api.ts", SIBLING_USES]])
    expect(analyzeHelperBypass(m)).toHaveLength(0) // writes note/charge_id, not amount_cents
  })

  it("does NOT treat a scalar COALESCE (no SUM/COUNT) as an aggregation helper", () => {
    const scalar = `function refundsLabel(id) { return pool.query("SELECT COALESCE(note, '?') AS s FROM refunds WHERE id = $1", [id]); }`
    const m = new Map([["b.ts", scalar + MUTATOR_BYPASS], ["api.ts", `refundsLabel(x)`]])
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("does NOT treat a JOIN/UNION aggregate as a helper (ambiguous table)", () => {
    const joined = `function combined(id) { return pool.query("SELECT SUM(amount_cents) AS s FROM refunds JOIN charges ON x WHERE id = $1", [id]); }`
    const m = new Map([["b.ts", joined + MUTATOR_BYPASS], ["api.ts", `combined(x)`]])
    expect(analyzeHelperBypass(m)).toHaveLength(0)
  })

  it("handles a `$` in a function name without a regex crash (regex safety)", () => {
    const m = new Map([["b.ts", "function a$b() { pool.query(\"SELECT SUM(x) FROM t\"); }\nfunction w() { pool.query(\"INSERT INTO t (x) VALUES (1)\"); }"], ["api.ts", "a$b(1)"]])
    expect(() => analyzeHelperBypass(m)).not.toThrow()
  })
})

describe("renderAsymmetryHints", () => {
  it("renders a labelled block, empty string when no hints", () => {
    expect(renderAsymmetryHints([])).toBe("")
    const block = renderAsymmetryHints([{ message: "X bypasses Y", fn: "X", helper: "Y" }])
    expect(block).toContain("[CROSS-FUNCTION ASYMMETRY")
    expect(block).toContain("X bypasses Y")
  })
})
