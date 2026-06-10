// SIG-318 (PR 2): the findings domain unit.
//
// The exhaustive behavior tests live in tests/triage-pr-review-ensemble.test.ts
// and now run against THIS module via the god-file re-export (that's the
// zero-behavior-change proof). This file adds the PR-2-specific guarantees:
//   1. the domain module imports + works STANDALONE (no orchestrator needed),
//   2. computeConsensusRanking runs STANDALONE on a minimal `{ sourceSpecialists }`
//      shape, ranking correctly — exercising the clean-arch generalization at
//      runtime (the compile-time decoupling itself is enforced by findings.ts
//      living under src/ — it cannot import the orchestrator without tsc/the
//      planned dependency-cruiser seeing it — not by this runtime test), and
//   3. the god-file re-export surface is preserved for existing importers.

import { describe, it, expect } from "vitest"
import {
  assignStableFindingIds,
  computeConsensusRanking,
  computeFindingKey,
  computeFindingDelta,
} from "@/src/lib/ensemble/domain/findings"
import * as ensemble from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewVerdict } from "@/src/lib/triage-pr-review"

describe("SIG-318 findings domain — standalone + decoupled from the orchestrator", () => {
  it("computeFindingKey is a stable 16-hex digest (pure; imported straight from the domain)", async () => {
    const a = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    const b = await computeFindingKey("SRC/Foo.ts", "  Off-by-one in clampIndex.  ")
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toBe(a) // path lowercasing + headline normalization → same key
  })

  it("computeConsensusRanking accepts a MINIMAL { sourceSpecialists } shape (no SynthesizerProvenance)", () => {
    const verdict: PrReviewVerdict = {
      summary: "",
      confidence: 3,
      confidenceReason: "",
      findings: [
        { path: "a.ts", line: 1, score: 4, category: "logic", headline: "single", body: "" },
        { path: "b.ts", line: 2, score: 4, category: "logic", headline: "duo", body: "" },
      ],
    }
    // Only `sourceSpecialists` — NOT the orchestrator's full provenance entry
    // (action / sourceFindingIds / verifiedViaRetrieval). computeConsensusRanking
    // is generalized over the entry type (the dependency-rule fix that keeps the
    // domain free of the god-file); here we exercise that it ranks correctly on
    // that minimal shape at runtime.
    const provenance = [{ sourceSpecialists: ["logic"] }, { sourceSpecialists: ["logic", "security"] }]
    const out = computeConsensusRanking(verdict, provenance)
    expect(out.verdict.findings[0]?.headline).toBe("duo") // 2 specialists rank first
    expect(out.consensusByIndex).toEqual([2, 1])
    expect(out.provenance[0]).toBe(provenance[1]) // entries pass through, reordered
  })

  it("the god-file re-exports the findings domain unchanged (existing importers unaffected)", () => {
    expect(ensemble.assignStableFindingIds).toBe(assignStableFindingIds)
    expect(ensemble.computeConsensusRanking).toBe(computeConsensusRanking)
    expect(ensemble.computeFindingKey).toBe(computeFindingKey)
    expect(ensemble.computeFindingDelta).toBe(computeFindingDelta)
  })
})
