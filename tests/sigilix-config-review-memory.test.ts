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
      categories: ["security", "logic", "performance", "tests"],
      maxInjectedMemories: 5,
      minSignalThreshold: 3,
      maxSignalAgeDays: 90,
    })
  })

  it("empty reviewMemory → defaults", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: {} })
    expect(r.enabled).toBe(false)
    expect(r.captureOnly).toBe(false)
    expect(r.categories).toEqual(["security", "logic", "performance", "tests"])
  })

  it("captureOnly: true alone → captureOnly true, enabled false", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: { captureOnly: true } })
    expect(r.captureOnly).toBe(true)
    expect(r.enabled).toBe(false)
  })

  it("explicit categories: [] (empty) → all 4 defaults applied", () => {
    const r = resolveReviewMemoryConfig({ reviewMemory: { categories: [] } })
    expect(r.categories).toEqual(["security", "logic", "performance", "tests"])
  })

  it("explicit categories: subset → honored", () => {
    const r = resolveReviewMemoryConfig({
      reviewMemory: { categories: ["security"] },
    })
    expect(r.categories).toEqual(["security"])
  })
})
