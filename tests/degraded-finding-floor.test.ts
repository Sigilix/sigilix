// SIG-287 — degraded-coverage finding floor: re-inject the findings the synth
// dropped on a degraded run, so a partial review can't silently erase the only
// signal the surviving specialists produced. Index-alignment between findings
// and provenance is load-bearing (the hallucination guard pairs them by index),
// so every test asserts the two arrays stay the same length.

import { describe, it, expect } from "vitest"
import {
  applyDegradedCoverageFindingFloor,
  DEGRADED_FLOOR_MIN_SCORE,
  type FloorProvenanceFinding,
  type DegradedFloorSpecialist,
} from "../src/lib/degraded-finding-floor"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

function finding(id: string, score: number, over: Partial<PrReviewFinding> = {}): PrReviewFinding & { id: string } {
  return {
    id,
    path: "src/x.ts",
    line: 10,
    score,
    category: "performance",
    headline: `finding ${id}`,
    body: "body",
    ...over,
  } as PrReviewFinding & { id: string }
}

function prov(...ids: string[]): FloorProvenanceFinding {
  return { sourceSpecialists: ["logic"], sourceFindingIds: ids, action: "kept", verifiedViaRetrieval: false }
}

describe("applyDegradedCoverageFindingFloor", () => {
  it("pins the min-score floor at 2 (nits stay dropped)", () => {
    expect(DEGRADED_FLOOR_MIN_SCORE).toBe(2)
  })

  it("re-injects a returned specialist finding the synth dropped (the #218 perf case)", () => {
    // Synth emitted 0 findings; performance returned a score-2 finding.
    const specialists: DegradedFloorSpecialist[] = [
      { role: "performance", findings: [finding("performance-0", 2)] },
    ]
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists,
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.findings.length).toBe(r.provenanceFindings.length) // index-parallel
    expect(r.restored).toEqual([{ role: "performance", id: "performance-0", score: 2, headline: "finding performance-0" }])
    expect(r.provenanceFindings[0]).toMatchObject({
      sourceSpecialists: ["performance"],
      sourceFindingIds: ["performance-0"],
      action: "kept",
    })
  })

  it("does NOT re-inject a finding the synth already accounted for", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [finding("security-3", 3)],
      provenanceFindings: [prov("security-3")], // synth kept it
      specialists: [{ role: "security", findings: [finding("security-3", 3)] }],
    })
    expect(r.findings).toHaveLength(1) // unchanged
    expect(r.restored).toHaveLength(0)
  })

  it("drops nits below the floor (score 1)", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists: [{ role: "tests", findings: [finding("tests-0", 1)] }],
    })
    expect(r.findings).toHaveLength(0)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps findings + provenance index-parallel when restoring several", () => {
    const synthFindings = [finding("logic-0", 4)]
    const r = applyDegradedCoverageFindingFloor({
      findings: synthFindings,
      provenanceFindings: [prov("logic-0")],
      specialists: [
        { role: "security", findings: [finding("security-1", 3), finding("security-2", 1)] }, // -2 is a nit
        { role: "performance", findings: [finding("performance-0", 2)] },
      ],
    })
    // logic-0 (kept) + security-1 + performance-0 restored; security-2 (nit) dropped.
    expect(r.findings).toHaveLength(3)
    expect(r.provenanceFindings).toHaveLength(3)
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    expect(r.restored.map((x) => x.id)).toEqual(["security-1", "performance-0"])
    // The original synth finding stays at index 0; restored append after.
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["logic-0"])
  })

  it("dedupes a (pathological) duplicate id across specialists — no double-inject", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists: [
        { role: "security", findings: [finding("dup-0", 3)] },
        { role: "performance", findings: [finding("dup-0", 3)] },
      ],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
  })

  it("is a no-op (returns equivalent arrays) when nothing qualifies", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [finding("logic-0", 5)],
      provenanceFindings: [prov("logic-0")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 5)] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })
})

// ─── SIG-317 — synth verdict-truncation recovery ──────────────────────────
import { recoverTruncatedSynthFindings } from "../src/lib/degraded-finding-floor"

