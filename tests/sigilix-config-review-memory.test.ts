// ARC-189 — sigilix.json `reviewMemory` config tests (Task 7).

import { describe, expect, it } from "vitest"
import {
  parseSigilixConfigDetailed,
  resolveReviewMemoryConfig,
} from "../src/lib/sigilix-config"

function parse(json: string) {
  const r = parseSigilixConfigDetailed(json)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  return r.config
}

describe("parseSigilixConfig — reviewMemory shape", () => {
  it("accepts a fully populated valid block", () => {
    const cfg = parse(
      JSON.stringify({
        reviewMemory: {
          enabled: true,
          captureOnly: true,
          categories: ["security", "performance"],
          maxInjectedMemories: 3,
          minSignalThreshold: 5,
          maxSignalAgeDays: 60,
        },
      }),
    )
    expect(cfg.reviewMemory).toEqual({
      enabled: true,
      captureOnly: true,
      categories: ["security", "performance"],
      maxInjectedMemories: 3,
      minSignalThreshold: 5,
      maxSignalAgeDays: 60,
    })
  })

  it("SIG-280: claimSoftening survives the parser → resolve round-trip (PR #210 CR catch)", () => {
    // The earlier resolve test passed a RAW object to resolveReviewMemoryConfig,
    // bypassing the parser whitelist — which had silently dropped the field.
    // This exercises the REAL sigilix.json load path: parse → resolve.
    const cfg = parse(JSON.stringify({ reviewMemory: { claimSoftening: true } }))
    expect(cfg.reviewMemory?.claimSoftening).toBe(true)
    expect(resolveReviewMemoryConfig(cfg).claimSoftening).toBe(true)
    // strict-bool through the parser: a non-bool is dropped → resolves false
    const cfg2 = parse(JSON.stringify({ reviewMemory: { claimSoftening: "yes" } }))
    expect(cfg2.reviewMemory?.claimSoftening).toBeUndefined()
    expect(resolveReviewMemoryConfig(cfg2).claimSoftening).toBe(false)
  })

  it("strict-bool: truthy non-bool enabled is rejected", () => {
    const cfg = parse(
      JSON.stringify({ reviewMemory: { enabled: 1 } }),
    )
    expect(cfg.reviewMemory?.enabled).toBeUndefined()
  })

  it("strict-bool: string `true` is rejected", () => {
    const cfg = parse(
      JSON.stringify({ reviewMemory: { enabled: "true" } }),
    )
    expect(cfg.reviewMemory?.enabled).toBeUndefined()
  })

  it("dedupes + drops bogus categories", () => {
    const cfg = parse(
      JSON.stringify({
        reviewMemory: {
          categories: ["security", "bogus", "security", "logic", "  "],
        },
      }),
    )
    expect(cfg.reviewMemory?.categories).toEqual(["security", "logic"])
  })

  it("drops the categories field entirely on non-array input", () => {
    const cfg = parse(
      JSON.stringify({ reviewMemory: { categories: "security" } }),
    )
    expect(cfg.reviewMemory?.categories).toBeUndefined()
  })

  it("clamps maxInjectedMemories to [1, 10]", () => {
    expect(parse(JSON.stringify({ reviewMemory: { maxInjectedMemories: 0 } }))
      .reviewMemory?.maxInjectedMemories).toBe(1)
    expect(parse(JSON.stringify({ reviewMemory: { maxInjectedMemories: 100 } }))
      .reviewMemory?.maxInjectedMemories).toBe(10)
    expect(parse(JSON.stringify({ reviewMemory: { maxInjectedMemories: 5 } }))
      .reviewMemory?.maxInjectedMemories).toBe(5)
  })

  it("clamps minSignalThreshold to [2, 20]", () => {
    expect(parse(JSON.stringify({ reviewMemory: { minSignalThreshold: 1 } }))
      .reviewMemory?.minSignalThreshold).toBe(2)
    expect(parse(JSON.stringify({ reviewMemory: { minSignalThreshold: 999 } }))
      .reviewMemory?.minSignalThreshold).toBe(20)
  })

  it("clamps maxSignalAgeDays to [7, 365]", () => {
    expect(parse(JSON.stringify({ reviewMemory: { maxSignalAgeDays: 1 } }))
      .reviewMemory?.maxSignalAgeDays).toBe(7)
    expect(parse(JSON.stringify({ reviewMemory: { maxSignalAgeDays: 999 } }))
      .reviewMemory?.maxSignalAgeDays).toBe(365)
  })

  it("non-number for clamp inputs ignored entirely", () => {
    const cfg = parse(JSON.stringify({
      reviewMemory: { maxInjectedMemories: "five" },
    }))
    expect(cfg.reviewMemory?.maxInjectedMemories).toBeUndefined()
  })

  it("entire block ignored when reviewMemory is wrong shape (array)", () => {
    const cfg = parse(JSON.stringify({ reviewMemory: ["a", "b"] }))
    expect(cfg.reviewMemory).toBeUndefined()
  })
})

