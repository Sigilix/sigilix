import { describe, expect, it } from "vitest"
import {
  annotateWithConsensus,
  computeConsensusRanking,
  computeDegradedCoverage,
  computeFindingDelta,
  computeFindingKey,
  type SynthesizerProvenance,
} from "@/src/lib/triage-pr-review-ensemble"
import {
  type PrReviewVerdict,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

describe("computeConsensusRanking", () => {
  const finding = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding, ...overrides,
  })
  const prov = (specialists: string[]): SynthesizerProvenance["findings"][number] => ({
    sourceSpecialists: specialists as SynthesizerProvenance["findings"][number]["sourceSpecialists"],
    sourceFindingIds: specialists.map((s, i) => `${s}-${i}`),
    action: "kept",
    verifiedViaRetrieval: false,
  })

  it("ranks 2-specialist findings above 1-specialist findings at the same score", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "single", score: 4 }),
        finding({ headline: "duo", score: 4 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["logic", "security"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings[0]?.headline).toBe("duo")
    expect(out.verdict.findings[1]?.headline).toBe("single")
    expect(out.consensusByIndex).toEqual([2, 1])
  })

  it("uses score as the tiebreaker when consensus is equal", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "low", score: 2 }),
        finding({ headline: "high", score: 5 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["security"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings[0]?.headline).toBe("high")
    expect(out.verdict.findings[1]?.headline).toBe("low")
  })

  it("preserves original order on full ties (stable sort)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "first", score: 3 }),
        finding({ headline: "second", score: 3 }),
        finding({ headline: "third", score: 3 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["logic"]), prov(["logic"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["first", "second", "third"])
  })

  it("dedupes specialists when computing consensus (same specialist twice = 1)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [finding({ headline: "dup-spec" })],
    }
    // Pathological provenance — same specialist listed twice. Consensus
    // should still report 1 (distinct specialists only).
    const provenance = [prov(["logic", "logic"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.consensusByIndex).toEqual([1])
  })

  it("3-specialist > 2-specialist > 1-specialist on identical scores", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "solo", score: 3 }),
        finding({ headline: "trio", score: 3 }),
        finding({ headline: "duo", score: 3 }),
      ],
    }
    const provenance = [
      prov(["logic"]),
      prov(["logic", "security", "tests"]),
      prov(["logic", "performance"]),
    ]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["trio", "duo", "solo"])
    expect(out.consensusByIndex).toEqual([3, 2, 1])
  })

  it("provenance array is reordered to match the new finding order", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "A" }),
        finding({ headline: "B" }),
      ],
    }
    const provenanceA = prov(["logic"])
    const provenanceB = prov(["logic", "security"])
    const provenance = [provenanceA, provenanceB]

    const out = computeConsensusRanking(verdict, provenance)

    // B (consensus 2) is now at index 0 — its provenance moved with it.
    expect(out.verdict.findings[0]?.headline).toBe("B")
    expect(out.provenance[0]).toBe(provenanceB)
    expect(out.provenance[1]).toBe(provenanceA)
  })

  it("defensive: misaligned arrays → no-op (preserve order, consensus=1 each)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [finding({ headline: "A" }), finding({ headline: "B" })],
    }
    const provenance = [prov(["logic"])] // length=1, mismatch

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["A", "B"])
    expect(out.consensusByIndex).toEqual([1, 1])
  })

  it("empty findings list returns empty result without crashing", () => {
    const out = computeConsensusRanking({ ...baseVerdict, findings: [] }, [])
    expect(out.verdict.findings).toEqual([])
    expect(out.provenance).toEqual([])
    expect(out.consensusByIndex).toEqual([])
  })
})

describe("annotateWithConsensus", () => {
  const f: PrReviewFinding = { ...baseFinding }

  it("prepends a 'Flagged by N specialists' note when consensus >= 2", () => {
    const out = annotateWithConsensus(f, 3)
    expect(out.body.startsWith("_Flagged by 3 specialists._")).toBe(true)
    expect(out.body).toContain(f.body)
  })

  it("returns the finding unchanged when consensus is 1", () => {
    const out = annotateWithConsensus(f, 1)
    expect(out).toBe(f)
  })

  it("returns the finding unchanged when consensus is 0", () => {
    const out = annotateWithConsensus(f, 0)
    expect(out).toBe(f)
  })

  it("does not mutate the original finding", () => {
    const original = { ...baseFinding }
    annotateWithConsensus(original, 2)
    expect(original.body).toBe(baseFinding.body)
  })

  it("handles empty body (annotation alone)", () => {
    const empty = { ...baseFinding, body: "" }
    const out = annotateWithConsensus(empty, 2)
    expect(out.body).toBe("_Flagged by 2 specialists._")
  })
})

