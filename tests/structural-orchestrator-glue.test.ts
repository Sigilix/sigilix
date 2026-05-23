// SIG-128 PR 6 — structural orchestrator-glue heuristic.
//
// Extends SIG-128's helper-coverage suppression with a structural heuristic
// that catches small wrappers around delegation calls regardless of whether
// the delegated-to helpers are *same-PR* tested. The PR #138 `scheduled`
// handler fixture is the regression case the existing same-PR-only logic
// could not suppress (it delegates to both a same-PR helper —
// `runIndexReconciliation` — AND a pre-existing one — `isIndexerEnabled` —
// giving status "partial" not "all", so the bot fired anyway).

import { describe, expect, it } from "vitest"

import {
  isDelegationShapedLine,
  isStructurallyOrchestratorGlue,
} from "../src/lib/helper-coverage"

const linesOf = (...texts: string[]) =>
  new Map(texts.map((t, i) => [i + 1, t]))

describe("isDelegationShapedLine (SIG-128 PR 6)", () => {
  it("flags pure log statements as delegation-shaped", () => {
    expect(isDelegationShapedLine('  console.log({event: "...skip"})')).toBe(true)
    expect(isDelegationShapedLine('console.error(JSON.stringify({event: "x"}))')).toBe(true)
  })

  it("flags control-flow keywords (if/return/throw/try/catch/await) as delegation-shaped", () => {
    expect(isDelegationShapedLine("    if (!isIndexerEnabled(env)) {")).toBe(true)
    expect(isDelegationShapedLine("    return")).toBe(true)
    expect(isDelegationShapedLine("      throw err")).toBe(true)
    expect(isDelegationShapedLine("    try { await runIndexReconciliation(env, { dryRun: false }) }")).toBe(true)
    expect(isDelegationShapedLine("    catch (err) {")).toBe(true)
    expect(isDelegationShapedLine("  await foo(x)")).toBe(true)
  })

  it("flags bare call expressions as delegation-shaped", () => {
    expect(isDelegationShapedLine("    runIndexReconciliation(env, opts)")).toBe(true)
    expect(isDelegationShapedLine("  someHelper.method(arg)")).toBe(true)
    expect(isDelegationShapedLine("  ctx.waitUntil(p)")).toBe(true)
  })

  it("flags simple const-assigned call as delegation-shaped", () => {
    expect(isDelegationShapedLine("  const result = await fetchSomething(env)")).toBe(true)
  })

  it("does NOT flag arithmetic / logic lines", () => {
    expect(isDelegationShapedLine("  let sum = 0")).toBe(false)
    expect(isDelegationShapedLine("  for (let i = 0; i < n; i++) sum += i * 2")).toBe(false)
    expect(isDelegationShapedLine("  const total = a + b * c")).toBe(false)
    expect(isDelegationShapedLine("  arr.push(x * 2)")).toBe(false)
  })

  it("does NOT flag object-literal field with logic", () => {
    expect(isDelegationShapedLine("    fileCount: cumulativeFiles - skipped,")).toBe(false)
  })
})

describe("isStructurallyOrchestratorGlue (SIG-128 PR 6)", () => {
  it("flags the literal PR #138 scheduled-handler diff as glue", () => {
    // Mirrors `src/index.ts` lines 975-987 added by PR #138 (SIG-156 PR3).
    // This is the case that regressed SIG-128 and triggered SIG-159 / SIG-160.
    const added = linesOf(
      "  async scheduled(_event, env, ctx) {",
      '    if (!isIndexerEnabled(env)) {',
      '      console.log(JSON.stringify({ event: "index-reconcile-tick-skip-disabled" }))',
      "      return",
      "    }",
      "    ctx.waitUntil(",
      "      (async () => {",
      "        try {",
      "          await runIndexReconciliation(env, { dryRun: false })",
      "        } catch (err) {",
      '          console.error(JSON.stringify({ event: "index-reconcile-tick-error", error: err }))',
      "        }",
      "      })(),",
      "    )",
      "  },",
    )
    expect(isStructurallyOrchestratorGlue(added)).toBe(true)
  })

  it("does NOT flag a small but logic-heavy function", () => {
    // Has substantive logic — arithmetic, comparisons, mutation.
    const added = linesOf(
      "  export function computeRatio(a: number, b: number): number {",
      "    if (b === 0) return 0",
      "    const sum = a + b",
      "    const product = a * b",
      "    return sum / product",
      "  }",
    )
    expect(isStructurallyOrchestratorGlue(added)).toBe(false)
  })

  it("does NOT flag a function over the size threshold", () => {
    // 14 substantive lines, all calls — still rejected because it's big enough
    // that a dedicated test IS warranted (catches the over-suppression risk:
    // structural heuristic could otherwise hide a non-trivial orchestrator).
    const lines = [
      "  async function bigOrchestrator(env) {",
      "    await stepOne(env)",
      "    await stepTwo(env)",
      "    await stepThree(env)",
      "    await stepFour(env)",
      "    await stepFive(env)",
      "    await stepSix(env)",
      "    await stepSeven(env)",
      "    await stepEight(env)",
      "    await stepNine(env)",
      "    await stepTen(env)",
      "    await stepEleven(env)",
      "    await stepTwelve(env)",
      "    await stepThirteen(env)",
      "  }",
    ]
    expect(isStructurallyOrchestratorGlue(linesOf(...lines))).toBe(false)
  })

  it("does NOT flag a function with no free-function calls (method-only)", () => {
    // Small + has `.toUpperCase()` (which IS a method call), but no FREE-
    // function calls — fails the `hasFreeFunctionCall` gate. CR T2 caught
    // the imprecise old test name ("no delegation calls"); the actual
    // distinguishing requirement is `FREE_FUNCTION_CALL`.
    const added = linesOf(
      "  function transform(x) {",
      "    const y = x.value",
      "    const z = y.toUpperCase()",
      "    return z",
      "  }",
    )
    expect(isStructurallyOrchestratorGlue(added)).toBe(false)
  })

  it("returns false on empty added lines", () => {
    expect(isStructurallyOrchestratorGlue(new Map())).toBe(false)
  })
})
