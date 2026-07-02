// Config-as-code — applyCustomRuleAttribution: the off/on mode contract
// (byte-identical in off), marker strip + attribution stamp in `on`, and the
// "don't attribute a marker for a rule that wasn't actually injected" safety
// property. Also pins the recall-safety invariant: the gate never changes the
// kept-array length.

import { describe, expect, it } from "vitest"

import { applyCustomRuleAttribution } from "@/src/lib/ensemble/app/custom-rules-attribution-prep"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { MatchedSigilixCustomRule } from "@/src/lib/sigilix-config"
import type { Env } from "@/src/shared/types/env"

function makeEnv(mode: string | undefined): Env {
  return { OPENCLAW_CONFIG_AS_CODE_MODE: mode } as unknown as Env
}

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/db/query.ts",
    line: 10,
    score: 4,
    category: "security",
    headline: "String-concatenated SQL",
    body: "This builds a query by string concatenation. [repo-rule:no-raw-sql]",
    ...overrides,
  } as PrReviewFinding
}

const NO_RAW_SQL: MatchedSigilixCustomRule = {
  rule: {
    id: "no-raw-sql",
    rule: "Flag string-concatenated SQL; require parameterized queries.",
  },
  matchedPaths: ["src/db/query.ts"],
}

describe("applyCustomRuleAttribution", () => {
  it("off: returns the kept array untouched (bodies keep any raw marker)", () => {
    const f = finding()
    const kept = applyCustomRuleAttribution({
      env: makeEnv("off"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedCustomRules: [NO_RAW_SQL],
    })
    expect(kept).toEqual([f])
    expect(kept[0]!.body).toContain("[repo-rule:no-raw-sql]")
    expect(kept[0]!.repoRule).toBeUndefined()
  })

  it("unset mode: treated as off (byte-identical)", () => {
    const f = finding()
    const kept = applyCustomRuleAttribution({
      env: makeEnv(undefined),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedCustomRules: [NO_RAW_SQL],
    })
    expect(kept[0]!.body).toContain("[repo-rule:no-raw-sql]")
    expect(kept[0]!.repoRule).toBeUndefined()
  })

  it("on: strips the marker from the body and stamps repoRule attribution", () => {
    const f = finding()
    const kept = applyCustomRuleAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedCustomRules: [NO_RAW_SQL],
    })
    expect(kept[0]!.body).not.toContain("[repo-rule:")
    expect(kept[0]!.body).toBe("This builds a query by string concatenation.")
    expect(kept[0]!.repoRule).toEqual({
      id: "no-raw-sql",
      rule: "Flag string-concatenated SQL; require parameterized queries.",
    })
  })

  it("on: strips a marker but does NOT attribute when the id wasn't actually injected", () => {
    const f = finding({ body: "Some finding body. [repo-rule:hallucinated]" })
    const kept = applyCustomRuleAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      // Only no-raw-sql was injected into this review's context — the model
      // hallucinated a different id.
      kept: [f],
      matchedCustomRules: [NO_RAW_SQL],
    })
    expect(kept[0]!.body).not.toContain("[repo-rule:")
    expect(kept[0]!.repoRule).toBeUndefined()
  })

  it("on: a finding with no marker is left untouched (no spurious attribution)", () => {
    const f = finding({ body: "Plain finding, no repo-rule marker." })
    const kept = applyCustomRuleAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedCustomRules: [NO_RAW_SQL],
    })
    expect(kept[0]!.body).toBe("Plain finding, no repo-rule marker.")
    expect(kept[0]!.repoRule).toBeUndefined()
  })

  it("on with no matched rules: still strips a stray marker but attributes nothing", () => {
    const f = finding()
    const kept = applyCustomRuleAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedCustomRules: [],
    })
    expect(kept[0]!.body).not.toContain("[repo-rule:")
    expect(kept[0]!.repoRule).toBeUndefined()
  })

  it("recall-safety: never removes an item from kept (length unchanged) across all cases", () => {
    const cases: Array<{ env: Env; findings: PrReviewFinding[]; matched: MatchedSigilixCustomRule[] }> = [
      { env: makeEnv("on"), findings: [finding({ score: 5 })], matched: [NO_RAW_SQL] },
      { env: makeEnv("on"), findings: [finding({ body: "x [repo-rule:hallucinated]" })], matched: [NO_RAW_SQL] },
      { env: makeEnv("on"), findings: [finding()], matched: [] },
      { env: makeEnv("off"), findings: [finding(), finding()], matched: [NO_RAW_SQL] },
    ]
    for (const c of cases) {
      const kept = applyCustomRuleAttribution({
        env: c.env,
        owner: "o",
        repo: "r",
        prNumber: 1,
        kept: c.findings,
        matchedCustomRules: c.matched,
      })
      expect(kept.length).toBe(c.findings.length)
    }
  })
})
