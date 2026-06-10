// SIG-110 PR B — tests for the zero-LLM perf-budgets hot-path check.

import { describe, expect, it } from "vitest"
import {
  runPerfBudgetsCheck,
  renderPerfBudgetsForPrompt,
} from "@/shared/domain/perf-budgets"

const baseConfig = {
  p50LatencyBudgetMs: 50,
  p95LatencyBudgetMs: 200,
  bundleSizeBudgetKb: 250,
  hotPaths: ["src/lib/api/**", "src/worker.ts"],
}

describe("runPerfBudgetsCheck", () => {
  it("returns null when hotPaths is empty (operator hasn't opted in)", () => {
    const out = runPerfBudgetsCheck(["src/lib/api/orders.ts"], {
      ...baseConfig,
      hotPaths: [],
    })
    expect(out).toBeNull()
  })

  it("returns null when changedPaths is empty", () => {
    const out = runPerfBudgetsCheck([], baseConfig)
    expect(out).toBeNull()
  })

  it("returns null when no changed file matches a hotPaths glob", () => {
    const out = runPerfBudgetsCheck(
      ["tests/foo.test.ts", "README.md"],
      baseConfig,
    )
    expect(out).toBeNull()
  })

  it("emits a hit when a changed file matches a hotPaths glob", () => {
    const out = runPerfBudgetsCheck(
      ["src/lib/api/orders.ts", "src/lib/util.ts"],
      baseConfig,
    )
    expect(out).not.toBeNull()
    expect(out!.hotPathFiles).toEqual(["src/lib/api/orders.ts"])
    expect(out!.matchedHotPaths).toEqual(["src/lib/api/**"])
    expect(out!.budgets.p95LatencyBudgetMs).toBe(200)
  })

  it("matches a bare-file hotPath glob", () => {
    const out = runPerfBudgetsCheck(["src/worker.ts"], baseConfig)
    expect(out).not.toBeNull()
    expect(out!.hotPathFiles).toEqual(["src/worker.ts"])
    expect(out!.matchedHotPaths).toEqual(["src/worker.ts"])
  })

  it("reports every matched glob, deduped, when multiple match", () => {
    const out = runPerfBudgetsCheck(
      ["src/lib/api/orders.ts", "src/lib/api/users.ts", "src/worker.ts"],
      baseConfig,
    )
    expect(out!.hotPathFiles).toEqual([
      "src/lib/api/orders.ts",
      "src/lib/api/users.ts",
      "src/worker.ts",
    ])
    expect(out!.matchedHotPaths).toEqual(["src/lib/api/**", "src/worker.ts"])
  })

  it("caps hotPathFiles at 10 (prompt-size safety)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/lib/api/f${i}.ts`)
    const out = runPerfBudgetsCheck(many, baseConfig)
    expect(out!.hotPathFiles).toHaveLength(10)
  })

  it("emits a hit even when no numeric budgets are set (hotPaths-only config)", () => {
    const out = runPerfBudgetsCheck(["src/worker.ts"], {
      p50LatencyBudgetMs: null,
      p95LatencyBudgetMs: null,
      bundleSizeBudgetKb: null,
      hotPaths: ["src/worker.ts"],
    })
    expect(out).not.toBeNull()
    expect(out!.budgets.p95LatencyBudgetMs).toBeNull()
  })

  it("drops a malformed glob silently but still matches the valid ones", () => {
    const out = runPerfBudgetsCheck(["src/worker.ts"], {
      ...baseConfig,
      hotPaths: ["[invalid", "src/worker.ts"],
    })
    expect(out).not.toBeNull()
    expect(out!.hotPathFiles).toEqual(["src/worker.ts"])
  })

  it("returns null when EVERY hotPaths glob is malformed (effectively empty)", () => {
    const out = runPerfBudgetsCheck(["src/worker.ts"], {
      ...baseConfig,
      hotPaths: ["[invalid", "{also-bad"],
    })
    expect(out).toBeNull()
  })
})

describe("renderPerfBudgetsForPrompt", () => {
  it("returns empty string when hit is null (caller joins without conditional)", () => {
    expect(renderPerfBudgetsForPrompt(null)).toBe("")
  })

  it("renders a complete fact block with files + budgets", () => {
    const out = renderPerfBudgetsForPrompt({
      hotPathFiles: ["src/lib/api/orders.ts"],
      matchedHotPaths: ["src/lib/api/**"],
      budgets: { p50LatencyBudgetMs: 50, p95LatencyBudgetMs: 200, bundleSizeBudgetKb: 250 },
    })
    expect(out).toContain("[PERF BUDGETS")
    expect(out).toContain("declared hot path")
    expect(out).toContain("`src/lib/api/orders.ts`")
    expect(out).toContain("p95")
    expect(out).toContain("200")
    expect(out).toContain("250")
  })

  it("omits the budget line entirely when no numeric budgets are set", () => {
    const out = renderPerfBudgetsForPrompt({
      hotPathFiles: ["src/worker.ts"],
      matchedHotPaths: ["src/worker.ts"],
      budgets: { p50LatencyBudgetMs: null, p95LatencyBudgetMs: null, bundleSizeBudgetKb: null },
    })
    expect(out).toContain("`src/worker.ts`")
    expect(out).not.toContain("p95")
    expect(out).not.toContain("Declared budgets")
  })
})
