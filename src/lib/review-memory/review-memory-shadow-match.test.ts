// SIG-276 Phase 3 — shadow claim matcher (pure) tests.

import { describe, expect, it } from "vitest"
import {
  shadowMatchReviewMemoryClaims,
  resolveClaimShadowMode,
  SHADOW_DISTINCT_PR_FLOOR,
  type ShadowMatchFinding,
} from "@/src/lib/review-memory/shadow-match"
import type { ReviewMemoryFinding, ReviewMemoryShadowClaim } from "@/src/lib/review-memory/types"

function shadowClaim(
  over: Partial<ReviewMemoryShadowClaim> & { type: ReviewMemoryShadowClaim["type"] },
): ReviewMemoryShadowClaim {
  return {
    distinctPrCount: 3,
    signalCount: 3,
    lastSignalTs: new Date().toISOString(),
    extractorVersions: [1],
    rawConfidences: [0.8],
    ...over,
  }
}

function catMemory(
  category: ReviewMemoryFinding["category"],
  shadowClaims: ReviewMemoryShadowClaim[],
): ReviewMemoryFinding {
  return {
    scope: "category",
    category,
    signalCount: 3,
    lastSignalTs: new Date().toISOString(),
    suggestedAction: "soften",
    shadowClaims,
  }
}

function pathMemory(
  category: ReviewMemoryFinding["category"],
  pathSha12: string,
  shadowClaims: ReviewMemoryShadowClaim[],
): ReviewMemoryFinding {
  return {
    scope: "path-category",
    category,
    pathSha12,
    signalCount: 3,
    lastSignalTs: new Date().toISOString(),
    suggestedAction: "soften",
    shadowClaims,
  }
}

function finding(over: Partial<ShadowMatchFinding> = {}): ShadowMatchFinding {
  return {
    category: "logic",
    pathSha12: "aaaaaaaaaaaa",
    fid: "abcd1234abcd1234",
    severityTier: "P2",
    claims: [{ type: "structural-glue-not-test-target", extractorVersion: 1 }],
    ...over,
  }
}

describe("resolveClaimShadowMode (SIG-280 flag enum)", () => {
  it("maps on→shadow, render→render, soften→soften, else→off", () => {
    expect(resolveClaimShadowMode("on")).toBe("shadow")
    expect(resolveClaimShadowMode("render")).toBe("render")
    expect(resolveClaimShadowMode("soften")).toBe("soften")
    expect(resolveClaimShadowMode("off")).toBe("off")
    expect(resolveClaimShadowMode(undefined)).toBe("off")
    expect(resolveClaimShadowMode("garbage")).toBe("off")
  })
  it("render and soften are non-off (so the shadow pass runs in PR A)", () => {
    expect(resolveClaimShadowMode("render") !== "off").toBe(true)
    expect(resolveClaimShadowMode("soften") !== "off").toBe(true)
  })
})

