import { describe, expect, it } from "vitest"
import { RUNNER_TOOL_CATALOG } from "@/src/shared/domain/runner-tool-catalog"
import {
  resolveLintersConfig,
  resolveDisabledLinterIds,
  resolveConfigAsCodeMode,
  resolveCustomRulesForChangedPaths,
  renderCustomRulesForPrompt,
} from "@/src/shared/domain/config/resolve"
import type { SigilixConfig } from "@/src/shared/domain/config/types"

describe("resolveLintersConfig", () => {
  it("mirrors the runner tool catalog default profile for every known tool", () => {
    const resolved = resolveLintersConfig(null)

    for (const entry of RUNNER_TOOL_CATALOG) {
      expect(resolved[entry.id]).toEqual({ enabled: entry.defaultEnabled })
    }
  })

  it("lets explicit config override catalog defaults while leaving absent tools on the profile", () => {
    const resolved = resolveLintersConfig({
      linters: {
        checkov: { enabled: true },
        semgrep: { enabled: false },
      },
    } as SigilixConfig)

    expect(resolved.checkov).toEqual({ enabled: true })
    expect(resolved.semgrep).toEqual({ enabled: false })
    expect(resolved.trivy).toEqual({ enabled: false })
    expect(resolved.eslint).toEqual({ enabled: true })
  })
})

describe("resolveDisabledLinterIds (SIG-107 — the SARIF drop seam)", () => {
  it("returns [] when no linters config is present (nothing dropped)", () => {
    expect(resolveDisabledLinterIds(null)).toEqual([])
    expect(resolveDisabledLinterIds({} as SigilixConfig)).toEqual([])
  })

  it("returns ONLY explicitly-disabled ids", () => {
    const disabled = resolveDisabledLinterIds({
      linters: { eslint: { enabled: false }, ruff: { enabled: true } },
    } as SigilixConfig)
    expect(disabled).toEqual(["eslint"])
  })

  it("does NOT return a catalog default-OFF tool unless the repo explicitly disables it (recall-safe)", () => {
    // `trivy`/`checkov`/`trufflehog` are default-OFF in the catalog; absent an
    // explicit `enabled: false` they must NOT be dropped — dropping a tool the
    // customer never opted out of would silently hide (often security) findings.
    const defaultOff = ["trivy", "checkov", "trufflehog"]
    for (const id of defaultOff) {
      expect(resolveLintersConfig(null)[id as keyof ReturnType<typeof resolveLintersConfig>]).toEqual({
        enabled: false,
      })
    }
    expect(resolveDisabledLinterIds(null)).toEqual([])
    // …but an explicit opt-out IS honored.
    expect(resolveDisabledLinterIds({ linters: { trivy: { enabled: false } } } as SigilixConfig)).toEqual(["trivy"])
  })
})

describe("resolveConfigAsCodeMode (config-as-code)", () => {
  it("returns 'off' when unset/missing", () => {
    expect(resolveConfigAsCodeMode({})).toBe("off")
  })

  it("returns 'on' for 'on' in any casing, trimmed", () => {
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "on" })).toBe("on")
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "  ON  " })).toBe("on")
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "On" })).toBe("on")
  })

  it("returns 'off' for any other string (including 'shadow')", () => {
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "shadow" })).toBe("off")
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "true" })).toBe("off")
    expect(resolveConfigAsCodeMode({ OPENCLAW_CONFIG_AS_CODE_MODE: "" })).toBe("off")
  })
})

