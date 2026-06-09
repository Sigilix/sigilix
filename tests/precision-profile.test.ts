// SIG-147: precision-profile core — EMA rollup, review-time apply, KV round-trip.

import { describe, expect, it } from "vitest"

import {
  EMA_ALPHA,
  MIN_OBSERVATIONS,
  SUPPRESS_THRESHOLD,
  emptyProfile,
  foldOutcomeIntoProfile,
  isCategoryBoosted,
  isPatternSuppressed,
  outcomeTargets,
  prunePatterns,
  MAX_PATTERNS,
} from "../src/lib/precision-profile/ema"
import { applyPrecisionProfile } from "../src/lib/precision-profile/apply"
import { loadPrecisionProfile, recordOutcome } from "../src/lib/precision-profile/store"
import type { OutcomeEvent, PatternStat, PrecisionProfile } from "../src/lib/precision-profile/types"
import type { Env } from "../src/shared/types/env"

const TS = "2026-06-04T00:00:00.000Z"
const ev = (outcome: OutcomeEvent["outcome"], patternHash = "p1", category: OutcomeEvent["category"] = "logic"): OutcomeEvent =>
  ({ repoId: "r1", category, patternHash, outcome })

// ── EMA rollup ────────────────────────────────────────────────────

describe("outcomeTargets", () => {
  it("maps dismissed/accepted/stale to the right EMA targets", () => {
    expect(outcomeTargets("dismissed")).toEqual({ patternSuppress: 1, categoryBoost: 0 })
    expect(outcomeTargets("accepted")).toEqual({ patternSuppress: 0, categoryBoost: 1 })
    expect(outcomeTargets("stale")).toEqual({ patternSuppress: 0 })
  })
})

describe("foldOutcomeIntoProfile", () => {
  it("raises a pattern's suppress EMA toward 1 on repeated dismissals", () => {
    let p = emptyProfile("r1", TS)
    for (let i = 0; i < 5; i++) p = foldOutcomeIntoProfile(p, ev("dismissed"), TS)
    const stat = p.patterns["p1"]!
    expect(stat.n).toBe(5)
    expect(stat.suppress).toBeGreaterThan(SUPPRESS_THRESHOLD)
    expect(isPatternSuppressed(stat)).toBe(true)
  })

  it("first dismissal applies exactly alpha (EMA from 0)", () => {
    const p = foldOutcomeIntoProfile(emptyProfile("r1", TS), ev("dismissed"), TS)
    expect(p.patterns["p1"]!.suppress).toBeCloseTo(EMA_ALPHA) // 0.3*1 + 0.7*0
  })

  it("does NOT suppress below MIN_OBSERVATIONS even at high EMA", () => {
    let p = emptyProfile("r1", TS)
    for (let i = 0; i < MIN_OBSERVATIONS - 1; i++) p = foldOutcomeIntoProfile(p, ev("dismissed"), TS)
    expect(isPatternSuppressed(p.patterns["p1"])).toBe(false) // n < 3
  })

  it("a later acceptance / stale relaxes a suppressed pattern back down", () => {
    let p = emptyProfile("r1", TS)
    for (let i = 0; i < 6; i++) p = foldOutcomeIntoProfile(p, ev("dismissed"), TS)
    expect(isPatternSuppressed(p.patterns["p1"])).toBe(true)
    for (let i = 0; i < 6; i++) p = foldOutcomeIntoProfile(p, ev("stale"), TS)
    expect(p.patterns["p1"]!.suppress).toBeLessThan(SUPPRESS_THRESHOLD) // decayed toward 0
  })

  it("raises a category's boost EMA on repeated acceptances", () => {
    let p = emptyProfile("r1", TS)
    for (let i = 0; i < 5; i++) p = foldOutcomeIntoProfile(p, ev("accepted", "p1", "security"), TS)
    expect(isCategoryBoosted(p.categories["security"])).toBe(true)
  })

  it("stale carries no category signal", () => {
    const p = foldOutcomeIntoProfile(emptyProfile("r1", TS), ev("stale"), TS)
    expect(p.categories["logic"]).toBeUndefined()
  })
})

describe("prunePatterns", () => {
  it("keeps the MAX_PATTERNS most-recent patterns", () => {
    const patterns: Record<string, PatternStat> = {}
    for (let i = 0; i < MAX_PATTERNS + 10; i++) {
      patterns[`p${i}`] = { suppress: 0.5, n: 1, lastTs: new Date(1700000000000 + i * 1000).toISOString() }
    }
    const pruned = prunePatterns(patterns)
    expect(Object.keys(pruned).length).toBe(MAX_PATTERNS)
    expect(pruned[`p${MAX_PATTERNS + 9}`]).toBeDefined() // newest kept
    expect(pruned["p0"]).toBeUndefined() // oldest evicted
  })
})

// ── review-time apply ─────────────────────────────────────────────