describe("shadowMatchReviewMemoryClaims (pure)", () => {
  it("returns [] for no findings", () => {
    expect(shadowMatchReviewMemoryClaims({ memories: [], findings: [] })).toEqual([])
  })

  it("SIG-280: every emitted row carries the finding's fid + severityTier (tier 1/2)", () => {
    const memories = [pathMemory("logic", "aaaaaaaaaaaa", [shadowClaim({ type: "structural-glue-not-test-target" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ fid: "ffff0000ffff0000", severityTier: "P0" })],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.fid).toBe("ffff0000ffff0000")
    expect(out[0]!.severityTier).toBe("P0")
  })

  it("SIG-280: category-no-claim-match (tier 3) rows also carry fid + severityTier", () => {
    const memories = [catMemory("logic", [shadowClaim({ type: "auth-gate-is-boundary" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ fid: "1111222233334444", severityTier: "P1", claims: [] })],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("category-no-claim-match")
    expect(out[0]!.fid).toBe("1111222233334444")
    expect(out[0]!.severityTier).toBe("P1")
  })

  it("skips a finding with null category", () => {
    const memories = [catMemory("logic", [shadowClaim({ type: "structural-glue-not-test-target" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ category: null })],
    })
    expect(out).toEqual([])
  })

  it("emits a path-category tier row when path + claim type match", () => {
    const memories = [
      pathMemory("logic", "aaaaaaaaaaaa", [
        shadowClaim({ type: "structural-glue-not-test-target", distinctPrCount: 4 }),
      ]),
    ]
    const out = shadowMatchReviewMemoryClaims({ memories, findings: [finding()] })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("path-category")
    expect(out[0]!.claimType).toBe("structural-glue-not-test-target")
    expect(out[0]!.distinctPrCount).toBe(4)
    expect(out[0]!.categoryOnlyWouldAlsoFire).toBe(false) // no category memory present
  })

  it("emits a category tier row when only the category matches; categoryOnlyWouldAlsoFire=true", () => {
    const memories = [catMemory("logic", [shadowClaim({ type: "structural-glue-not-test-target" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ pathSha12: "zzzzzzzzzzzz" })], // path won't match
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("category")
    expect(out[0]!.categoryOnlyWouldAlsoFire).toBe(true)
  })

  it("prefers path-category over category for the same claim type (deduped to one row)", () => {
    const memories = [
      catMemory("logic", [shadowClaim({ type: "structural-glue-not-test-target" })]),
      pathMemory("logic", "aaaaaaaaaaaa", [shadowClaim({ type: "structural-glue-not-test-target" })]),
    ]
    const out = shadowMatchReviewMemoryClaims({ memories, findings: [finding()] })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("path-category")
    expect(out[0]!.categoryOnlyWouldAlsoFire).toBe(true) // category memory also present
  })

  it("emits a category-no-claim-match tier row when category fires but no claim intersects", () => {
    const memories = [catMemory("logic", [shadowClaim({ type: "auth-gate-is-boundary" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ claims: [{ type: "structural-glue-not-test-target", extractorVersion: 1 }] })],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("category-no-claim-match")
    expect(out[0]!.claimType).toBeNull()
    expect(out[0]!.categoryOnlyWouldAlsoFire).toBe(true)
  })

  it("emits category-no-claim-match when the finding carries NO claims but the category memory is active", () => {
    const memories = [catMemory("logic", [shadowClaim({ type: "auth-gate-is-boundary" })])]
    const out = shadowMatchReviewMemoryClaims({ memories, findings: [finding({ claims: [] })] })
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("category-no-claim-match")
  })

  it("emits nothing when neither category nor path memory applies", () => {
    const memories = [catMemory("security", [shadowClaim({ type: "auth-gate-is-boundary" })])]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ category: "logic" })],
    })
    expect(out).toEqual([])
  })

  it("sets version_mismatch when the incoming extractor version is not in the stored set", () => {
    const memories = [
      catMemory("logic", [shadowClaim({ type: "structural-glue-not-test-target", extractorVersions: [1] })]),
    ]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [finding({ claims: [{ type: "structural-glue-not-test-target", extractorVersion: 2 }] })],
    })
    expect(out[0]!.version_mismatch).toBe(true)
  })

  it("wouldSoftenAtFloor reflects distinctPrCount vs the floor", () => {
    const below = shadowMatchReviewMemoryClaims({
      memories: [
        pathMemory("logic", "aaaaaaaaaaaa", [
          shadowClaim({
            type: "structural-glue-not-test-target",
            distinctPrCount: SHADOW_DISTINCT_PR_FLOOR - 1,
          }),
        ]),
      ],
      findings: [finding()],
    })
    expect(below[0]!.wouldSoftenAtFloor).toBe(false)
    const at = shadowMatchReviewMemoryClaims({
      memories: [
        pathMemory("logic", "aaaaaaaaaaaa", [
          shadowClaim({
            type: "structural-glue-not-test-target",
            distinctPrCount: SHADOW_DISTINCT_PR_FLOOR,
          }),
        ]),
      ],
      findings: [finding()],
    })
    expect(at[0]!.wouldSoftenAtFloor).toBe(true)
  })

  it("PRIVACY: every emitted row carries ONLY the enum/number/bool allowlist (no free-text surface)", () => {
    const memories = [
      catMemory("logic", [shadowClaim({ type: "structural-glue-not-test-target" })]),
      pathMemory("logic", "aaaaaaaaaaaa", [shadowClaim({ type: "auth-gate-is-boundary" })]),
    ]
    const out = shadowMatchReviewMemoryClaims({
      memories,
      findings: [
        finding({ claims: [{ type: "auth-gate-is-boundary", extractorVersion: 1 }] }),
        finding({ category: "security", claims: [] }), // no security memory → no row
      ],
    })
    const ALLOWED = new Set([
      "fid",
      "severityTier",
      "claimType",
      "matchedTier",
      "distinctPrCount",
      "signalCount",
      "lastSignalTs",
      "categoryOnlyWouldAlsoFire",
      "wouldSoftenAtFloor",
      "version_mismatch",
      "rawConfidences",
    ])
    expect(out.length).toBeGreaterThan(0)
    for (const row of out) {
      for (const k of Object.keys(row)) expect(ALLOWED.has(k)).toBe(true)
    }
  })

  it("treats a memory with undefined shadowClaims as a non-match (defensive)", () => {
    const mem: ReviewMemoryFinding = {
      scope: "category",
      category: "logic",
      signalCount: 3,
      lastSignalTs: new Date().toISOString(),
      suggestedAction: "soften",
      // shadowClaims intentionally absent
    }
    const out = shadowMatchReviewMemoryClaims({ memories: [mem], findings: [finding()] })
    // category memory present but no shadowClaims → category-no-claim-match
    expect(out).toHaveLength(1)
    expect(out[0]!.matchedTier).toBe("category-no-claim-match")
  })
})