function srcMap(...fs: Array<PrReviewFinding & { id: string }>): Map<string, PrReviewFinding & { id: string }> {
  return new Map(fs.map((f) => [f.id, f]))
}

describe("recoverTruncatedSynthFindings", () => {
  it("returns inputs unchanged when verdict isn't truncated (provenance <= verdict)", () => {
    const findings = [finding("security-0", 5), finding("logic-0", 4)]
    const provenance = [prov("security-0"), prov("logic-0")]
    const out = recoverTruncatedSynthFindings({ findings, provenanceFindings: provenance, sourceById: srcMap() })
    expect(out.recovered).toHaveLength(0)
    expect(out.findings).toHaveLength(2)
    expect(out.provenanceFindings).toHaveLength(2)
  })

  it("recovers the truncated tail (the pr/10 case: provenance 20, verdict 8)", () => {
    // synth wrote 2 verdict findings, but provenance accounts for 5 (3 orphans).
    const findings = [finding("security-0", 5), finding("security-1", 5)]
    const provenance = [
      prov("security-0"), prov("security-1"),
      prov("performance-0"), prov("logic-1"), prov("tests-4"), // truncated tail
    ]
    const sources = srcMap(
      finding("performance-0", 5, { category: "performance", headline: "N+1 in computeBalance" }),
      finding("logic-1", 4, { category: "logic", headline: "floating promise in refundCharge" }),
      finding("tests-4", 3, { category: "testing", headline: "refundCharge over-refund" }),
    )
    const out = recoverTruncatedSynthFindings({ findings, provenanceFindings: provenance, sourceById: sources })
    expect(out.recovered.map((r) => r.id)).toEqual(["performance-0", "logic-1", "tests-4"])
    // alignment is load-bearing: findings and provenance stay 1:1.
    expect(out.findings).toHaveLength(5)
    expect(out.provenanceFindings).toHaveLength(5)
    // the kept prefix is preserved.
    expect((out.findings[0] as { id: string }).id).toBe("security-0")
    // a recovered finding carries the specialist's real fields.
    expect(out.findings[2]?.headline).toBe("N+1 in computeBalance")
  })

  it("does NOT recover a score-1 orphan (nits stay dropped)", () => {
    const findings = [finding("security-0", 5)]
    const provenance = [prov("security-0"), prov("style-0")]
    const sources = srcMap(finding("style-0", 1, { category: "style" }))
    const out = recoverTruncatedSynthFindings({ findings, provenanceFindings: provenance, sourceById: sources })
    expect(out.recovered).toHaveLength(0)
    // dropping a sub-min orphan must not break alignment.
    expect(out.findings.length).toBe(out.provenanceFindings.length)
  })

  it("skips an orphan whose source is absent from the map (preserves alignment)", () => {
    const findings = [finding("security-0", 5)]
    const provenance = [prov("security-0"), prov("ghost-9")]
    const out = recoverTruncatedSynthFindings({ findings, provenanceFindings: provenance, sourceById: srcMap() })
    expect(out.recovered).toHaveLength(0)
    expect(out.findings.length).toBe(out.provenanceFindings.length)
  })

  it("does not double-recover a source already present in the kept prefix", () => {
    const findings = [finding("security-0", 5)]
    // a (pathological) tail entry re-citing an already-kept source.
    const provenance = [prov("security-0"), prov("security-0")]
    const out = recoverTruncatedSynthFindings({
      findings, provenanceFindings: provenance,
      sourceById: srcMap(finding("security-0", 5)),
    })
    expect(out.recovered).toHaveLength(0)
  })

  it("picks the highest-score source on a merged provenance entry", () => {
    const findings = [finding("security-0", 5)]
    const provenance = [prov("security-0"), prov("logic-3", "tests-2")]
    const sources = srcMap(
      finding("logic-3", 3, { headline: "low" }),
      finding("tests-2", 5, { headline: "high" }),
    )
    const out = recoverTruncatedSynthFindings({ findings, provenanceFindings: provenance, sourceById: sources })
    expect(out.recovered).toHaveLength(1)
    expect(out.recovered[0]?.headline).toBe("high")
  })

  it("TRIMS the orphan tail to verdict length even when nothing is recovered (the install-unconditionally contract)", () => {
    // The whole tail is unrecoverable (AST-only + missing source), so recovered
    // is empty — but the helper STILL returns a 1:1-aligned pair, trimming the
    // stale provenance tail down to verdict length. The call site relies on this
    // to hand the degraded floor an aligned base (Codex SIG-317 review).
    const findings = [finding("security-0", 5)]
    const provenance = [prov("security-0"), prov("ast/rule/abc/42"), prov("missing-9")]
    const out = recoverTruncatedSynthFindings({
      findings, provenanceFindings: provenance,
      sourceById: srcMap(finding("security-0", 5)), // AST + missing-9 absent
    })
    expect(out.recovered).toHaveLength(0)
    expect(out.findings).toHaveLength(1)
    expect(out.provenanceFindings).toHaveLength(1) // trimmed 3 -> 1, NOT left at 3
    expect(out.findings.length).toBe(out.provenanceFindings.length)
  })
})

