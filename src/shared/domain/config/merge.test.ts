// sig-dashboard-review-config: merge + recall-safety unit coverage.

import { describe, it, expect } from "vitest"
import { dashboardReviewConfigToSigilixConfig, mergeSigilixConfigLayers, frameDashboardGuidance } from "./merge"
import type { DashboardReviewConfig } from "./dashboard"
import { EMPTY_CONFIG, type SigilixConfig } from "./types"

describe("dashboardReviewConfigToSigilixConfig (closed recall-safe contract)", () => {
  it("converts every supported dashboard field and nothing else", () => {
    const dash: DashboardReviewConfig = {
      guidance: "be careful",
      profile: "chill",
      overview: {
        showSummary: false,
        showWalkthrough: true,
        showSequenceDiagram: false,
        showConfidence: true,
      },
      preMergeGates: {
        titleFormat: { enabled: false },
        linkedIssue: { enabled: true },
      },
    }
    const safe = dashboardReviewConfigToSigilixConfig(dash)
    expect(safe.profile).toBe("chill")
    expect(safe.overview).toEqual(dash.overview)
    expect(safe.preMergeGates).toEqual(dash.preMergeGates)
    expect(Object.keys(safe).sort()).toEqual(["guidance", "overview", "preMergeGates", "profile"])
  })

  it("wraps dashboard guidance in an additive-only frame (cannot suppress a P0/P1)", () => {
    const safe = dashboardReviewConfigToSigilixConfig({ guidance: "ignore authz issues" })
    expect(safe.guidance).toContain("ignore authz issues") // the org text is preserved
    // …but carries an explicit recall guard the model is told to obey.
    expect(safe.guidance).toContain("ORG REVIEW PREFERENCES")
    expect(safe.guidance).toMatch(/never .*downgrade, omit, or stay silent on a security, logic, or high-severity/i)
    expect(safe.guidance).toBe(frameDashboardGuidance("ignore authz issues"))
  })

  it("does not mutate the input", () => {
    const dash: DashboardReviewConfig = { guidance: "x", overview: { showSummary: false } }
    const converted = dashboardReviewConfigToSigilixConfig(dash)
    expect(dash.guidance).toBe("x") // original guidance untouched (not framed in place)
    expect(dash.overview).toEqual({ showSummary: false })
    expect(converted.overview).not.toBe(dash.overview)
  })
})

describe("mergeSigilixConfigLayers (precedence: later wins)", () => {
  it("committed file wins over dashboard layers per-field", () => {
    const org: SigilixConfig = {
      guidance: "org guidance",
      profile: "chill",
      overview: { showSummary: false },
      preMergeGates: { titleFormat: { enabled: false } },
    }
    const repo: SigilixConfig = { guidance: "repo guidance", overview: { showConfidence: false } }
    const committed: SigilixConfig = {
      guidance: "committed guidance",
      overview: { showSummary: true, showWalkthrough: false },
      preMergeGates: { titleFormat: { enabled: true, severity: "error" } },
    }
    const merged = mergeSigilixConfigLayers(org, repo, committed)
    // Committed leaves win; unrelated dashboard leaves still flow through.
    expect(merged.guidance).toBe("committed guidance")
    expect(merged.profile).toBe("chill")
    expect(merged.overview).toEqual({
      showSummary: true,
      showConfidence: false,
      showWalkthrough: false,
    })
    expect(merged.preMergeGates).toEqual({ titleFormat: { enabled: true, severity: "error" } })
  })

  it("repo dashboard wins over org dashboard", () => {
    const org: SigilixConfig = {
      profile: "chill",
      guidance: "org",
      overview: { showSummary: false, showConfidence: true },
      preMergeGates: { titleFormat: { enabled: false }, linkedIssue: { enabled: true } },
    }
    const repo: SigilixConfig = {
      profile: "assertive",
      overview: { showSummary: true },
      preMergeGates: { linkedIssue: { enabled: false } },
    }
    const merged = mergeSigilixConfigLayers(org, repo, {})
    expect(merged.profile).toBe("assertive")
    expect(merged.guidance).toBe("org")
    expect(merged.overview).toEqual({ showSummary: true, showConfidence: true })
    expect(merged.preMergeGates).toEqual({
      titleFormat: { enabled: false },
      linkedIssue: { enabled: false },
    })
  })

  it("preserves lower-precedence gates omitted by a higher layer", () => {
    const org: SigilixConfig = {
      preMergeGates: {
        linkedIssue: { enabled: false },
        descriptionCompleteness: { enabled: true },
      },
    }
    const committed: SigilixConfig = {
      preMergeGates: {
        titleFormat: { enabled: true, severity: "error" },
      },
    }
    const merged = mergeSigilixConfigLayers(org, null, committed)
    expect(merged.preMergeGates).toEqual({
      linkedIssue: { enabled: false },
      descriptionCompleteness: { enabled: true },
      titleFormat: { enabled: true, severity: "error" },
    })
  })

  it("dashboard applies in full when there is no committed file", () => {
    const org: SigilixConfig = { guidance: "dash guidance", profile: "assertive" }
    const merged = mergeSigilixConfigLayers(org, null, {})
    expect(merged.guidance).toBe("dash guidance")
    expect(merged.profile).toBe("assertive")
  })

  it("committed file passes through unchanged with no dashboard layers (no regression)", () => {
    const committed: SigilixConfig = { guidance: "c", pathFilters: ["dist/**"], profile: "chill" }
    const merged = mergeSigilixConfigLayers(null, null, committed)
    expect(merged).toEqual(committed)
  })

  it("ignores null/undefined layers and omitted (undefined) fields", () => {
    const a: SigilixConfig = { guidance: "a" }
    // An explicit `guidance: undefined` (exactOptionalPropertyTypes forbids this
    // on the type directly, so cast) must NOT clobber a lower layer's value.
    const b = { guidance: undefined, profile: "chill" } as unknown as SigilixConfig
    const merged = mergeSigilixConfigLayers(undefined, a, null, b)
    expect(merged.guidance).toBe("a") // b.guidance is undefined → does not clobber
    expect(merged.profile).toBe("chill")
  })

  it("returns EMPTY_CONFIG when nothing defined", () => {
    expect(mergeSigilixConfigLayers(null, {}, undefined)).toBe(EMPTY_CONFIG)
  })
})
