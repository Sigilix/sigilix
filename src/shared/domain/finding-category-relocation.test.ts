// SIG-383: locks the FindingCategory / FINDING_CATEGORIES extraction to the
// shared/domain leaf + the triage-pr-review re-export. Fails if the extraction
// is reverted (the shared leaf wouldn't resolve) or if triage-pr-review stops
// re-exporting the same binding (which would silently fork the category set).
import { describe, it, expect } from "vitest"
import { FINDING_CATEGORIES } from "@/src/shared/domain/finding-category"
import { FINDING_CATEGORIES as REVIEW_FINDING_CATEGORIES } from "@/src/lib/triage-pr-review"

describe("FindingCategory relocation (SIG-383)", () => {
  it("lives in shared/domain with the canonical category set", () => {
    expect([...FINDING_CATEGORIES].sort()).toEqual([
      "complexity",
      "docs",
      "error-handling",
      "logic",
      "performance",
      "security",
      "style",
      "syntax",
      "testing",
    ])
  })

  it("triage-pr-review re-exports the SAME shared binding (not a fork)", () => {
    expect(REVIEW_FINDING_CATEGORIES).toBe(FINDING_CATEGORIES)
  })
})