describe("resolveReviewMemoryConfig — defaults + clamps", () => {
  it("default config (null) → all defaults, both bools OFF", () => {
    const r = resolveReviewMemoryConfig(null)
    expect(r).toEqual({
      enabled: false,
      captureOnly: false,
      // SIG-247 Phase 0: default categories expanded from 4 to 5
      // (added "architecture"). Was ["security", "logic",
      // "performance", "tests"] until 2026-05-27.
      categories: ["security", "logic", "performance", "tests", "architecture"],
      maxInjectedMemories: 5,
      minSignalThreshold: 3,
      maxSignalAgeDays: 90,
      // SIG-280 Phase 4 PR A: strict-bool, default off. Surface only — no
      // behavior wired off it yet (Phase 4 PR C's soften gate consumes it).
      claimSoftening: false,
    })
  })

  it("SIG-280: claimSoftening is strict-bool — true only on literal true", () => {
    expect(resolveReviewMemoryConfig({ reviewMemory: { claimSoftening: true } }).claimSoftening).toBe(true)
    expect(resolveReviewMemoryConfig({ reviewMemory: { claimSoftening: false } }).claimSoftening).toBe(false)
    expect(resolveReviewMemoryConfig({ reviewMemory: {} }).claimSoftening).toBe(false)
    // non-true values do not enable (mirrors enabled/captureOnly polarity)
    expect(resolveReviewMemoryConfig({ reviewMemory: { claimSoftening: "yes" as unknown as boolean } }).claimSoftening).toBe(false)
  })

  it("empty reviewMemory → defaults", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: {} })
    expect(r.enabled).toBe(false)
    expect(r.captureOnly).toBe(false)
    expect(r.categories).toEqual(["security", "logic", "performance", "tests", "architecture"])
  })

  it("captureOnly: true alone → captureOnly true, enabled false", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: { captureOnly: true } })
    expect(r.captureOnly).toBe(true)
    expect(r.enabled).toBe(false)
  })

  it("explicit categories: [] (empty) → all 5 defaults applied (SIG-247 Phase 0)", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: { categories: [] } })
    expect(r.categories).toEqual(["security", "logic", "performance", "tests", "architecture"])
  })

  it("recognizes 'architecture' as a valid category (SIG-247 Phase 0)", () => {
    // Defense-in-depth: confirm the membership Set was extended too.
    // Without the Set update, "architecture" would be silently dropped
    // by the dedupe loop in parseSigilixConfig, even though the
    // default-resolution path includes it.
    const r = resolveReviewMemoryConfig({
      reviewMemory: { categories: ["architecture", "security"] },
    })
    expect(r.categories).toEqual(["architecture", "security"])
  })

  it("explicit categories: subset → honored", () => {
    const r = resolveReviewMemoryConfig({
      reviewMemory: { categories: ["security"] },
    })
    expect(r.categories).toEqual(["security"])
  })
})