// ARC-271 — finding deltas across pushes
describe("computeFindingKey", () => {
  it("returns the same key for identical (path, headline)", async () => {
    const a = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    const b = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    expect(a).toBe(b)
  })

  it("normalizes case + whitespace + trailing punctuation", async () => {
    const a = await computeFindingKey("Src/Foo.TS", "  Off-by-one in clampIndex.  ")
    const b = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    expect(a).toBe(b)
  })

  it("produces different keys for different paths", async () => {
    const a = await computeFindingKey("src/a.ts", "guard missing")
    const b = await computeFindingKey("src/b.ts", "guard missing")
    expect(a).not.toBe(b)
  })

  it("produces different keys for different headlines", async () => {
    const a = await computeFindingKey("src/a.ts", "headline one")
    const b = await computeFindingKey("src/a.ts", "headline two")
    expect(a).not.toBe(b)
  })

  it("returns a 16-char hex string", async () => {
    const k = await computeFindingKey("src/a.ts", "x")
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("computeFindingDelta", () => {
  const prior = (key: string, path: string) => ({ key, path })

  it("classifies every prior finding correctly across all 4 buckets", () => {
    const currentKeys = new Set(["k-still", "k-new"])
    const priorFindings = [
      prior("k-still", "src/touched.ts"),  // → still-open
      prior("k-gone-touched", "src/touched.ts"),  // → likely-fixed
      prior("k-gone-untouched", "src/untouched.ts"),  // → carried-over
    ]
    const changedPaths = new Set(["src/touched.ts"])

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.newCount).toBe(1)
    expect(delta.stillOpenCount).toBe(1)
    expect(delta.likelyFixedCount).toBe(1)
    expect(delta.carriedOverCount).toBe(1)
  })

  it("never claims a finding is fixed when its path isn't in the changed set (incremental-review safety)", () => {
    const currentKeys = new Set(["k1"])
    const priorFindings = [prior("k-gone", "src/untouched.ts")]
    const changedPaths = new Set(["src/other.ts"]) // touched some other file, not the prior finding's

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.likelyFixedCount).toBe(0)
    expect(delta.carriedOverCount).toBe(1)
  })

  it("returns all zeros when prior had no findings and current is also empty", () => {
    const delta = computeFindingDelta(new Set(), [], new Set())
    expect(delta).toEqual({ newCount: 0, stillOpenCount: 0, likelyFixedCount: 0, carriedOverCount: 0 })
  })

  it("treats first-run (no prior findings) as 'all new'", () => {
    const currentKeys = new Set(["k1", "k2", "k3"])
    const delta = computeFindingDelta(currentKeys, [], new Set(["src/foo.ts"]))
    expect(delta.newCount).toBe(3)
    expect(delta.stillOpenCount).toBe(0)
  })

  // code-reviewer HIGH catch on commit 2: `computeFindingKey`
  // lowercases path before hashing, so a prior finding stored with
  // raw casing (e.g. `Src/Foo.ts`) must still match diff-derived
  // changed-paths (typically lowercased / unix style).
  it("matches paths case-insensitively (changedPaths set may be in different case)", () => {
    const currentKeys = new Set<string>()
    const priorFindings = [{ key: "k-gone", path: "Src/Foo.TS" }] // raw upper case
    const changedPaths = new Set(["src/foo.ts"]) // lowercased from diff

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.likelyFixedCount).toBe(1)
    expect(delta.carriedOverCount).toBe(0)
  })

  it("counts likely-fixed/carried-over correctly when prior had findings but current has none", () => {
    // ARC-281: pure-data delta test. The renderer-side header has
    // moved to `renderDeltaBadge` in triage-pr-review.ts (see
    // tests/triage-pr-review-body.test.ts). This test now asserts
    // the delta counts directly without going through a render
    // step.
    const currentKeys = new Set<string>()
    const priorFindings = [
      { key: "k1", path: "src/touched.ts" },
      { key: "k2", path: "src/untouched.ts" },
    ]
    const changedPaths = new Set(["src/touched.ts"])

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)
    expect(delta).toEqual({
      newCount: 0,
      stillOpenCount: 0,
      likelyFixedCount: 1,
      carriedOverCount: 1,
    })
  })

  it("counts +N new when prior manifest had findings: [] (clean PR last time)", () => {
    // First-time finding state: prior manifest existed but its
    // findings array was empty. Every current finding counts as
    // `new`.
    const currentKeys = new Set(["k1", "k2"])
    const delta = computeFindingDelta(currentKeys, [], new Set())
    expect(delta.newCount).toBe(2)
  })
})

// ARC-277: drop the specialist quorum gate. Synth now runs on any
// non-empty subset of returning specialists; the prompt is augmented
// with a [DEGRADED COVERAGE] block when one or more specialists
// didn't return.
describe("computeDegradedCoverage (ARC-277)", () => {
  it("returns all dispatched roles as `rolesReturned` when every specialist returned", () => {
    const out = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "security", "performance", "tests"],
    )
    expect(out.rolesReturned).toEqual(["logic", "security", "performance", "tests"])
    expect(out.rolesMissing).toEqual([])
  })

  it("splits returned vs missing when some specialists didn't return", () => {
    const out = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "performance"],
    )
    expect(out.rolesReturned).toEqual(["logic", "performance"])
    expect(out.rolesMissing).toEqual(["security", "tests"])
  })

  it("returns stable order (logic, security, performance, tests) regardless of input order", () => {
    // Helper renders the prompt — `[DEGRADED COVERAGE]` text must be
    // deterministic for any (dispatched, returned) pair so two runs
    // with the same coverage gap produce identical prompt-shape
    // hashes for telemetry.
    const a = computeDegradedCoverage(
      ["tests", "logic", "performance", "security"],
      ["performance", "logic"],
    )
    const b = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "performance"],
    )
    expect(a).toEqual(b)
  })

  it("does NOT include roles that weren't dispatched", () => {
    // Router may dispatch a subset (e.g. CSS-only → ["performance"]).
    // A role that was never dispatched should not appear in either
    // returned or missing.
    const out = computeDegradedCoverage(
      ["performance"],
      ["performance"],
    )
    expect(out.rolesReturned).toEqual(["performance"])
    expect(out.rolesMissing).toEqual([])
  })

  it("treats `dispatched but none returned` as fully missing (used by the 0/N bail in the orchestrator)", () => {
    const out = computeDegradedCoverage(
      ["logic", "security"],
      [],
    )
    expect(out.rolesReturned).toEqual([])
    expect(out.rolesMissing).toEqual(["logic", "security"])
  })
})