// Regression for Codex's SIG-317 HIGH finding: in `on` mode the call site must
// install the recovery result UNCONDITIONALLY (even recovered.length === 0),
// because the helper's trim is what re-aligns verdict↔provenance. If it doesn't,
// the stale longer provenance survives into the degraded floor and the floor's
// restored findings get mispaired by index. These tests pin the contract at the
// helper-composition level (recover -> degraded floor).
describe("SIG-317 recovery → degraded floor composition (alignment contract)", () => {
  it("recover (recovered=0) THEN degraded floor stays aligned and pairs correctly", () => {
    // synth truncated: verdict 1, provenance 2 (orphan tail is AST-only).
    const rec = recoverTruncatedSynthFindings({
      findings: [finding("security-0", 5)],
      provenanceFindings: [prov("security-0"), prov("ast/rule/abc/42")],
      sourceById: srcMap(finding("security-0", 5)), // AST source absent -> recovered 0
    })
    expect(rec.recovered).toHaveLength(0)
    expect(rec.findings.length).toBe(rec.provenanceFindings.length) // trimmed to 1/1

    // Feed the INSTALLED (aligned) result into the degraded floor.
    const floored = applyDegradedCoverageFindingFloor({
      findings: rec.findings,
      provenanceFindings: rec.provenanceFindings,
      specialists: [{ role: "performance", findings: [finding("performance-0", 4)] }],
    })
    expect(floored.findings).toHaveLength(2)
    expect(floored.provenanceFindings).toHaveLength(2)
    expect(floored.findings.length).toBe(floored.provenanceFindings.length) // aligned
    // The restored finding is paired with ITS OWN provenance, not the AST orphan.
    expect((floored.findings[1] as { id: string }).id).toBe("performance-0")
    expect(floored.provenanceFindings[1]?.sourceFindingIds).toEqual(["performance-0"])
  })

  it("WITHOUT the trim (raw untrimmed provenance) the degraded floor MISALIGNS (the bug the fix prevents)", () => {
    // This is the pre-fix path: install was skipped because recovered===0, so the
    // raw 2-entry provenance reached the floor against a 1-entry verdict.
    const buggy = applyDegradedCoverageFindingFloor({
      findings: [finding("security-0", 5)],                       // length 1
      provenanceFindings: [prov("security-0"), prov("ast/rule/abc/42")], // length 2 (stale tail)
      specialists: [{ role: "performance", findings: [finding("performance-0", 4)] }],
    })
    // findings 2, provenance 3 — index pairing is now broken.
    expect(buggy.findings.length).not.toBe(buggy.provenanceFindings.length)
    // performance-0 would be mispaired with the AST orphan provenance at index 1.
    expect(buggy.provenanceFindings[1]?.sourceFindingIds).toEqual(["ast/rule/abc/42"])
  })
})
