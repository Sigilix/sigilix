// SIG-110 — `perfBudgets` config field: parse + resolve behavior.
//
// Fail-open contract: a malformed perfBudgets block must NEVER break a
// review — bad values drop silently, never a parse error.

import { describe, it, expect } from "vitest"
import {
  parseSigilixConfig,
  resolvePerfBudgetsConfig,
} from "@/lib/sigilix-config"

describe("parseSigilixConfig — perfBudgets", () => {
  it("parses a fully populated perfBudgets block", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: {
        p50LatencyBudgetMs: 50,
        p95LatencyBudgetMs: 200,
        bundleSizeBudgetKb: 250,
        hotPaths: ["src/lib/api/**", "src/worker.ts"],
      },
    }))
    expect(cfg?.perfBudgets).toEqual({
      p50LatencyBudgetMs: 50,
      p95LatencyBudgetMs: 200,
      bundleSizeBudgetKb: 250,
      hotPaths: ["src/lib/api/**", "src/worker.ts"],
    })
  })

  it("rounds non-integer numeric budgets", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: { p95LatencyBudgetMs: 199.6, bundleSizeBudgetKb: 250.4 },
    }))
    expect(cfg?.perfBudgets?.p95LatencyBudgetMs).toBe(200)
    expect(cfg?.perfBudgets?.bundleSizeBudgetKb).toBe(250)
  })

  it("drops out-of-range latency (<=0 or absurdly large)", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: { p50LatencyBudgetMs: 0, p95LatencyBudgetMs: 99_999_999, hotPaths: ["src/x.ts"] },
    }))
    expect(cfg?.perfBudgets?.p50LatencyBudgetMs).toBeUndefined()
    expect(cfg?.perfBudgets?.p95LatencyBudgetMs).toBeUndefined()
    // hotPaths still parsed — bad numbers don't poison the whole block
    expect(cfg?.perfBudgets?.hotPaths).toEqual(["src/x.ts"])
  })

  it("drops non-number budgets (string '200' is not credited)", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: { p95LatencyBudgetMs: "200", hotPaths: ["src/x.ts"] },
    }))
    expect(cfg?.perfBudgets?.p95LatencyBudgetMs).toBeUndefined()
    expect(cfg?.perfBudgets?.hotPaths).toEqual(["src/x.ts"])
  })

  it("trims + dedupes hotPaths and drops empties / non-strings", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: { hotPaths: ["  src/a.ts ", "src/a.ts", "", 42, "src/b.ts"] },
    }))
    expect(cfg?.perfBudgets?.hotPaths).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("omits perfBudgets entirely when the block has no valid field", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      perfBudgets: { p95LatencyBudgetMs: "nope", hotPaths: [42, ""] },
    }))
    expect(cfg?.perfBudgets).toBeUndefined()
  })

  it("ignores a non-object perfBudgets (array) — fail-open, no parse error", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ perfBudgets: ["src/x.ts"] }))
    expect(cfg).not.toBeNull()
    expect(cfg?.perfBudgets).toBeUndefined()
  })
})

describe("resolvePerfBudgetsConfig", () => {
  it("defaults to all-null budgets + empty hotPaths (opt-in no-op)", () => {
    expect(resolvePerfBudgetsConfig(null)).toEqual({
      p50LatencyBudgetMs: null,
      p95LatencyBudgetMs: null,
      bundleSizeBudgetKb: null,
      hotPaths: [],
    })
  })

  it("fills in declared budgets, leaving the rest null", () => {
    const out = resolvePerfBudgetsConfig({
      perfBudgets: { p95LatencyBudgetMs: 200, hotPaths: ["src/x.ts"] },
    })
    expect(out).toEqual({
      p50LatencyBudgetMs: null,
      p95LatencyBudgetMs: 200,
      bundleSizeBudgetKb: null,
      hotPaths: ["src/x.ts"],
    })
  })
})
