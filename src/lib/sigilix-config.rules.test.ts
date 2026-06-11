// ARC-174 — `sigilix.json` config: rules & gating parsing.
//
// astRules / sarifEvidence / costControls / passesLabelGate / docsReview /
// coverage, with their resolve* helpers.

import { describe, it, expect } from "vitest"
import {
  parseSigilixConfig,
  passesLabelGate,
  resolveAstRulesConfig,
  resolveCostControlsConfig,
  resolveLintersConfig,
  resolveSarifEvidenceConfig,
  resolveCoverageConfig,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"

describe("parseSigilixConfig — linters (SIG-107)", () => {
  it("parses object config for known linter ids", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        linters: {
          semgrep: { enabled: true },
          eslint: { enabled: false },
          ruff: { enabled: true },
          actionlint: { enabled: false },
          shellcheck: { enabled: true },
        },
      }),
    )
    expect(cfg?.linters).toEqual({
      semgrep: { enabled: true },
      eslint: { enabled: false },
      ruff: { enabled: true },
      actionlint: { enabled: false },
      shellcheck: { enabled: true },
    })
  })

  it("parses strict boolean shorthand for known linter ids", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        linters: {
          eslint: true,
          ruff: false,
        },
      }),
    )
    expect(cfg?.linters).toEqual({
      eslint: { enabled: true },
      ruff: { enabled: false },
    })
  })

  it("drops invalid linter values without failing the whole config", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        guidance: "keep reviewing",
        linters: {
          eslint: { enabled: "false" },
          ruff: "true",
          semgrep: { enabled: true, futureField: "ignored" },
          shellcheck: null,
        },
      }),
    )
    expect(cfg?.guidance).toBe("keep reviewing")
    expect(cfg?.linters).toEqual({ semgrep: { enabled: true } })
  })

  it("drops unknown linter ids and omits linters when no valid entries remain", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        linters: {
          biome: { enabled: true },
          prettier: false,
        },
      }),
    )
    expect(cfg?.linters).toBeUndefined()
  })
})

describe("resolveLintersConfig (SIG-107)", () => {
  it("defaults every known linter to enabled", () => {
    const expected = {
      semgrep: { enabled: true },
      eslint: { enabled: true },
      ruff: { enabled: true },
      actionlint: { enabled: true },
      shellcheck: { enabled: true },
    }
    expect(resolveLintersConfig(null)).toEqual(expected)
    expect(resolveLintersConfig({} as SigilixConfig)).toEqual(expected)
  })

  it("respects explicit disabled values while defaulting absent linters to enabled", () => {
    expect(
      resolveLintersConfig({
        linters: {
          eslint: { enabled: false },
          shellcheck: { enabled: false },
        },
      } as SigilixConfig),
    ).toEqual({
      semgrep: { enabled: true },
      eslint: { enabled: false },
      ruff: { enabled: true },
      actionlint: { enabled: true },
      shellcheck: { enabled: false },
    })
  })
})

describe("parseSigilixConfig — astRules (ARC-181)", () => {
  it("captures astRules.enabled: false", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: false } }))
    expect(r?.astRules?.enabled).toBe(false)
  })

  it("captures astRules.enabled: true", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: true } }))
    expect(r?.astRules?.enabled).toBe(true)
  })

  it('STRICT-BOOL: string "false" does NOT disable', () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { enabled: "false" } }))
    expect(r?.astRules?.enabled).toBeUndefined()
  })

  it("captures severityThreshold for each known value", () => {
    for (const v of ["info", "warning", "error"] as const) {
      const r = parseSigilixConfig(JSON.stringify({ astRules: { severityThreshold: v } }))
      expect(r?.astRules?.severityThreshold).toBe(v)
    }
  })

  it("rejects unknown severityThreshold values", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { severityThreshold: "spicy" } }))
    expect(r?.astRules?.severityThreshold).toBeUndefined()
  })

  it("captures disabledRules string array", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        astRules: { disabledRules: ["no-eval-call", "no-throw-literal"] },
      }),
    )
    expect(r?.astRules?.disabledRules).toEqual(["no-eval-call", "no-throw-literal"])
  })

  it("filters non-string entries from disabledRules", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        astRules: { disabledRules: ["no-eval-call", 42, null, ""] },
      }),
    )
    expect(r?.astRules?.disabledRules).toEqual(["no-eval-call"])
  })

  it("rejects non-array disabledRules", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        astRules: { disabledRules: "no-eval-call" },
      }),
    )
    expect(r?.astRules?.disabledRules).toBeUndefined()
  })

  it("captures autoInline: true", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { autoInline: true } }))
    expect(r?.astRules?.autoInline).toBe(true)
  })

  it("STRICT-BOOL: autoInline string is dropped", () => {
    const r = parseSigilixConfig(JSON.stringify({ astRules: { autoInline: "yes" } }))
    expect(r?.astRules?.autoInline).toBeUndefined()
  })

  it("ignores unknown subfields under astRules (forward-compat)", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        astRules: { enabled: true, futureField: "x" },
      }),
    )
    expect(r?.astRules).toEqual({ enabled: true })
  })

  it("strips top-level astRules value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ astRules: "off" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ astRules: [] }))).toEqual({})
  })
})

