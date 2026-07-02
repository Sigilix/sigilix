// Config-as-code — parseCustomRuleMarkers: strips `[repo-rule:<id>]` markers
// from finding body text and returns the deduped, first-seen-order rule ids.

import { describe, expect, it } from "vitest"

import { parseCustomRuleMarkers } from "./custom-rules-attribution"

describe("parseCustomRuleMarkers", () => {
  it("returns the text unchanged with no ruleIds when there's no marker", () => {
    const { text, ruleIds } = parseCustomRuleMarkers("This is a plain finding body with no marker.")
    expect(text).toBe("This is a plain finding body with no marker.")
    expect(ruleIds).toEqual([])
  })

  it("strips a trailing marker and returns the rule id", () => {
    const { text, ruleIds } = parseCustomRuleMarkers("String-concatenated SQL query here. [repo-rule:no-raw-sql]")
    expect(text).toBe("String-concatenated SQL query here.")
    expect(ruleIds).toEqual(["no-raw-sql"])
  })

  it("strips a marker anywhere in the text, not just at the end", () => {
    const { text, ruleIds } = parseCustomRuleMarkers("Bad [repo-rule:no-raw-sql] pattern here.")
    expect(text).toBe("Bad pattern here.")
    expect(ruleIds).toEqual(["no-raw-sql"])
  })

  it("dedupes repeated markers and preserves first-seen order", () => {
    const { text, ruleIds } = parseCustomRuleMarkers("Body [repo-rule:b] more text [repo-rule:a] tail [repo-rule:b]")
    expect(text).toBe("Body more text tail")
    expect(ruleIds).toEqual(["b", "a"])
  })

  it("normalizes rule id casing to lowercase", () => {
    const { ruleIds } = parseCustomRuleMarkers("Body [repo-rule:NO-RAW-SQL]")
    expect(ruleIds).toEqual(["no-raw-sql"])
  })

  it("never leaks raw marker syntax into the returned text", () => {
    const { text } = parseCustomRuleMarkers("Multiple [repo-rule:a] markers [repo-rule:b] in [repo-rule:c] one body.")
    expect(text).not.toContain("[repo-rule:")
  })

  it("does not touch an unrelated bracketed string", () => {
    const { text, ruleIds } = parseCustomRuleMarkers("See [config] for details, not a marker.")
    expect(text).toBe("See [config] for details, not a marker.")
    expect(ruleIds).toEqual([])
  })
})
