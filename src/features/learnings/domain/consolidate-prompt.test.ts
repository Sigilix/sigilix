// Gardener consolidation prompt + parser: the prompt surfaces recency/preference
// ordering, and parseConsolidation strictly validates the model JSON.

import { describe, expect, it } from "vitest"

import { buildConsolidationPrompt, parseConsolidation, type ConsolidationInput } from "./consolidate-prompt"

function input(overrides: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return {
    id: overrides.id ?? "id1",
    rule: overrides.rule ?? "wrap db calls in a service layer",
    polarity: overrides.polarity ?? "require",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    createdTs: overrides.createdTs ?? "2026-06-01T00:00:00.000Z",
    appliedCount: overrides.appliedCount ?? 0,
  }
}

describe("buildConsolidationPrompt", () => {
  it("names the Gardener, preserves polarity, and lists members with ids", () => {
    const { system, user } = buildConsolidationPrompt([
      input({ id: "aaa", rule: "rule one" }),
      input({ id: "bbb", rule: "rule two" }),
      input({ id: "ccc", rule: "rule three" }),
    ])
    expect(system).toContain("Memory Gardener")
    expect(system).toContain("PRESERVE polarity")
    expect(system).toContain("most-recent")
    expect(user).toContain("id=aaa")
    expect(user).toContain("rule two")
    expect(user).toContain("id=ccc")
  })
})

describe("parseConsolidation", () => {
  it("parses a well-formed response", () => {
    const raw = JSON.stringify({
      canonicalRule: "Always wrap DB calls in a service layer.",
      polarity: "require",
      category: "logic",
      pathGlob: "src/**",
      confidence: 0.92,
      mergedIds: ["a", "b", "c"],
    })
    const parsed = parseConsolidation(raw)
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      polarity: "require",
      category: "logic",
      pathGlob: "src/**",
      confidence: 0.92,
      mergedIds: ["a", "b", "c"],
    })
    // normalizeRule strips a leading "note:"/"remember:" but keeps the sentence.
    expect(parsed!.canonicalRule.toLowerCase()).toContain("wrap db calls")
  })

  it("tolerates prose around the JSON (parseFirstJsonObject)", () => {
    const raw = 'Here you go:\n{"canonicalRule":"do X","polarity":"context","confidence":0.9}\nThanks!'
    const parsed = parseConsolidation(raw)
    expect(parsed?.polarity).toBe("context")
    expect(parsed?.category).toBeNull()
    expect(parsed?.pathGlob).toBeNull()
    expect(parsed?.mergedIds).toEqual([])
  })

  it("clamps confidence into [0,1]", () => {
    expect(parseConsolidation('{"canonicalRule":"x","polarity":"require","confidence":1.7}')?.confidence).toBe(1)
    expect(parseConsolidation('{"canonicalRule":"x","polarity":"require","confidence":-0.3}')?.confidence).toBe(0)
  })

  it("rejects a blank/missing canonical rule", () => {
    expect(parseConsolidation('{"polarity":"require","confidence":0.9}')).toBeNull()
    expect(parseConsolidation('{"canonicalRule":"   ","polarity":"require","confidence":0.9}')).toBeNull()
  })

  it("rejects an unknown polarity and a non-number confidence", () => {
    expect(parseConsolidation('{"canonicalRule":"x","polarity":"nope","confidence":0.9}')).toBeNull()
    expect(parseConsolidation('{"canonicalRule":"x","polarity":"require","confidence":"high"}')).toBeNull()
  })

  it("rejects an unknown category (undefined) but accepts null", () => {
    expect(
      parseConsolidation('{"canonicalRule":"x","polarity":"require","confidence":0.9,"category":"bogus"}'),
    ).toBeNull()
    expect(
      parseConsolidation('{"canonicalRule":"x","polarity":"require","confidence":0.9,"category":null}')?.category,
    ).toBeNull()
  })

  it("returns null on non-JSON", () => {
    expect(parseConsolidation("not json at all")).toBeNull()
  })
})
