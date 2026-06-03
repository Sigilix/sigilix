// SIG-317 step 6 Part A — deterministic AST-emit injection floor tests.
//
// The floor force-surfaces an `emitWhenUnmatched` (warning/info) AST finding
// the synth did NOT emit (crowded out of the verdict tail). Recall-positive,
// P2/P3-capped, only ADDS findings. Mirrors tests/degraded-finding-floor.test.ts.

import { describe, it, expect } from "vitest"
import {
  injectUnmatchedAstEmits,
  type AstEmitCandidate,
  type FloorProvenanceFinding,
} from "../src/lib/degraded-finding-floor"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

function f(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/ui/cart.tsx",
    line: 10,
    score: 5,
    category: "security",
    headline: "h",
    body: "b",
    ...over,
  }
}
function prov(ids: string[]): FloorProvenanceFinding {
  return { sourceSpecialists: ["security"], sourceFindingIds: ids, action: "kept", verifiedViaRetrieval: false }
}
function ast(over: Partial<AstEmitCandidate> = {}): AstEmitCandidate {
  return {
    astFindingId: "ast/cents-as-dollars/ab12cd3/42",
    path: "src/ui/cart.tsx",
    line: 42,
    roleHint: "logic",
    severity: "warning",
    emitWhenUnmatched: true,
    message: "Cents value `total` rendered as dollars in JSX. Divide by 100 before display.",
    ...over,
  }
}

describe("injectUnmatchedAstEmits", () => {
  it("INJECTS an uncovered warning emit at score 3, citing the astFindingId", () => {
    const r = injectUnmatchedAstEmits({ findings: [], provenanceFindings: [], astFindings: [ast()] })
    expect(r.injected).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].score).toBe(3)
    expect(r.findings[0].category).toBe("logic")
    expect(r.findings[0].path).toBe("src/ui/cart.tsx")
    expect(r.findings[0].line).toBe(42)
    expect(r.provenanceFindings[0].sourceFindingIds).toEqual(["ast/cents-as-dollars/ab12cd3/42"])
    // index-parallel alignment preserved
    expect(r.findings.length).toBe(r.provenanceFindings.length)
  })

  it("scores an info emit at 2", () => {
    const r = injectUnmatchedAstEmits({ findings: [], provenanceFindings: [], astFindings: [ast({ severity: "info" })] })
    expect(r.findings[0].score).toBe(2)
  })

  it("does NOT inject an `error`-severity emit (out of scope — sorts first, has SIG-309 path)", () => {
    const r = injectUnmatchedAstEmits({
      findings: [],
      provenanceFindings: [],
      astFindings: [ast({ severity: "error", roleHint: "security", astFindingId: "ast/no-exec/x/9" })],
    })
    expect(r.injected).toHaveLength(0)
  })

  it("does NOT inject an emit WITHOUT emitWhenUnmatched", () => {
    const r = injectUnmatchedAstEmits({ findings: [], provenanceFindings: [], astFindings: [ast({ emitWhenUnmatched: false })] })
    expect(r.injected).toHaveLength(0)
  })

  it("KEEPS (no inject) when a same-category finding already covers the line (±tolerance)", () => {
    const covering = f({ category: "logic", line: 43, score: 4 }) // within ±2 of 42
    const r = injectUnmatchedAstEmits({ findings: [covering], provenanceFindings: [prov(["logic-0"])], astFindings: [ast()] })
    expect(r.injected).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it("INJECTS when a finding on the line is a DIFFERENT category (non-security emit needs same-category cover)", () => {
    const otherCat = f({ category: "performance", line: 42, score: 4 })
    const r = injectUnmatchedAstEmits({ findings: [otherCat], provenanceFindings: [prov(["perf-0"])], astFindings: [ast()] })
    expect(r.injected).toHaveLength(1) // logic emit not covered by a perf finding
  })

  it("a SECURITY emit is covered by ANY finding on the line (any category)", () => {
    const sec = ast({ roleHint: "security", severity: "warning", astFindingId: "ast/dynamic-html/z/42" })
    const anyFinding = f({ category: "logic", line: 42 })
    const r = injectUnmatchedAstEmits({ findings: [anyFinding], provenanceFindings: [prov(["logic-9"])], astFindings: [sec] })
    expect(r.injected).toHaveLength(0)
  })

  it("does NOT re-inject an emit already cited in provenance", () => {
    const r = injectUnmatchedAstEmits({
      findings: [f({ category: "logic", line: 99 })],
      provenanceFindings: [prov(["ast/cents-as-dollars/ab12cd3/42"])],
      astFindings: [ast()],
    })
    expect(r.injected).toHaveLength(0)
  })

  it("no-ops on empty astFindings, returning fresh arrays", () => {
    const findings = [f()]
    const provenanceFindings = [prov(["security-0"])]
    const r = injectUnmatchedAstEmits({ findings, provenanceFindings, astFindings: [] })
    expect(r.injected).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
    expect(r.findings).not.toBe(findings) // fresh array
  })

  it("derives a capped headline from the message's first sentence", () => {
    const r = injectUnmatchedAstEmits({ findings: [], provenanceFindings: [], astFindings: [ast()] })
    expect(r.findings[0].headline).toBe("Cents value `total` rendered as dollars in JSX.")
    expect(r.findings[0].body).toContain("Divide by 100")
  })
})
