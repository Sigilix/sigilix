// SIG-392 — unit coverage for the shared offline-replay helpers. These
// reconstruct production inputs from captured lever-candidate findings
// for gate-survival.ts and synth-load.live.test.ts; a silent regression
// in the ref→role mapping or the field coercion would corrupt every
// offline replay measurement, so the branches are pinned here.

import { describe, expect, it } from "vitest"
import type { FixtureFinding } from "@/evals/fixture-types"
import { rebuildSpecialistVerdicts, roleOf, toPrFinding } from "@/e2e/replay-shared"

function fixture(over: Partial<FixtureFinding>): FixtureFinding {
  return {
    ref: "logic-1",
    tool: "sigilix",
    commentId: 1,
    path: "server/api.ts",
    line: 42,
    excerpt: "**Refund race on concurrent requests**",
    bodyText: "**Refund race on concurrent requests** Two parallel refunds both pass the balance check.",
    severity: "P1",
    url: "https://example.test/c/1",
    botCategory: "logic",
    ...over,
  }
}

describe("roleOf", () => {
  it("maps pass-1 refs `<role>-N` to their specialist role", () => {
    expect(roleOf("logic-3")).toBe("logic")
    expect(roleOf("security-1")).toBe("security")
    expect(roleOf("performance-2")).toBe("performance")
    expect(roleOf("tests-7")).toBe("tests")
  })

  it("maps re-sweep refs `resweep-<role>-N` into the same role", () => {
    expect(roleOf("resweep-security-4")).toBe("security")
    expect(roleOf("resweep-tests-1")).toBe("tests")
  })

  it("merges invariant-lens refs `inv-<family>-N` into LOGIC (SIG-395 merge-target rule)", () => {
    expect(roleOf("inv-scoping-2")).toBe("logic")
    expect(roleOf("inv-totality-1")).toBe("logic")
  })

  it("requires the trailing dash — a role-prefixed family name is not that role", () => {
    // e.g. a hypothetical "testscoverage-1" must not match role "tests"
    expect(roleOf("testscoverage-1")).toBe("logic")
  })
})

describe("toPrFinding", () => {
  it("strips bold markers from the excerpt and splits headline/body", () => {
    const out = toPrFinding(fixture({}))
    expect(out.headline).toBe("Refund race on concurrent requests")
    expect(out.body).toBe("Two parallel refunds both pass the balance check.")
  })

  it("maps severity to score (P0=5, P1=4, P2=3, other/null=2) and coerces null path/line", () => {
    expect(toPrFinding(fixture({ severity: "P0" })).score).toBe(5)
    expect(toPrFinding(fixture({ severity: "P2" })).score).toBe(3)
    const nulls = toPrFinding(fixture({ severity: null, path: null, line: null }))
    expect(nulls.score).toBe(2)
    expect(nulls.path).toBe("")
    expect(nulls.line).toBe(1)
  })

  it("keeps known bot categories and defaults unknown ones to logic", () => {
    expect(toPrFinding(fixture({ botCategory: "security" })).category).toBe("security")
    expect(toPrFinding(fixture({ botCategory: "style" })).category).toBe("logic")
    const { botCategory: _absent, ...noCategory } = fixture({})
    expect(toPrFinding(noCategory).category).toBe("logic")
  })

  it("falls back to the headline when the body is empty after the excerpt split", () => {
    const out = toPrFinding(fixture({ bodyText: "**Refund race on concurrent requests**" }))
    expect(out.body).toBe("Refund race on concurrent requests")
  })
})

describe("rebuildSpecialistVerdicts", () => {
  it("groups findings by role and assigns role-prefixed stable ids", () => {
    const verdicts = rebuildSpecialistVerdicts([
      fixture({ ref: "logic-1" }),
      fixture({
        ref: "resweep-logic-1",
        excerpt: "**N+1 in list endpoint**",
        bodyText: "**N+1 in list endpoint** body",
      }),
      fixture({ ref: "security-1", botCategory: "security" }),
      fixture({ ref: "inv-scoping-1" }),
    ])
    const byRole = new Map(verdicts.map((v) => [v.role, v]))
    expect([...byRole.keys()].sort()).toEqual(["logic", "security"])
    const logic = byRole.get("logic")?.verdict
    const security = byRole.get("security")?.verdict
    if (!logic || !security) throw new Error("expected logic + security verdicts")
    // pass-1 + re-sweep + lens all land in the logic verdict
    expect(logic.findings).toHaveLength(3)
    expect(security.findings).toHaveLength(1)
    // stable ids exist and carry the owning role (the provenance contract)
    expect(logic.findings.map((f) => f.id)).toEqual(["logic-0", "logic-1", "logic-2"])
    expect(security.findings.map((f) => f.id)).toEqual(["security-0"])
  })
})