describe("resolveAstRulesConfig (ARC-181)", () => {
  it("locks defaults when config is null", () => {
    expect(resolveAstRulesConfig(null)).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("ABSENT-CONFIG: astRules undefined → defaults", () => {
    const cfg = parseSigilixConfig("{}")
    expect(resolveAstRulesConfig(cfg)).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("EMPTY astRules: {} → defaults", () => {
    expect(resolveAstRulesConfig({ astRules: {} })).toEqual({
      enabled: true,
      severityThreshold: "warning",
      disabledRules: [],
      autoInline: false,
    })
  })

  it("autoInline default is false (not undefined, not true)", () => {
    expect(resolveAstRulesConfig({}).autoInline).toBe(false)
  })

  it("severityThreshold default is warning (not info)", () => {
    expect(resolveAstRulesConfig({}).severityThreshold).toBe("warning")
  })

  it("respects explicit enabled: false", () => {
    expect(resolveAstRulesConfig({ astRules: { enabled: false } }).enabled).toBe(false)
  })

  it("respects explicit autoInline: true", () => {
    expect(resolveAstRulesConfig({ astRules: { autoInline: true } }).autoInline).toBe(true)
  })

  it("returns user disabledRules array", () => {
    const out = resolveAstRulesConfig({ astRules: { disabledRules: ["a", "b"] } })
    expect(out.disabledRules).toEqual(["a", "b"])
  })
})

describe("parseSigilixConfig — sarifEvidence (ARC-188)", () => {
  it("captures sarifEvidence.enabled: false", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { enabled: false } }))
    expect(r?.sarifEvidence?.enabled).toBe(false)
  })

  it("captures sarifEvidence.path (trimmed)", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { path: "  custom/trivy.sarif.json  " } }))
    expect(r?.sarifEvidence?.path).toBe("custom/trivy.sarif.json")
  })

  it("rejects empty/whitespace-only path", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { path: "   " } }))
    expect(r?.sarifEvidence?.path).toBeUndefined()
  })

  it("captures sarifEvidence severityThreshold for each known value", () => {
    for (const v of ["info", "warning", "error"] as const) {
      const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { severityThreshold: v } }))
      expect(r?.sarifEvidence?.severityThreshold).toBe(v)
    }
  })

  it("rejects unknown sarifEvidence severityThreshold", () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { severityThreshold: "spicy" } }))
    expect(r?.sarifEvidence?.severityThreshold).toBeUndefined()
  })

  it("trims + dedupes sarifEvidence disabledRules", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        sarifEvidence: {
          disabledRules: [" rule-1 ", "rule-1", "rule-2", "", 42 as unknown as string],
        },
      }),
    )
    expect(r?.sarifEvidence?.disabledRules).toEqual(["rule-1", "rule-2"])
  })

  it("filters disabledCategories to known values + dedupes", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        sarifEvidence: {
          disabledCategories: ["license", "license", "vulnerability", "bogus", 42 as unknown as string],
        },
      }),
    )
    expect(r?.sarifEvidence?.disabledCategories).toEqual(["license", "vulnerability"])
  })

  it('STRICT-BOOL: sarifEvidence enabled string "false" doesn\'t disable', () => {
    const r = parseSigilixConfig(JSON.stringify({ sarifEvidence: { enabled: "false" } }))
    expect(r?.sarifEvidence?.enabled).toBeUndefined()
  })

  it("ignores unknown sarifEvidence subfields (forward-compat)", () => {
    const r = parseSigilixConfig(
      JSON.stringify({
        sarifEvidence: { enabled: true, futureField: "x" },
      }),
    )
    expect(r?.sarifEvidence).toEqual({ enabled: true })
  })

  it("strips top-level sarifEvidence value that isn't an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ sarifEvidence: "on" }))).toEqual({})
    expect(parseSigilixConfig(JSON.stringify({ sarifEvidence: [] }))).toEqual({})
  })
})

