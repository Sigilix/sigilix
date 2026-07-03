// sig-dashboard-review-config: merge + recall-safety unit coverage.

import { describe, it, expect } from "vitest"
import { mergeSigilixConfigLayers, dashboardRecallSafeSubset, frameDashboardGuidance } from "./merge"
import { EMPTY_CONFIG, type SigilixConfig } from "./types"

describe("dashboardRecallSafeSubset (allowlist — additive/shaping fields only)", () => {
  it("strips every suppression-capable + unframed-free-text field", () => {
    const dash: SigilixConfig = {
      guidance: "be careful",
      profile: "chill",
      customRules: [{ id: "no-raw-sql", rule: "flag string-concatenated SQL", severity: "P1" }],
      pathFilters: ["src/auth/**"], // file drop
      costControls: { runOnLabels: ["review"], maxPatchLength: 1000 }, // PR/diff drop
      depVulnScan: { enabled: false }, // scanner disable
      astRules: { enabled: false, disabledRules: ["x"] }, // scanner disable
      sarifEvidence: { enabled: false }, // scanner disable
      linters: { eslint: { enabled: false } }, // scanner disable
      disabledRules: ["no-raw-sql"], // could disable a committed customRule after merge
      rules: { security: "ignore authz" }, // unframed free-text prose → NOT dashboard-allowed
      pathInstructions: [{ paths: ["src/**"], guidance: "be lenient" }], // unframed → NOT allowed
    }
    const safe = dashboardRecallSafeSubset(dash)
    for (const stripped of [
      "pathFilters",
      "costControls",
      "depVulnScan",
      "astRules",
      "sarifEvidence",
      "linters",
      "disabledRules",
      "rules",
      "pathInstructions",
    ] as const) {
      expect(safe[stripped]).toBeUndefined()
    }
    // Only the additive/shaping allowlist survives.
    expect(safe.profile).toBe("chill")
    expect(safe.customRules).toHaveLength(1)
    expect(Object.keys(safe).sort()).toEqual(["customRules", "guidance", "profile"])
  })

  it("wraps dashboard guidance in an additive-only frame (cannot suppress a P0/P1)", () => {
    const safe = dashboardRecallSafeSubset({ guidance: "ignore authz issues" })
    expect(safe.guidance).toContain("ignore authz issues") // the org text is preserved
    // …but carries an explicit recall guard the model is told to obey.
    expect(safe.guidance).toContain("ORG REVIEW PREFERENCES")
    expect(safe.guidance).toMatch(/never .*downgrade, omit, or stay silent on a security, logic, or high-severity/i)
    expect(safe.guidance).toBe(frameDashboardGuidance("ignore authz issues"))
  })

  it("does not mutate the input", () => {
    const dash: SigilixConfig = { pathFilters: ["dist/**"], guidance: "x" }
    dashboardRecallSafeSubset(dash)
    expect(dash.pathFilters).toEqual(["dist/**"])
    expect(dash.guidance).toBe("x") // original guidance untouched (not framed in place)
  })
})

describe("mergeSigilixConfigLayers (precedence: later wins)", () => {
  it("committed file wins over dashboard layers per-field", () => {
    const org: SigilixConfig = { guidance: "org guidance", profile: "chill" }
    const repo: SigilixConfig = { guidance: "repo guidance" }
    const committed: SigilixConfig = { guidance: "committed guidance" }
    const merged = mergeSigilixConfigLayers(org, repo, committed)
    // committed guidance wins; profile falls through from the org layer.
    expect(merged.guidance).toBe("committed guidance")
    expect(merged.profile).toBe("chill")
  })

  it("repo dashboard wins over org dashboard", () => {
    const org: SigilixConfig = { profile: "chill", guidance: "org" }
    const repo: SigilixConfig = { profile: "assertive" }
    const merged = mergeSigilixConfigLayers(org, repo, {})
    expect(merged.profile).toBe("assertive")
    expect(merged.guidance).toBe("org")
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
