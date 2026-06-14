// SIG-417 — pure cost-projection math + the dark-governor trim. These pin the
// recall floors that keep the (default-off) trim safe: never below the floor,
// never a high-risk file, never a scanner-hit (protected) file.

import { describe, expect, it } from "vitest"
import {
  projectReviewCostUsd,
  applyCostGovernorTrim,
  type TrimCandidate,
} from "@/src/lib/ensemble/domain/cost-projection"
import { pricingForModel } from "@/src/shared/domain/model-pricing"

// ─── projectReviewCostUsd ───────────────────────────────────────────

describe("projectReviewCostUsd", () => {
  it("prices each model on (diff + overhead) INPUT tokens at its input rate", () => {
    // 1 specialist + synth, 1M diff tokens + 0 overhead. openai/o3 input = 2.0,
    // nemotron input = 0.5 → 2.5 total.
    const p = projectReviewCostUsd({
      specialistModels: ["openai/o3"],
      synthModel: "nvidia/nemotron-3-ultra-550b-a55b",
      reviewedDiffTokens: 1_000_000,
      perCallOverheadTokensEst: 0,
    })
    expect(p.perCallInputTokens).toBe(1_000_000)
    expect(p.projectedUsd).toBeCloseTo(2.5, 6)
    expect(p.byModelUsd["openai/o3"]).toBeCloseTo(2.0, 6)
    expect(p.byModelUsd["nvidia/nemotron-3-ultra-550b-a55b"]).toBeCloseTo(0.5, 6)
  })

  it("adds the per-call overhead to the diff tokens for every model", () => {
    // 0.5M diff + 0.5M overhead = 1M per call. One model at 2.0/MTok = 2.0.
    const p = projectReviewCostUsd({
      specialistModels: ["openai/o3"],
      synthModel: "openai/o3",
      reviewedDiffTokens: 500_000,
      perCallOverheadTokensEst: 500_000,
    })
    expect(p.perCallInputTokens).toBe(1_000_000)
    // openai/o3 appears twice (specialist + synth) → 2 × 2.0 = 4.0.
    expect(p.projectedUsd).toBeCloseTo(4.0, 6)
    expect(p.byModelUsd["openai/o3"]).toBeCloseTo(4.0, 6)
  })

  it("falls back to DEFAULT_PRICING for an unknown model (never $0)", () => {
    const p = projectReviewCostUsd({
      specialistModels: ["totally-made-up-model"],
      synthModel: "totally-made-up-model",
      reviewedDiffTokens: 1_000_000,
      perCallOverheadTokensEst: 0,
    })
    // 2 calls × DEFAULT input rate.
    expect(p.projectedUsd).toBeCloseTo(2 * pricingForModel("totally-made-up-model").inputPerMTokUsd, 6)
  })

  it("clamps negative inputs to 0", () => {
    const p = projectReviewCostUsd({
      specialistModels: ["openai/o3"],
      synthModel: "openai/o3",
      reviewedDiffTokens: -100,
      perCallOverheadTokensEst: -50,
    })
    expect(p.perCallInputTokens).toBe(0)
    expect(p.projectedUsd).toBe(0)
  })
})

// ─── applyCostGovernorTrim ──────────────────────────────────────────

interface F extends TrimCandidate {
  path: string
}
const f = (path: string): F => ({ path })

// A simple cost model for the trim tests: each file costs $1, projection = file
// count. Lets us reason about the ceiling in plain integers.
const dollarPerFile = (kept: readonly F[]): number => kept.length

