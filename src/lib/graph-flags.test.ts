import { describe, expect, it } from "vitest"
import { graphIndexEnabled, mentionSymbolExpansionMode } from "@/src/lib/graph-flags"

describe("graphIndexEnabled", () => {
  it('is true for "on" and "shadow", false otherwise', () => {
    expect(graphIndexEnabled({ OPENCLAW_GRAPH_INDEX: "on" })).toBe(true)
    expect(graphIndexEnabled({ OPENCLAW_GRAPH_INDEX: "shadow" })).toBe(true)
    expect(graphIndexEnabled({ OPENCLAW_GRAPH_INDEX: "off" })).toBe(false)
    expect(graphIndexEnabled({})).toBe(false)
  })
})

describe("mentionSymbolExpansionMode (SIG-407)", () => {
  it('returns "off" when unset, empty, or unrecognized', () => {
    expect(mentionSymbolExpansionMode({})).toBe("off")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "" })).toBe("off")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "enabled" })).toBe("off")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "true" })).toBe("off")
  })

  it('returns "shadow" and "on" for those exact values', () => {
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "shadow" })).toBe("shadow")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "on" })).toBe("on")
  })

  it("trims and lowercases (mirrors graphIndexEnabled)", () => {
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "  ON  " })).toBe("on")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "Shadow" })).toBe("shadow")
    expect(mentionSymbolExpansionMode({ OPENCLAW_MENTION_SYMBOL_EXPANSION: "\tOFF\n" })).toBe("off")
  })
})
