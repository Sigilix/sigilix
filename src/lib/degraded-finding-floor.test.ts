// SIG-287 — degraded-coverage finding floor: re-inject the findings the synth
// dropped on a degraded run, so a partial review can't silently erase the only
// signal the surviving specialists produced. Index-alignment between findings
// and provenance is load-bearing (the hallucination guard pairs them by index),
// so every test asserts the two arrays stay the same length.

import { describe, it, expect } from "vitest"
import {
  applyDegradedCoverageFindingFloor,
  applySynthSourceFindingFloor,
  DEGRADED_FLOOR_MIN_SCORE,
  SYNTH_SOURCE_FLOOR_MIN_SCORE,
  type FloorProvenanceFinding,
  type DegradedFloorSpecialist,
} from "@/src/lib/degraded-finding-floor"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

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

function dropped(id: string, reason: string) {
  return { specialist: "security" as const, sourceFindingId: id, headline: `finding ${id}`, reason }
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

// ─── SIG-351 — synth source-finding floor ────────────────────────────────
//
// Full-coverage synth runs can still silently omit a P0/P1 source finding while
// trying to clean up false positives. The SIG-351 floor restores omitted
// score>=4 source findings unless the synth either represented the source in
// kept provenance or recorded a proof-like drop. Restored findings still go
// through the normal hallucination/grounding/validation path downstream.
describe("applySynthSourceFindingFloor", () => {
  it("pins the recall floor at score 4 (P0/P1 only)", () => {
    expect(SYNTH_SOURCE_FLOOR_MIN_SCORE).toBe(4)
  })

  it("re-injects an omitted score>=4 source finding on a full-coverage synth run", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    expect(r.restored).toEqual([{ role: "logic", id: "logic-0", score: 4, headline: "finding logic-0" }])
    expect(r.provenanceFindings[0]).toMatchObject({
      sourceSpecialists: ["logic"],
      sourceFindingIds: ["logic-0"],
      action: "kept",
    })
  })

  it("does NOT re-inject a score>=4 source finding represented by kept or merged provenance", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("security-0", 5)],
      provenanceFindings: [prov("logic-0", "security-0")],
      provenanceDropped: [],
      specialists: [
        { role: "logic", findings: [finding("logic-0", 4)] },
        { role: "security", findings: [finding("security-0", 5)] },
      ],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps a represented blocker when the synth row preserves its distinctive source token", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        body: "The handler still returns another tenant's order without checking `tenantId`.",
      })],
      provenanceFindings: [prov("logic-0")],
      provenanceDropped: [],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4, {
        body: "The handler reads an arbitrary order ID and returns it without checking the caller's `tenantId`.",
      })] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("replaces a represented blocker when the synth row drops its distinctive source token", () => {
    const source = finding("logic-0", 4, {
      headline: "Missing tenant authorization before returning an order",
      body: "The handler reads an arbitrary order ID and returns it without checking the caller's `tenantId`.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        headline: "Order lookup is too broad",
        body: "The handler returns arbitrary orders without an ownership check.",
      })],
      provenanceFindings: [prov("logic-0")],
      provenanceDropped: [],
      specialists: [{ role: "logic", findings: [source] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.findings[0]?.headline).toBe("Missing tenant authorization before returning an order")
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(r.restored.map((x) => x.id)).toEqual(["logic-0"])
  })

  it("replaces a represented blocker when the synth drops a standalone short source token", () => {
    const source = finding("security-0", 4, {
      category: "security",
      headline: "Untrusted redirect target is fetched",
      body: "The handler passes the attacker-controlled `url` value into a follow-up fetch.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        category: "security",
        headline: "Redirect handling is unsafe",
        body: "The handler follows attacker-controlled redirects without validating the destination.",
      })],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [source] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]?.headline).toBe("Untrusted redirect target is fetched")
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["security-0"])
    expect(r.restored.map((x) => x.id)).toEqual(["security-0"])
  })

  it("keeps a represented blocker when the synth preserves a standalone short source token", () => {
    const source = finding("security-0", 4, {
      category: "security",
      headline: "Untrusted redirect target is fetched",
      body: "The handler passes the attacker-controlled `url` value into a follow-up fetch.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        category: "security",
        headline: "Untrusted URL can be fetched",
        body: "The handler fetches an attacker-controlled `url` without destination validation.",
      })],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [source] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]?.headline).toBe("Untrusted URL can be fetched")
    expect(r.restored).toHaveLength(0)
  })

  it("replaces a represented blocker when the synth mentions the token but loses the mechanism", () => {
    const source = finding("security-0", 4, {
      category: "security",
      headline: "Untrusted redirect target is fetched",
      body: "The handler passes the attacker-controlled `url` value into a follow-up fetch.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        category: "security",
        headline: "Redirect URL is handled",
        body: "The `url` value is sanitized before redirect handling, so the risk is not described.",
      })],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [source] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]?.headline).toBe("Untrusted redirect target is fetched")
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["security-0"])
    expect(r.restored.map((x) => x.id)).toEqual(["security-0"])
  })

  it("splits one under-preserved source out of a merged synth row while keeping the preserved source", () => {
    const logic = finding("logic-0", 4, {
      body: "The new flow calls `charge(order)` but never calls `reserveInventory`, so two checkouts can sell the same item.",
    })
    const perf = finding("performance-0", 4, {
      body: "The `seenToken` check happens before `markTokenSeen`, so concurrent retries with the same token can double-charge.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-0", 4, {
        body: "Checkout can oversell because it never calls `reserveInventory` before charging.",
      })],
      provenanceFindings: [{
        sourceSpecialists: ["logic", "performance"],
        sourceFindingIds: ["logic-0", "performance-0"],
        action: "merged",
        verifiedViaRetrieval: false,
      }],
      provenanceDropped: [],
      specialists: [
        { role: "logic", findings: [logic] },
        { role: "performance", findings: [perf] },
      ],
    })
    expect(r.findings).toHaveLength(2)
    expect(r.provenanceFindings).toHaveLength(2)
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(r.provenanceFindings[1]?.sourceFindingIds).toEqual(["performance-0"])
    expect(r.restored.map((x) => x.id)).toEqual(["performance-0"])
  })

  it("does NOT re-inject a source finding explicitly dropped as a proven false positive", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [dropped("security-0", "false positive on diff inspection")],
      specialists: [{ role: "security", findings: [finding("security-0", 4)] }],
    })
    expect(r.findings).toHaveLength(0)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps a self-contradicted SSRF source unless the synth records explicit FP proof", () => {
    const ssrf = finding("security-0", 4, {
      category: "security",
      headline: "SSRF via Content-Type",
      body: "The parser trusts a response Content-Type header, but this PR only reads bytes from a local object binding.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ssrf],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ssrf] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps an SSRF source finding when the source text does not explicitly prove a local-only path", () => {
    const ssrf = finding("security-0", 4, {
      category: "security",
      headline: "SSRF via URL fetch",
      body: "The handler passes attacker-controlled `url` into `fetch(url)` without allow-listing the destination.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ssrf],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ssrf] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps an SSRF source finding when local bytes feed a later outbound URL action", () => {
    const ssrf = finding("security-0", 4, {
      category: "security",
      headline: "SSRF via Content-Type redirect",
      body: "The parser only reads bytes from a local R2 object binding and then constructs a redirect URL from the parsed content.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ssrf],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ssrf] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps an SSRF source finding when outbound evidence appears far after local bytes", () => {
    const filler = " The parsing notes are long and mostly about compression boundaries.".repeat(5)
    const ssrf = finding("security-0", 4, {
      category: "security",
      headline: "SSRF via Content-Type redirect",
      body: `The parser only reads bytes from a local R2 object binding.${filler} It later builds a redirect URL from parsed content and sends an outbound request.`,
    })
    const r = applySynthSourceFindingFloor({
      findings: [ssrf],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ssrf] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps an SSRF source finding when outbound evidence appears before local bytes", () => {
    const ssrf = finding("security-0", 4, {
      category: "security",
      headline: "SSRF via Content-Type redirect",
      body: "The parser builds a redirect URL and sends an outbound request before it only reads bytes from a local R2 object binding.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ssrf],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ssrf] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps a path-traversal source even when its own text argues impossibility", () => {
    const traversal = finding("security-0", 4, {
      category: "security",
      headline: "Path traversal via `baseMs`",
      body: "`baseMs` is numeric and cannot reach a filesystem path sink; there is no filesystem path sink in this code.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [traversal],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [traversal] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps a prototype-pollution source when safe-parse text is followed by a real merge sink", () => {
    const proto = finding("security-0", 4, {
      category: "security",
      headline: "Prototype pollution through parsed config merge",
      body: "`JSON.parse` alone does not pollute prototypes, but the later `Object.assign` merges parsed `__proto__` into the shared config object.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [proto],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [proto] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("does not apply text-impossibility filtering to AST findings", () => {
    const ast = finding("ast/no-prototype-pollution/abc/12", 5, {
      category: "security",
      headline: "AST-confirmed prototype pollution merge",
      body: "`JSON.parse` alone does not pollute prototypes, but the AST saw `Object.assign` merge `__proto__` into a target object.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ast],
      provenanceFindings: [prov("ast/no-prototype-pollution/abc/12")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [ast] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps a path-traversal source when numeric text does not explicitly prove impossibility", () => {
    const traversal = finding("security-0", 4, {
      category: "security",
      headline: "Path traversal in `loadConfig`",
      body: "The numeric filename suffix is attacker-controlled and there is no path sanitization before the filesystem read.",
    })
    const r = applySynthSourceFindingFloor({
      findings: [traversal],
      provenanceFindings: [prov("security-0")],
      provenanceDropped: [],
      specialists: [{ role: "security", findings: [traversal] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  it("removes a superseded source id from kept provenance instead of restoring the duplicate", () => {
    const ast = finding("ast/cents-as-dollars/abc/12", 4, {
      headline: "AST-confirmed cents-as-dollars bug",
    })
    const r = applySynthSourceFindingFloor({
      findings: [ast],
      provenanceFindings: [{
        sourceSpecialists: ["logic"],
        sourceFindingIds: ["logic-0", "ast/cents-as-dollars/abc/12"],
        action: "merged",
        verifiedViaRetrieval: true,
      }],
      provenanceDropped: [dropped("logic-0", "superseded_by_ast/ast/cents-as-dollars/abc/12")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
      astFindingIds: new Set(["ast/cents-as-dollars/abc/12"]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["ast/cents-as-dollars/abc/12"])
    expect(r.restored).toHaveLength(0)
  })

  it("does NOT re-inject a source finding explicitly superseded by a REAL AST finding", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("ast/cents-as-dollars/abc/12", 4)],
      provenanceFindings: [{
        sourceSpecialists: ["logic"],
        sourceFindingIds: ["ast/cents-as-dollars/abc/12"],
        action: "kept",
        verifiedViaRetrieval: false,
      }],
      provenanceDropped: [dropped("logic-0", "superseded_by_ast/ast/cents-as-dollars/abc/12")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
      astFindingIds: new Set(["ast/cents-as-dollars/abc/12"]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })

  // SIG-351 recall hole: the synth must not be able to SUPPRESS a score>=4 source
  // finding by citing a `superseded_by_ast/<id>` whose <id> is not a real AST
  // finding. The floor verifies <id> against the AST id set (mirroring the
  // SIG-314 kept-path guard) and RESTORES the finding when the supersession is
  // spoofed. If the AST-id check is removed, this test fails (the spoof would
  // silence the blocker).
  it("RESTORES a score>=4 source finding when superseded_by_ast cites a non-existent AST id (spoof)", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [dropped("logic-0", "superseded_by_ast/ast/cents-as-dollars/deadbee/99")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
      // The cited id is NOT in the real AST set → the supersession is rejected.
      astFindingIds: new Set(["ast/cents-as-dollars/abc/12"]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored.map((x) => x.id)).toEqual(["logic-0"])
  })

  it("keeps a score>=4 source SUPPRESSED when superseded_by_ast cites a real AST id (control)", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [dropped("logic-0", "superseded_by_ast/ast/cents-as-dollars/abc/12")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
      // The cited id IS in the real AST set → the supersession is honored.
      astFindingIds: new Set(["ast/cents-as-dollars/abc/12"]),
    })
    expect(r.findings).toHaveLength(0)
    expect(r.restored).toHaveLength(0)
  })

  it("RESTORES when no AST id set is supplied and a superseded_by_ast drop is cited (fail-safe default)", () => {
    // Omitting `astFindingIds` means no AST supersession can be verified, so a
    // `superseded_by_ast/<id>` drop is never honored → the finding is restored.
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [dropped("logic-0", "superseded_by_ast/ast/cents-as-dollars/abc/12")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 4)] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored.map((x) => x.id)).toEqual(["logic-0"])
  })

  it("restores a score>=4 source finding if the synth only labeled it duplicate without representing it", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [dropped("performance-0", "duplicate")],
      specialists: [{ role: "performance", findings: [finding("performance-0", 4)] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored.map((x) => x.id)).toEqual(["performance-0"])
  })

  it("ignores lower-severity findings so FP cleanup does not get noisier", () => {
    const r = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [],
      specialists: [{ role: "tests", findings: [finding("tests-0", 3)] }],
    })
    expect(r.findings).toHaveLength(0)
    expect(r.restored).toHaveLength(0)
  })

  it("dedupes duplicate source ids while preserving findings/provenance alignment", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("logic-kept", 4)],
      provenanceFindings: [prov("logic-kept")],
      provenanceDropped: [],
      specialists: [
        { role: "logic", findings: [finding("dup-0", 4, { headline: "low severity duplicate" })] },
        { role: "security", findings: [finding("dup-0", 5, { headline: "high severity duplicate" })] },
      ],
    })
    expect(r.findings).toHaveLength(2)
    expect(r.provenanceFindings).toHaveLength(2)
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    expect(r.restored.map((x) => x.id)).toEqual(["dup-0"])
    expect(r.restored[0]).toMatchObject({ role: "security", score: 5, headline: "high severity duplicate" })
    expect(r.findings[1]?.headline).toBe("high severity duplicate")
  })

  it("prefers security over logic for duplicate source ids with equal severity", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("logic-kept", 4)],
      provenanceFindings: [prov("logic-kept")],
      provenanceDropped: [],
      specialists: [
        { role: "logic", findings: [finding("dup-0", 4, { headline: "logic duplicate" })] },
        { role: "security", findings: [finding("dup-0", 4, { headline: "security duplicate" })] },
      ],
    })
    expect(r.findings).toHaveLength(2)
    expect(r.restored).toHaveLength(1)
    expect(r.restored[0]).toMatchObject({ role: "security", score: 4, headline: "security duplicate" })
    expect(r.findings[1]?.headline).toBe("security duplicate")
  })

  it("trims stale provenance tail before restoring so appended findings stay index-paired", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("security-0", 5)],
      // Synth wrote a provenance tail entry but no matching verdict finding.
      provenanceFindings: [prov("security-0"), prov("logic-0")],
      provenanceDropped: [],
      specialists: [
        { role: "security", findings: [finding("security-0", 5)] },
        { role: "logic", findings: [finding("logic-0", 4)] },
      ],
    })
    expect(r.findings).toHaveLength(2)
    expect(r.provenanceFindings).toHaveLength(2)
    expect(r.provenanceFindings[1]?.sourceFindingIds).toEqual(["logic-0"])
    expect(r.restored.map((x) => x.id)).toEqual(["logic-0"])
  })

  it("keeps extra synth verdict findings when provenance is shorter", () => {
    const r = applySynthSourceFindingFloor({
      findings: [finding("synth-extra", 4, { headline: "synth finding without provenance" })],
      provenanceFindings: [],
      provenanceDropped: [],
      specialists: [],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.provenanceFindings[0]).toMatchObject({
      sourceSpecialists: [],
      sourceFindingIds: [],
      action: "rewritten",
      verifiedViaRetrieval: false,
    })
    expect(r.restored).toHaveLength(0)
  })
})

// ─── SIG-317 — synth verdict-truncation recovery ──────────────────────────
import { recoverTruncatedSynthFindings } from "@/src/lib/degraded-finding-floor"

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
