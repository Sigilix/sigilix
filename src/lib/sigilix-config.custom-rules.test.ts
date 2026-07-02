// Config-as-code — `sigilix.json` `customRules` + `disabledRules` parsing, plus
// the 64KB file-size cap. Fail-open per entry: a bad rule is dropped, never a
// hard reject (except the whole-file size cap, which reuses the {ok:false}
// fail-path that flows to EMPTY_CONFIG downstream).

import { describe, it, expect } from "vitest"

import { parseSigilixConfig, parseSigilixConfigDetailed } from "@/src/lib/sigilix-config"

describe("parseSigilixConfig — customRules", () => {
  it("parses valid customRules + disabledRules (id/rule/scope/severity/enabled roundtrip)", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        customRules: [
          { id: "no-raw-sql", rule: "Flag string-concatenated SQL.", scope: ["src/db/**"], severity: "P1" },
          { id: "auth-check", rule: "Require authz.", enabled: false },
        ],
        disabledRules: ["legacy-rule", "legacy-rule", " "],
      }),
    )
    expect(cfg?.customRules).toEqual([
      { id: "no-raw-sql", rule: "Flag string-concatenated SQL.", scope: ["src/db/**"], severity: "P1" },
      { id: "auth-check", rule: "Require authz.", enabled: false },
    ])
    expect(cfg?.disabledRules).toEqual(["legacy-rule"])
  })

  it("accepts a scope given as a single string (tolerant, like pathInstructions)", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ customRules: [{ id: "r", rule: "x", scope: "src/**" }] }))
    expect(cfg?.customRules?.[0]?.scope).toEqual(["src/**"])
  })

  it("drops invalid entries but keeps valid ones (partial-array tolerance)", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        customRules: [
          { id: "good", rule: "keep me" },
          { id: "no-text" }, // missing rule → dropped
          { rule: "no id" }, // missing id → dropped
          "not-an-object", // not an object → dropped
          { id: "another", rule: "also keep" },
        ],
      }),
    )
    expect(cfg?.customRules?.map((r) => r.id)).toEqual(["good", "another"])
  })

  it("drops an entry whose id does not match the id regex", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        customRules: [
          { id: "Bad_Id", rule: "x" }, // uppercase + underscore → invalid
          { id: "-leading-dash", rule: "y" }, // leading dash → invalid
          { id: "ok-id", rule: "z" },
        ],
      }),
    )
    expect(cfg?.customRules?.map((r) => r.id)).toEqual(["ok-id"])
  })

  it("drops a duplicate id (first occurrence wins)", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        customRules: [
          { id: "dup", rule: "first" },
          { id: "dup", rule: "second" },
        ],
      }),
    )
    expect(cfg?.customRules).toEqual([{ id: "dup", rule: "first" }])
  })

  it("truncates over-long rule text rather than rejecting the entry", () => {
    const longText = "a".repeat(3000)
    const cfg = parseSigilixConfig(JSON.stringify({ customRules: [{ id: "r", rule: longText }] }))
    expect(cfg?.customRules?.[0]?.rule.length).toBe(2000)
  })

  it("truncates customRules to the max-entries cap", () => {
    const rules = Array.from({ length: 150 }, (_, i) => ({ id: `r-${i}`, rule: "x" }))
    const cfg = parseSigilixConfig(JSON.stringify({ customRules: rules }))
    expect(cfg?.customRules?.length).toBe(100)
  })

  it("truncates disabledRules to its cap", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `d-${i}`)
    const cfg = parseSigilixConfig(JSON.stringify({ disabledRules: ids }))
    expect(cfg?.disabledRules?.length).toBe(200)
  })

  it("drops non-strict-bool enabled / unknown severity (fields omitted)", () => {
    const cfg = parseSigilixConfig(
      JSON.stringify({
        customRules: [{ id: "r", rule: "x", enabled: "false", severity: "critical" }],
      }),
    )
    expect(cfg?.customRules?.[0]).toEqual({ id: "r", rule: "x" })
  })

  it("ignores unknown top-level keys while still parsing customRules", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ frobnicate: true, customRules: [{ id: "r", rule: "x" }] }))
    expect(cfg?.customRules).toEqual([{ id: "r", rule: "x" }])
  })
})

describe("parseSigilixConfigDetailed — 64KB size cap", () => {
  it("fails closed with a size-related reason when the raw body exceeds ~64KB", () => {
    // A single huge (valid-JSON) rule body over the 64KB byte cap.
    const raw = JSON.stringify({ customRules: [{ id: "big", rule: "x".repeat(70_000) }] })
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(65_536)
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/size|64KB/i)
    // The legacy wrapper falls back to null (→ EMPTY_CONFIG at the loader) —
    // never throws.
    expect(parseSigilixConfig(raw)).toBeNull()
  })

  it("does not change the JSON-invalid fail path when customRules is present", () => {
    // Broken JSON syntax (trailing comma) with a customRules field still fails
    // closed exactly like before — adding customRules parsing didn't change it.
    const raw = '{ "customRules": [{ "id": "r", "rule": "x" },] }'
    const result = parseSigilixConfigDetailed(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/JSON parse failed/)
  })
})