describe("resolveSarifEvidenceConfig (ARC-188)", () => {
  it("locks defaults when config is null", () => {
    expect(resolveSarifEvidenceConfig(null)).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("ABSENT-CONFIG: sarifEvidence undefined → defaults", () => {
    const cfg = parseSigilixConfig("{}")
    expect(resolveSarifEvidenceConfig(cfg)).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("EMPTY sarifEvidence: {} → defaults", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: {} })).toEqual({
      enabled: true,
      path: ".sigilix/trivy.sarif.json",
      severityThreshold: "warning",
      disabledRules: [],
      disabledCategories: [],
    })
  })

  it("respects explicit sarifEvidence enabled: false", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: { enabled: false } }).enabled).toBe(false)
  })

  it("respects custom sarifEvidence path", () => {
    expect(resolveSarifEvidenceConfig({ sarifEvidence: { path: "reports/x.sarif.json" } }).path).toBe(
      "reports/x.sarif.json",
    )
  })

  it("returns sarifEvidence user disabledRules + disabledCategories arrays", () => {
    const out = resolveSarifEvidenceConfig({
      sarifEvidence: { disabledRules: ["a", "b"], disabledCategories: ["license"] },
    })
    expect(out.disabledRules).toEqual(["a", "b"])
    expect(out.disabledCategories).toEqual(["license"])
  })
})

// ARC-273 — cost controls
describe("parseSigilixConfig — costControls", () => {
  it("parses maxPatchLength when in valid range", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 50_000 } }))
    expect(cfg?.costControls?.maxPatchLength).toBe(50_000)
  })

  it("rounds non-integer maxPatchLength values", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 50_000.7 } }))
    expect(cfg?.costControls?.maxPatchLength).toBe(50_001)
  })

  it("drops maxPatchLength below the floor", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 500 } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("drops maxPatchLength above the ceiling", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: 500_000 } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("drops non-numeric maxPatchLength entirely", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: "many" } }))
    expect(cfg?.costControls?.maxPatchLength).toBeUndefined()
  })

  it("parses runOnLabels — trims, drops empties, dedupes", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        costControls: {
          runOnLabels: ["sigilix:review", "  needs-review  ", "", "sigilix:review", "ok"],
        },
      }),
    )
    expect(cfg?.costControls?.runOnLabels?.sort()).toEqual(["needs-review", "ok", "sigilix:review"])
  })

  it("drops runOnLabels when every entry is non-string", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { runOnLabels: [1, 2, null] } }))
    expect(cfg?.costControls?.runOnLabels).toBeUndefined()
  })

  it("drops costControls entirely when nothing valid is present", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: { maxPatchLength: -5, runOnLabels: [] } }))
    expect(cfg?.costControls).toBeUndefined()
  })

  it("returns null (not throw) on malformed costControls block", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ costControls: "oops" }))
    // costControls is dropped silently — top-level config still valid.
    expect(cfg).not.toBeNull()
    expect(cfg?.costControls).toBeUndefined()
  })
})

describe("resolveCostControlsConfig", () => {
  it("returns defaults when no config is set", () => {
    const out = resolveCostControlsConfig(null)
    expect(out.maxPatchLength).toBeGreaterThanOrEqual(1_000)
    expect(out.runOnLabels).toEqual([])
  })

  it("returns defaults when costControls is absent", () => {
    const out = resolveCostControlsConfig({})
    expect(out.maxPatchLength).toBeGreaterThanOrEqual(1_000)
    expect(out.runOnLabels).toEqual([])
  })

  it("honors operator overrides", () => {
    const out = resolveCostControlsConfig({
      costControls: { maxPatchLength: 25_000, runOnLabels: ["needs-review"] },
    })
    expect(out.maxPatchLength).toBe(25_000)
    expect(out.runOnLabels).toEqual(["needs-review"])
  })
})

