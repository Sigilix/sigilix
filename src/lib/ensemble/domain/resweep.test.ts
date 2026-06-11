// SIG-393 — pure re-sweep policy tests: the gate decision table, region
// selection (cap + dropped telemetry), and the guidance builder's
// no-headline-leak contract (the prototype's measurement-validity caveat).

import { describe, expect, it } from "vitest"
import {
  buildResweepGuidance,
  decideResweepGate,
  isHighRiskPath,
  parseResweepMode,
  selectResweepRegions,
  type ResweepFindingRef,
} from "@/src/lib/ensemble/domain/resweep"

const f = (path: string, line = 10, category = "logic", score = 3): ResweepFindingRef => ({
  path,
  line,
  category,
  score,
})

describe("parseResweepMode", () => {
  it("defaults to off and normalizes", () => {
    expect(parseResweepMode(undefined)).toBe("off")
    expect(parseResweepMode("")).toBe("off")
    expect(parseResweepMode("bogus")).toBe("off")
    expect(parseResweepMode(" Shadow ")).toBe("shadow")
    expect(parseResweepMode("ON")).toBe("on")
  })
})

describe("decideResweepGate", () => {
  const added = (entries: Array<[string, number]>) => new Map(entries)

  it("mode off never fires", () => {
    const d = decideResweepGate({
      mode: "off",
      findings: [f("server/payments.ts"), f("server/payments.ts", 20)],
      addedLinesByPath: added([["server/payments.ts", 200]]),
    })
    expect(d.fire).toBe(false)
    expect(d.reasons).toEqual(["mode-off"])
  })

  it("the dense-fixture shape fires: clustered region + second flagged region + high-risk path", () => {
    const d = decideResweepGate({
      mode: "shadow",
      findings: [f("server/payments.ts", 10), f("server/payments.ts", 50), f("server/refunds.ts", 5)],
      addedLinesByPath: added([
        ["server/payments.ts", 183],
        ["server/refunds.ts", 40],
      ]),
    })
    expect(d.fire).toBe(true)
    expect(d.reasons).toContain("clustered-regions:1")
    expect(d.reasons).toContain("high-risk-surface")
    // Regions ordered by finding count DESC.
    expect(d.flaggedPaths).toEqual(["server/payments.ts", "server/refunds.ts"])
  })

  it("small PRs never pay: one file, one finding", () => {
    const d = decideResweepGate({
      mode: "on",
      findings: [f("src/util.ts")],
      addedLinesByPath: added([["src/util.ts", 30]]),
    })
    expect(d.fire).toBe(false)
  })

  it("clustered but single-region small low-risk diff does not fire", () => {
    const d = decideResweepGate({
      mode: "on",
      findings: [f("src/render.ts", 5), f("src/render.ts", 9)],
      addedLinesByPath: added([["src/render.ts", 60]]),
    })
    expect(d.fire).toBe(false)
  })

  it("clustered single-region fires when the diff is big (size satisfies breadth AND risk arms)", () => {
    const d = decideResweepGate({
      mode: "on",
      findings: [f("src/render.ts", 5), f("src/render.ts", 9)],
      addedLinesByPath: added([["src/render.ts", 180]]),
    })
    expect(d.fire).toBe(true)
    expect(d.reasons).toContain("added-lines:180")
  })

  it("clustered multi-region but low-risk small diff does not fire (risk arm unmet)", () => {
    const d = decideResweepGate({
      mode: "on",
      findings: [f("src/a.ts", 5), f("src/a.ts", 9), f("src/b.ts", 3)],
      addedLinesByPath: added([
        ["src/a.ts", 50],
        ["src/b.ts", 40],
      ]),
    })
    expect(d.fire).toBe(false)
  })
})

describe("isHighRiskPath", () => {
  it("matches the epic's surfaces and rejects neutral paths", () => {
    expect(isHighRiskPath("server/payments.ts")).toBe(true)
    expect(isHighRiskPath("src/lib/auth-middleware.ts")).toBe(true)
    expect(isHighRiskPath("api/webhooks/stripe.ts")).toBe(true)
    expect(isHighRiskPath("src/components/Button.tsx")).toBe(false)
  })
})

describe("selectResweepRegions", () => {
  const blocks = new Map([
    ["a.ts", "diff a"],
    ["b.ts", "diff b"],
    ["c.ts", "diff c"],
  ])

  it("keeps flagged-path order, skips paths missing from the diff, caps + reports drops", () => {
    const { regions, droppedPaths } = selectResweepRegions({
      flaggedPaths: ["a.ts", "missing.ts", "b.ts", "c.ts"],
      diffBlocks: blocks,
      findings: [f("a.ts", 1), f("a.ts", 2), f("b.ts", 3), f("c.ts", 4)],
      maxRegions: 2,
    })
    expect(regions.map((r) => r.path)).toEqual(["a.ts", "b.ts"])
    expect(regions[0]!.priorFindings).toHaveLength(2)
    expect(droppedPaths).toEqual(["c.ts"])
  })
})

describe("buildResweepGuidance", () => {
  it("passes categories + line anchors and NEVER the pass-1 wording", () => {
    const guidance = buildResweepGuidance({
      path: "server/refunds.ts",
      diffSlice: "…",
      priorFindings: [
        { path: "server/refunds.ts", line: 11, category: "logic", score: 4 },
        { path: "server/refunds.ts", line: 5, category: "security", score: 5 },
      ],
    })
    expect(guidance).toContain("`server/refunds.ts`")
    // Sorted by line; anchors are category+line only.
    expect(guidance).toContain("- a security issue near line 5")
    expect(guidance).toContain("- a logic issue near line 11")
    expect(guidance).toContain("do NOT re-report")
    expect(guidance).toContain("assume more issues exist")
    // The de-bias contract: no finding text fields beyond category make it in.
    expect(guidance).not.toContain("score")
  })
})
