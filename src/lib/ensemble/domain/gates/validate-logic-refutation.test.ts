// SIG-308 Phase 3 — the logic-refutation backstop. A sev>=4 logic finding
// that never showed it survives refutation (no `independentAssessment`) is
// flagged; one that carries the survival rationale, or that sits below the
// severity floor, is kept. Mode parsing follows the off|shadow|enforce idiom.

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import {
  evaluateLogicRefutation,
  parseLogicRefutationMode,
  LOGIC_REFUTATION_MIN_SEVERITY,
} from "@/src/lib/ensemble/domain/gates/validate-logic-refutation"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/lib/scan.ts",
    line: 17,
    score: 4,
    category: "logic",
    headline: "`<= arr.length` reads one past the end of `arr`",
    body: "The loop guard uses `<=`, so the final iteration accesses `arr[arr.length]`.",
    ...overrides,
  }
}

describe("parseLogicRefutationMode", () => {
  it("defaults to off for missing / unknown values (gate disabled)", () => {
    expect(parseLogicRefutationMode(undefined)).toBe("off")
    expect(parseLogicRefutationMode("")).toBe("off")
    expect(parseLogicRefutationMode("nonsense")).toBe("off")
  })

  it("parses shadow / enforce case- and whitespace-insensitively", () => {
    expect(parseLogicRefutationMode("shadow")).toBe("shadow")
    expect(parseLogicRefutationMode("  ENFORCE  ")).toBe("enforce")
    expect(parseLogicRefutationMode("Shadow")).toBe("shadow")
  })
})

describe("evaluateLogicRefutation", () => {
  it("FLAGS a sev>=4 logic finding with no independentAssessment (survival rationale)", () => {
    const r = evaluateLogicRefutation(finding())
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("logic-finding-missing-refutation-survival")
  })

  it("KEEPS a sev>=4 logic finding that states why no guard prevents it", () => {
    expect(
      evaluateLogicRefutation(
        finding({ independentAssessment: "No bound on `i`; the loop runs to arr.length inclusive with no guard." }),
      ).keep,
    ).toBe(true)
  })

  it("treats a whitespace-only independentAssessment as missing", () => {
    expect(evaluateLogicRefutation(finding({ independentAssessment: "   " })).keep).toBe(false)
  })

  it("KEEPS findings below the severity floor regardless of rationale (Phase 1 owns the low-sev class)", () => {
    expect(evaluateLogicRefutation(finding({ score: LOGIC_REFUTATION_MIN_SEVERITY - 1 })).keep).toBe(true)
    expect(evaluateLogicRefutation(finding({ score: 3 })).keep).toBe(true)
    expect(evaluateLogicRefutation(finding({ score: 1 })).keep).toBe(true)
  })

  it("FLAGS at exactly the severity floor (score === 4)", () => {
    expect(evaluateLogicRefutation(finding({ score: LOGIC_REFUTATION_MIN_SEVERITY })).keep).toBe(false)
  })
})
