// applyAstScanGate — the off/shadow/post contract shared by the deterministic
// AST security floors (Sigilix #350: the gating logic was previously untested).

import { describe, it, expect } from "vitest"
import { applyAstScanGate } from "../src/lib/triage-pr-review-ensemble"

type F = { ruleId: string; astFindingId: string; path: string; line: number }

function makeResult() {
  const findings: F[] = [
    { ruleId: "no-path-traversal", astFindingId: "ast/no-path-traversal/aaa/10", path: "a.ts", line: 10 },
    { ruleId: "no-ssrf", astFindingId: "ast/no-ssrf/bbb/20", path: "b.ts", line: 20 },
  ]
  const perFinding = new Map<string, unknown>([
    ["ast/no-path-traversal/aaa/10", {}],
    ["ast/no-ssrf/bbb/20", {}],
  ])
  return { findings, perFinding }
}

describe("applyAstScanGate — off/shadow/post contract", () => {
  it("post: keeps the rule's findings untouched and returns nothing stripped", () => {
    const r = makeResult()
    const stripped = applyAstScanGate(r, "no-path-traversal", "post")
    expect(stripped).toEqual([])
    expect(r.findings.length).toBe(2)
    expect(r.perFinding.size).toBe(2)
  })

  it("shadow: strips the rule's findings + provenance, returns anchors, leaves OTHER rules", () => {
    const r = makeResult()
    const stripped = applyAstScanGate(r, "no-path-traversal", "shadow")
    expect(stripped).toEqual([{ path: "a.ts", line: 10 }])
    expect(r.findings.map((f) => f.ruleId)).toEqual(["no-ssrf"])
    expect(r.perFinding.has("ast/no-path-traversal/aaa/10")).toBe(false)
    expect(r.perFinding.has("ast/no-ssrf/bbb/20")).toBe(true)
  })

  it("off (default): also strips — the floor is inert until explicitly post", () => {
    const r = makeResult()
    const stripped = applyAstScanGate(r, "no-path-traversal", "off")
    expect(stripped.length).toBe(1)
    expect(r.findings.map((f) => f.ruleId)).toEqual(["no-ssrf"])
  })

  it("returns [] when the rule produced no findings (no spurious shadow log)", () => {
    const r = makeResult()
    expect(applyAstScanGate(r, "no-path-traversal", "post")).toEqual([])
    const r2 = makeResult()
    r2.findings = r2.findings.filter((f) => f.ruleId !== "no-path-traversal")
    expect(applyAstScanGate(r2, "no-path-traversal", "shadow")).toEqual([])
  })
})