describe("resolveCustomRulesForChangedPaths (config-as-code)", () => {
  const base: SigilixConfig = {
    customRules: [
      { id: "scoped", rule: "Scoped rule.", scope: ["src/db/**"] },
      { id: "unscoped", rule: "Applies everywhere." },
    ],
  }

  it("returns [] when no rules or no changed paths", () => {
    expect(resolveCustomRulesForChangedPaths(null, ["a.ts"])).toEqual([])
    expect(resolveCustomRulesForChangedPaths(base, [])).toEqual([])
    expect(resolveCustomRulesForChangedPaths({ customRules: [] }, ["a.ts"])).toEqual([])
  })

  it("includes an in-scope rule and excludes an out-of-scope one", () => {
    const matches = resolveCustomRulesForChangedPaths({ customRules: [base.customRules![0]!] }, ["src/db/query.ts"])
    expect(matches.map((m) => m.rule.id)).toEqual(["scoped"])
    expect(matches[0]!.matchedPaths).toEqual(["src/db/query.ts"])

    const none = resolveCustomRulesForChangedPaths({ customRules: [base.customRules![0]!] }, ["src/api/handler.ts"])
    expect(none).toEqual([])
  })

  it("an unscoped rule (no scope field) matches every changed file", () => {
    const matches = resolveCustomRulesForChangedPaths({ customRules: [base.customRules![1]!] }, ["a.ts", "b.ts"])
    expect(matches.map((m) => m.rule.id)).toEqual(["unscoped"])
    expect(matches[0]!.matchedPaths).toEqual(["a.ts", "b.ts"])
  })

  it("excludes a rule with enabled:false even if in scope", () => {
    const cfg: SigilixConfig = { customRules: [{ id: "off-rule", rule: "x", enabled: false }] }
    expect(resolveCustomRulesForChangedPaths(cfg, ["a.ts"])).toEqual([])
  })

  it("excludes a rule whose id is in disabledRules even when enabled is absent/true", () => {
    const cfg: SigilixConfig = {
      customRules: [
        { id: "a", rule: "x" },
        { id: "b", rule: "y", enabled: true },
      ],
      disabledRules: ["a", "b"],
    }
    expect(resolveCustomRulesForChangedPaths(cfg, ["a.ts"])).toEqual([])
  })
})

describe("renderCustomRulesForPrompt (config-as-code)", () => {
  it("returns '' for empty matches", () => {
    expect(renderCustomRulesForPrompt([])).toBe("")
  })

  it("renders id, rule text, severity tag, matched paths, and the marker instruction", () => {
    const block = renderCustomRulesForPrompt([
      {
        rule: { id: "no-raw-sql", rule: "Flag string-concatenated SQL.", severity: "P1" },
        matchedPaths: ["src/db/query.ts"],
      },
    ])
    expect(block).toContain("[REPO RULES (from sigilix.json custom rules)]")
    expect(block).toContain("[P1]")
    expect(block).toContain("Flag string-concatenated SQL.")
    expect(block).toContain("id: `no-raw-sql`")
    expect(block).toContain("src/db/query.ts")
    expect(block).toContain("[repo-rule:<id>]")
  })

  it("omits the severity tag when severity is absent", () => {
    const block = renderCustomRulesForPrompt([{ rule: { id: "plain", rule: "A rule." }, matchedPaths: ["a.ts"] }])
    expect(block).not.toContain("[P1]")
    expect(block).not.toContain("[P2]")
    expect(block).not.toContain("[P3]")
  })

  // Recall-safety structural test (mirrors sdk-packs/render.recall-safety.test.ts):
  // pure string assertions on the rendered block, no LLM calls.
  const DISMISSAL_PATTERNS = [
    /\bsuppress(?:es|ed|ing)?\b/i,
    /\bdo not (?:report|flag|surface|mention)\b/i,
    /\bskip (?:reporting|flagging|this (?:finding|issue))\b/i,
    /\bignore (?:this|that|the) (?:finding|issue|bug)\b/i,
    /\bdowngrade\b/i,
    /\bomit\b/i,
    /\bsoften\b/i,
    /\blower the (?:severity|score)\b/i,
  ]

  it("contains the explicit never-suppress disclaimer", () => {
    const block = renderCustomRulesForPrompt([{ rule: { id: "r", rule: "A rule." }, matchedPaths: ["a.ts"] }])
    expect(block).toMatch(/NEVER[\s\S]*?suppress/i)
  })

  it("carries no dismissal/suppression language directed at the model (outside the marker safety clause)", () => {
    const block = renderCustomRulesForPrompt([{ rule: { id: "r", rule: "A rule." }, matchedPaths: ["a.ts"] }])
    // Strip the two sentences that legitimately discuss suppression in the
    // negative ("NEVER be used to suppress…" header + the marker safety clause)
    // before scanning for dismissal language elsewhere.
    const withoutSafetyClauses = block
      .replace(/The following are repo-owner-authored rules[\s\S]*?a listed rule\)\./, "")
      .replace(/If one of these rules[\s\S]*$/, "")
    for (const pattern of DISMISSAL_PATTERNS) {
      expect(withoutSafetyClauses).not.toMatch(pattern)
    }
  })
})
