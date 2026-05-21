// SIG-110 PR B — tests for perf-keyword retrieval query construction.
//
// These pin the "differentiated chunks vs generic retrieval" acceptance
// criterion: the perf query must be demonstrably different from the
// base query (carries perf anti-pattern keywords + changed function
// names) so it biases Vectorize toward perf-relevant code.

import { describe, expect, it } from "vitest"
import {
  extractChangedFunctionNames,
  buildPerfRetrievalQuery,
  PERF_RETRIEVAL_KEYWORDS,
} from "../src/lib/perf-retrieval"

describe("extractChangedFunctionNames", () => {
  it("extracts a plain function declaration on an added line", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      "+function loadOrders(ids) {",
      " const x = 1",
    ].join("\n")
    expect(extractChangedFunctionNames(diff)).toEqual(["loadOrders"])
  })

  it("extracts arrow-assigned consts (async + sync)", () => {
    const diff = [
      "+const handleCheckout = async (req) => {",
      "+const computeTotal = (items) => items.length",
    ].join("\n")
    expect(extractChangedFunctionNames(diff)).toEqual(["handleCheckout", "computeTotal"])
  })

  it("extracts exported functions", () => {
    const diff = "+export function renderRows(rows) {\n+export const fetchUser = async (id) => {}"
    expect(extractChangedFunctionNames(diff)).toEqual(["renderRows", "fetchUser"])
  })

  it("extracts class method shorthand but ignores control-flow keywords", () => {
    const diff = [
      "+  async processBatch(items) {",
      "+    for (const it of items) {",
      "+    if (it.ok) {",
      "+    while (more) {",
      "+    return done",
    ].join("\n")
    expect(extractChangedFunctionNames(diff)).toEqual(["processBatch"])
  })

  it("ignores removed and context lines (only added lines count)", () => {
    const diff = [
      "-function removedOne() {",
      " function contextTwo() {",
      "+function addedThree() {",
    ].join("\n")
    expect(extractChangedFunctionNames(diff)).toEqual(["addedThree"])
  })

  it("ignores the +++ file header line", () => {
    const diff = "+++ b/src/lib/foo.ts\n+function realFn() {"
    expect(extractChangedFunctionNames(diff)).toEqual(["realFn"])
  })

  it("dedupes repeated names and caps the list", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `+function fn${i}() {`)
    lines.push("+function fn0() {") // duplicate
    const out = extractChangedFunctionNames(lines.join("\n"))
    expect(out.length).toBeLessThanOrEqual(20)
    expect(new Set(out).size).toBe(out.length) // no dupes
  })

  it("returns empty for a diff with no function-shaped added lines", () => {
    expect(extractChangedFunctionNames("+const x = 1\n+x += 2")).toEqual([])
    expect(extractChangedFunctionNames("")).toEqual([])
  })
})

describe("buildPerfRetrievalQuery", () => {
  const base = "Add order batching\n\nSpeeds up the checkout flow"

  it("includes every perf anti-pattern keyword", () => {
    const q = buildPerfRetrievalQuery(base, [])
    for (const kw of PERF_RETRIEVAL_KEYWORDS) {
      expect(q).toContain(kw)
    }
  })

  it("preserves the base query text", () => {
    const q = buildPerfRetrievalQuery(base, [])
    expect(q).toContain("Add order batching")
    expect(q).toContain("checkout flow")
  })

  it("appends changed function names when present", () => {
    const q = buildPerfRetrievalQuery(base, ["loadOrders", "handleCheckout"])
    expect(q).toContain("loadOrders")
    expect(q).toContain("handleCheckout")
  })

  it("is differentiated from the bare base query (the core AC)", () => {
    const q = buildPerfRetrievalQuery(base, ["loadOrders"])
    expect(q).not.toBe(base)
    expect(q.length).toBeGreaterThan(base.length)
  })

  it("handles an empty base query without leading noise", () => {
    const q = buildPerfRetrievalQuery("", [])
    expect(q.length).toBeGreaterThan(0)
    expect(q).toContain("N+1")
  })
})