describe("passesLabelGate", () => {
  it("returns true when runOnLabels is empty (no gating)", () => {
    expect(passesLabelGate([], [])).toBe(true)
    expect(passesLabelGate(["random"], [])).toBe(true)
  })

  it("returns false when PR has no labels but gate requires one", () => {
    expect(passesLabelGate([], ["sigilix:review"])).toBe(false)
  })

  it("returns true when PR carries a required label", () => {
    expect(passesLabelGate(["bug", "sigilix:review"], ["sigilix:review"])).toBe(true)
  })

  it("returns false when PR carries different labels than required", () => {
    expect(passesLabelGate(["bug", "feature"], ["sigilix:review"])).toBe(false)
  })

  it("matches case-insensitively (GitHub labels are case-sensitive but operators don't always match casing)", () => {
    expect(passesLabelGate(["Needs-Review"], ["needs-review"])).toBe(true)
    expect(passesLabelGate(["needs-review"], ["NEEDS-REVIEW"])).toBe(true)
  })

  it("passes when ANY required label matches (OR semantics, not AND)", () => {
    expect(passesLabelGate(["needs-review"], ["needs-review", "sigilix:review"])).toBe(true)
  })
})

// ARC-272 — docsReview config parsing
describe("parseSigilixConfig — docsReview", () => {
  it("parses a fully-populated docsReview block", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        docsReview: {
          enabled: true,
          architectureGlobs: ["src/lib/**", "wrangler.toml"],
          docPaths: ["README.md", "docs/**"],
        },
      }),
    )
    expect(cfg?.docsReview?.enabled).toBe(true)
    expect(cfg?.docsReview?.architectureGlobs).toEqual(["src/lib/**", "wrangler.toml"])
    expect(cfg?.docsReview?.docPaths).toEqual(["README.md", "docs/**"])
  })

  it("strict-bool: only literal false disables", () => {
    const cfg1 = parseSigilixConfig(JSON.stringify({ docsReview: { enabled: false } }))
    expect(cfg1?.docsReview?.enabled).toBe(false)
    const cfg2 = parseSigilixConfig(JSON.stringify({ docsReview: { enabled: "false" } }))
    expect(cfg2?.docsReview?.enabled).toBeUndefined()
  })

  it("trims + dedupes glob entries", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        docsReview: { architectureGlobs: ["src/**", "  src/**  ", "lib/**"] },
      }),
    )
    expect(cfg?.docsReview?.architectureGlobs?.sort()).toEqual(["lib/**", "src/**"])
  })

  it("drops non-string glob entries", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        docsReview: { architectureGlobs: ["src/**", 42, null, "lib/**"] },
      }),
    )
    expect(cfg?.docsReview?.architectureGlobs?.sort()).toEqual(["lib/**", "src/**"])
  })

  it("drops docsReview entirely when nothing valid is present", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        docsReview: { architectureGlobs: [], docPaths: [] },
      }),
    )
    expect(cfg?.docsReview).toBeUndefined()
  })

  it("returns config (not null) on malformed docsReview (silent drop)", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ docsReview: "oops" }))
    expect(cfg).not.toBeNull()
    expect(cfg?.docsReview).toBeUndefined()
  })
})

// SIG-118: coverage-diff ingestion config resolution (default OFF).
describe("resolveCoverageConfig", () => {
  it("defaults to off + default artifact/entry on null config", () => {
    expect(resolveCoverageConfig(null)).toEqual({
      source: "off",
      artifactName: "coverage-lcov",
      entry: "lcov.info",
    })
  })

  it("stays off when no coverage key is present", () => {
    expect(resolveCoverageConfig({} as SigilixConfig).source).toBe("off")
  })

  it("stays off on explicit source: off", () => {
    expect(resolveCoverageConfig({ coverage: { source: "off" } } as SigilixConfig).source).toBe("off")
  })

  it("opts in on source: github-actions-artifact with defaults", () => {
    expect(resolveCoverageConfig({ coverage: { source: "github-actions-artifact" } } as SigilixConfig)).toEqual({
      source: "github-actions-artifact",
      artifactName: "coverage-lcov",
      entry: "lcov.info",
    })
  })

  it("preserves partial artifactName / entry overrides", () => {
    expect(
      resolveCoverageConfig({
        coverage: {
          source: "github-actions-artifact",
          artifactName: "cov",
          entry: "coverage.lcov",
        },
      } as SigilixConfig),
    ).toEqual({ source: "github-actions-artifact", artifactName: "cov", entry: "coverage.lcov" })
  })

  it("coerces an unrecognized source to off", () => {
    expect(resolveCoverageConfig({ coverage: { source: "weird" } } as unknown as SigilixConfig).source).toBe("off")
  })
})

// ─── SIG-138 Phase 2: [GRAPH CONTEXT] prompt block ──────────────────────────
