// ARC-186 — version matcher tests.
//
// Multi-range patch evaluation is the BLOCKING fix from spec review:
// without per-range patch_in semantics, a 2.0.5 vuln gets falsely
// suppressed by `>= 1.4.2`. Lock the regression test in.

import { describe, it, expect } from "vitest"
import { matchVersion } from "@/src/features/dep-vulns/domain/version-matcher"
import type { AdvisoryRecord } from "@/src/features/dep-vulns/domain/advisory-db"

const baseAdvisory: AdvisoryRecord = {
  id: "TEST-1",
  source: "github",
  ecosystem: "npm",
  package_name: "lodash",
  ranges: [{ vulnerable_range: ">=0.0.0 <4.17.21", patched_in: "4.17.21" }],
  severity_class: "critical",
  summary: "test",
}

const multiRangeAdvisory: AdvisoryRecord = {
  ...baseAdvisory,
  id: "TEST-MULTI",
  ranges: [
    { vulnerable_range: ">=1.0.0 <1.4.2", patched_in: "1.4.2" },
    { vulnerable_range: ">=2.0.0 <2.1.3", patched_in: "2.1.3" },
  ],
}

describe("matchVersion — single range", () => {
  it("flags a vulnerable version", () => {
    const r = matchVersion("4.17.20", baseAdvisory)
    expect(r.match).toBe("range-vulnerable")
    expect(r.matchedRange).toBe(">=0.0.0 <4.17.21")
    expect(r.patchedIn).toBe("4.17.21")
  })

  it("suppresses an exactly-patched version", () => {
    expect(matchVersion("4.17.21", baseAdvisory).match).toBe("patched")
  })

  it("suppresses a post-patch version", () => {
    expect(matchVersion("4.17.22", baseAdvisory).match).toBe("out-of-range")
  })
})

describe("matchVersion — multi-range (BLOCKING regression from spec review)", () => {
  it("1.0.5 is vulnerable in range 1", () => {
    expect(matchVersion("1.0.5", multiRangeAdvisory).match).toBe("range-vulnerable")
  })

  it("1.4.2 is patched in range 1", () => {
    expect(matchVersion("1.4.2", multiRangeAdvisory).match).toBe("patched")
  })

  it("2.0.5 is VULNERABLE in range 2 — naive `>= 1.4.2` would falsely suppress this", () => {
    const r = matchVersion("2.0.5", multiRangeAdvisory)
    expect(r.match).toBe("range-vulnerable")
    expect(r.matchedRange).toBe(">=2.0.0 <2.1.3")
    expect(r.patchedIn).toBe("2.1.3")
  })

  it("2.1.3 is patched in range 2", () => {
    expect(matchVersion("2.1.3", multiRangeAdvisory).match).toBe("patched")
  })

  it("3.0.0 is out of all ranges", () => {
    expect(matchVersion("3.0.0", multiRangeAdvisory).match).toBe("out-of-range")
  })
})

describe("matchVersion — explicit safe list", () => {
  it("non_vulnerable_versions takes precedence", () => {
    const advisory: AdvisoryRecord = {
      ...baseAdvisory,
      ranges: [{ vulnerable_range: ">=0.0.0 <5.0.0", patched_in: "5.0.0" }],
      non_vulnerable_versions: ["3.0.0-safe"],
    }
    expect(matchVersion("3.0.0-safe", advisory).match).toBe("explicit-safe")
  })
})

describe("matchVersion — version normalization + invalid input", () => {
  it("strips a leading v", () => {
    expect(matchVersion("v4.17.20", baseAdvisory).match).toBe("range-vulnerable")
  })

  it("returns invalid-version for garbage", () => {
    expect(matchVersion("not-a-version", baseAdvisory).match).toBe("invalid-version")
    expect(matchVersion("", baseAdvisory).match).toBe("invalid-version")
  })

  it("excludes prereleases by default (1.0.0-beta against >=1.0.0 <1.4.2 → not matched)", () => {
    // Prerelease semantics: in semver, `1.0.0-beta < 1.0.0`, so the
    // beta should NOT be flagged as inside the [1.0.0, 1.4.2) range.
    expect(matchVersion("1.0.0-beta.1", multiRangeAdvisory).match).toBe("out-of-range")
  })
})