describe("applyPrecisionProfile", () => {
  const suppressedProfile = (): PrecisionProfile => ({
    schemaVersion: 1,
    repoId: "r1",
    patterns: { fp1: { suppress: 0.9, n: 5, lastTs: TS } },
    categories: { security: { boost: 0.8, n: 5, lastTs: TS } },
    updatedTs: TS,
  })
  const findings = [
    { category: "logic" as const, contentFingerprint: "fp1", score: 2 },   // suppressed pattern (P3)
    { category: "security" as const, contentFingerprint: "fp2", score: 3 },// boosted category
    { category: "docs" as const, contentFingerprint: "fp3", score: 1 },    // neither
    { category: "logic" as const, score: 2 },                              // no fingerprint → never suppressed
  ]

  it("enforce drops suppressed patterns; flags boosted categories", () => {
    const r = applyPrecisionProfile(findings, suppressedProfile(), { enforce: true })
    expect(r.kept).toHaveLength(3) // fp1 dropped
    expect(r.suppressed.map((s) => s.finding.contentFingerprint)).toEqual(["fp1"])
    expect(r.boosted.map((b) => b.finding.category)).toEqual(["security"])
  })

  it("recall-safety: NEVER suppresses a P0/P1 (score 4 or 5) at the floor boundary; a P2 (3) IS suppressed", () => {
    const hot = (score: number) => ({ category: "logic" as const, contentFingerprint: "fp1", score })
    // P1 = floor boundary (score === SUPPRESS_FLOOR_TIER) and P0 must both survive.
    expect(applyPrecisionProfile([hot(4)], suppressedProfile(), { enforce: true }).suppressed).toHaveLength(0)
    expect(applyPrecisionProfile([hot(5)], suppressedProfile(), { enforce: true }).suppressed).toHaveLength(0)
    // P2 (just below the floor) on the same hot pattern IS suppressed.
    expect(applyPrecisionProfile([hot(3)], suppressedProfile(), { enforce: true }).suppressed).toHaveLength(1)
  })

  it("shadow keeps everything but still reports suppressed/boosted", () => {
    const r = applyPrecisionProfile(findings, suppressedProfile(), { enforce: false })
    expect(r.kept).toHaveLength(4) // nothing dropped
    expect(r.suppressed).toHaveLength(1)
    expect(r.boosted).toHaveLength(1)
  })

  it("a null profile is a clean passthrough", () => {
    const r = applyPrecisionProfile(findings, null, { enforce: true })
    expect(r.kept).toHaveLength(4)
    expect(r.suppressed).toHaveLength(0)
  })

  it("never suppresses a finding without a fingerprint", () => {
    const r = applyPrecisionProfile([{ category: "logic" as const, score: 2 }], suppressedProfile(), { enforce: true })
    expect(r.kept).toHaveLength(1)
  })
})

// ── KV store round-trip ───────────────────────────────────────────

function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
  }
  return { OPENCLAW_STATE: kv } as unknown as Env
}

describe("recordOutcome / loadPrecisionProfile round-trip", () => {
  it("persists and reloads an EMA-updated profile that crosses the suppress threshold", async () => {
    const env = makeEnv()
    for (let i = 0; i < 5; i++) {
      await recordOutcome(env, ev("dismissed"), Date.parse(TS) + i * 1000)
    }
    const loaded = await loadPrecisionProfile(env, "r1")
    expect(loaded).not.toBeNull()
    expect(isPatternSuppressed(loaded!.patterns["p1"])).toBe(true)
  })

  it("returns null on a cache miss", async () => {
    expect(await loadPrecisionProfile(makeEnv(), "nope")).toBeNull()
  })

  it("rejects an array-shaped payload (typeof [] === 'object')", async () => {
    const env = makeEnv()
    await env.OPENCLAW_STATE.put(
      "precision-profile:repo:r1",
      JSON.stringify({ schemaVersion: 1, repoId: "r1", patterns: [], categories: [] }),
    )
    expect(await loadPrecisionProfile(env, "r1")).toBeNull()
  })

  it("recordOutcome does NOT clobber the stored profile when the KV read throws", async () => {
    const store = new Map<string, string>()
    let failGet = false
    const env = {
      OPENCLAW_STATE: {
        async get(k: string) { if (failGet) throw new Error("KV transient"); return store.get(k) ?? null },
        async put(k: string, v: string) { store.set(k, v) },
      },
    } as unknown as Env
    for (let i = 0; i < 5; i++) await recordOutcome(env, ev("dismissed"), Date.parse(TS) + i)
    const before = store.get("precision-profile:repo:r1")
    failGet = true
    const ok = await recordOutcome(env, ev("dismissed"), Date.parse(TS) + 100)
    expect(ok).toBe(false) // best-effort failure, non-fatal
    expect(store.get("precision-profile:repo:r1")).toBe(before) // profile preserved, not overwritten
  })
})

// ── end-to-end: dismiss → profile → review-time suppression ───────

describe("E2E: repeated dismissals suppress a content-equivalent re-fire at the gate", () => {
  it("a P3 finding whose pattern was repeatedly dismissed is dropped in enforce; a P0 never is", async () => {
    const env = makeEnv()
    // 5 dismissals of the same pattern (fp-noise) across pushes — the real
    // github-mention path calls recordOutcome("dismissed") exactly like this.
    for (let i = 0; i < 5; i++) {
      await recordOutcome(env, ev("dismissed", "fp-noise", "style"), Date.parse(TS) + i)
    }
    const profile = await loadPrecisionProfile(env, "r1") // the ensemble gate loads this

    // Next review re-emits the same noisy pattern (new finding ID, same fingerprint)
    // plus an unrelated critical — exactly the gate's input set.
    const findings = [
      { category: "style" as const, contentFingerprint: "fp-noise", score: 2 },     // repeatedly dismissed P3
      { category: "style" as const, contentFingerprint: "fp-noise", score: 5 },      // SAME pattern but P0
      { category: "security" as const, contentFingerprint: "fp-real", score: 4 },    // never dismissed
    ]
    const r = applyPrecisionProfile(findings, profile, { enforce: true })

    expect(r.kept.map((f) => f.contentFingerprint + ":" + f.score)).toEqual([
      "fp-noise:5", // P0 kept (recall-safety)
      "fp-real:4",  // untouched
    ])
    expect(r.suppressed).toHaveLength(1) // only the P3 noise dropped
    expect(r.suppressed[0]!.finding.score).toBe(2)
  })
})
