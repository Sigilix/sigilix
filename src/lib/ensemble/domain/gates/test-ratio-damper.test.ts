// SIG-347 (SIG-166 AC #3): diff-test-ratio damper pure-helper tests.

import { describe, it, expect } from "vitest"
import {
  computeTestToSourceAddedRatio,
  dampTestingScoreForRatio,
  TEST_RATIO_DAMPER_THRESHOLD,
} from "@/src/lib/ensemble/domain/gates/test-ratio-damper"

function diffMap(byPath: Record<string, string[]>): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>()
  for (const [path, lines] of Object.entries(byPath)) {
    const lm = new Map<number, string>()
    lines.forEach((text, i) => lm.set(i + 1, text))
    out.set(path, lm)
  }
  return out
}

describe("computeTestToSourceAddedRatio", () => {
  it("counts substantive added lines, test-to-source", () => {
    const ratio = computeTestToSourceAddedRatio(
      diffMap({
        "src/lib/foo.ts": ["const x = compute()", "return x + 1"], // 2 substantive
        "tests/foo.test.ts": ['it("x", () => {', "expect(x).toBe(1)", "})"], // 2 substantive (`})` excluded)
      }),
    )
    expect(ratio).toBeCloseTo(1.0)
  })

  it("ignores non-substantive lines (imports, comments, braces)", () => {
    const ratio = computeTestToSourceAddedRatio(
      diffMap({
        "src/lib/foo.ts": ['import { z } from "./z"', "// a comment", "const x = 1"], // only 1 substantive
        "tests/foo.test.ts": ["expect(x).toBe(1)"], // 1 substantive
      }),
    )
    expect(ratio).toBeCloseTo(1.0)
  })

  it("returns 0 when the diff adds no test lines", () => {
    const ratio = computeTestToSourceAddedRatio(diffMap({ "src/lib/foo.ts": ["const x = 1", "const y = 2"] }))
    expect(ratio).toBe(0)
  })

  it("is large-and-positive for a test-only PR (no source lines)", () => {
    const ratio = computeTestToSourceAddedRatio(
      diffMap({ "tests/foo.test.ts": ["expect(a).toBe(1)", "expect(b).toBe(2)"] }),
    )
    expect(ratio).toBeGreaterThan(TEST_RATIO_DAMPER_THRESHOLD)
  })

  it("excludes docs/config files from both terms", () => {
    const ratio = computeTestToSourceAddedRatio(
      diffMap({
        "README.md": ["lots", "of", "docs", "lines", "here"],
        "package.json": ['"dep": "1.0.0"'],
        "src/lib/foo.ts": ["const x = 1"], // 1 source
        "tests/foo.test.ts": ["expect(x).toBe(1)"], // 1 test
      }),
    )
    expect(ratio).toBeCloseTo(1.0)
  })

  it("returns a low ratio when source dominates", () => {
    const ratio = computeTestToSourceAddedRatio(
      diffMap({
        "src/lib/foo.ts": ["a()", "b()", "c()", "d()", "e()"], // 5 source
        "tests/foo.test.ts": ["expect(a).toBe(1)"], // 1 test
      }),
    )
    expect(ratio).toBeCloseTo(0.2)
    expect(ratio).toBeLessThan(TEST_RATIO_DAMPER_THRESHOLD)
  })
})

describe("dampTestingScoreForRatio", () => {
  it("lowers the score by 1 when the ratio is above threshold", () => {
    expect(dampTestingScoreForRatio(4, 0.5)).toBe(3)
    expect(dampTestingScoreForRatio(5, 0.31)).toBe(4)
  })

  it("does not damp at or below threshold", () => {
    expect(dampTestingScoreForRatio(4, 0.3)).toBe(4)
    expect(dampTestingScoreForRatio(4, 0)).toBe(4)
  })

  it("floors at 2 — never routes a finding into the advisory (hidden) bucket", () => {
    expect(dampTestingScoreForRatio(2, 0.9)).toBe(2) // NOT damped to 1 (would hide it)
    expect(dampTestingScoreForRatio(3, 0.9)).toBe(2) // damped to the floor
    expect(dampTestingScoreForRatio(1, 0.9)).toBe(1) // already below the floor, untouched
  })
})