describe("applyCostGovernorTrim", () => {
  it("trims the lowest-risk TAIL until the projection is at/under the ceiling", () => {
    const reviewed = [f("a"), f("b"), f("c"), f("d"), f("e")] // risk-ordered, $5
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 3,
      minReviewedFiles: 1,
      isHighRisk: () => false,
      protectedPaths: new Set(),
    })
    expect(r.kept.map((x) => x.path)).toEqual(["a", "b", "c"])
    expect(r.trimmed.map((x) => x.path)).toEqual(["e", "d"]) // tail first
    expect(r.projectedUsd).toBe(3)
    expect(r.ceilingUnmet).toBe(false)
  })

  it("never trims below minReviewedFiles (floor stops it; ceilingUnmet=true)", () => {
    const reviewed = [f("a"), f("b"), f("c")] // $3
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 1, // wants 1 file
      minReviewedFiles: 2, // floor at 2
      isHighRisk: () => false,
      protectedPaths: new Set(),
    })
    expect(r.kept.length).toBe(2)
    expect(r.projectedUsd).toBe(2)
    expect(r.ceilingUnmet).toBe(true) // still over the $1 ceiling
  })

  it("never trims a high-risk file — skips it and trims the next-lowest", () => {
    // 'e' (tail, lowest risk) is high-risk → keep it; trim 'd' then 'c'.
    const reviewed = [f("a"), f("b"), f("c"), f("d"), f("e")]
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 3,
      minReviewedFiles: 1,
      isHighRisk: (p) => p === "e",
      protectedPaths: new Set(),
    })
    expect(r.kept.map((x) => x.path).sort()).toEqual(["a", "b", "e"])
    expect(r.trimmed.map((x) => x.path)).toEqual(["d", "c"])
    expect(r.projectedUsd).toBe(3)
  })

  it("never trims a protected (scanner-hit) file, even when it forces over-budget — Codex sign-off #3", () => {
    // Protected files MUST stay (they carry potential P0/P1 the cheap scanners
    // would otherwise lose). The governor trims the UNPROTECTED files lowest-risk
    // first; protected files are skipped no matter what.
    const reviewed = [f("a"), f("b"), f("c"), f("d")]
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 1, // wants $1, but c+d are protected ($2 floor from protection)
      minReviewedFiles: 1,
      isHighRisk: () => false,
      protectedPaths: new Set(["c", "d"]),
    })
    // c + d untrimmable; b then a are trimmed (tail-first among the unprotected),
    // but the protected pair keeps us at $2 > ceiling 1 → ceilingUnmet.
    expect(r.kept.map((x) => x.path).sort()).toEqual(["c", "d"])
    expect(r.trimmed.map((x) => x.path)).toEqual(["b", "a"])
    expect(r.ceilingUnmet).toBe(true)
  })

  it("stops trimming as soon as the ceiling is met, even with trimmable files left", () => {
    // ceiling 3, all trimmable → trim only the one tail file needed to reach $3.
    const reviewed = [f("a"), f("b"), f("c"), f("d")] // $4
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 3,
      minReviewedFiles: 1,
      isHighRisk: () => false,
      protectedPaths: new Set(),
    })
    expect(r.kept.map((x) => x.path)).toEqual(["a", "b", "c"])
    expect(r.trimmed.map((x) => x.path)).toEqual(["d"])
    expect(r.ceilingUnmet).toBe(false)
  })

  it("is a no-op when already at/under the ceiling", () => {
    const reviewed = [f("a"), f("b")] // $2
    const r = applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 5,
      minReviewedFiles: 1,
      isHighRisk: () => false,
      protectedPaths: new Set(),
    })
    expect(r.kept.map((x) => x.path)).toEqual(["a", "b"])
    expect(r.trimmed).toEqual([])
    expect(r.ceilingUnmet).toBe(false)
  })

  it("does not mutate the input array", () => {
    const reviewed = [f("a"), f("b"), f("c")]
    const before = reviewed.map((x) => x.path)
    applyCostGovernorTrim<F>({
      reviewedFiles: reviewed,
      projectUsdForFiles: dollarPerFile,
      ceilingUsd: 1,
      minReviewedFiles: 1,
      isHighRisk: () => false,
      protectedPaths: new Set(),
    })
    expect(reviewed.map((x) => x.path)).toEqual(before)
  })
})
