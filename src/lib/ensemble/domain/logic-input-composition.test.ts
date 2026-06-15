// SIG-369(b) PR-1 — pure unit tests for the logic-input-composition domain leaf.
//
// Pins: parser invariants (off | shadow + default-off safety), recorder
// accumulation (per-call sum, missing-usage counting NOT zero-fill, tool
// activity), `buildLogicInputComposition` assembly (REUSING measureLogicPrompt),
// and the `estimateToolResultTokens` chars/4 helper.

import { describe, expect, it } from "vitest"
import {
  buildLogicInputComposition,
  estimateToolResultTokens,
  makeLogicInputCompositionRecorder,
  parseLogicInputCompositionMode,
} from "@/src/lib/ensemble/domain/logic-input-composition"

describe("parseLogicInputCompositionMode — env flag parser", () => {
  it('returns "shadow" for exact "shadow"', () => {
    expect(parseLogicInputCompositionMode("shadow")).toBe("shadow")
  })

  it("is case-insensitive + whitespace-tolerant", () => {
    expect(parseLogicInputCompositionMode("SHADOW")).toBe("shadow")
    expect(parseLogicInputCompositionMode("  shadow  ")).toBe("shadow")
    expect(parseLogicInputCompositionMode("\tShadow\n")).toBe("shadow")
  })

  it('defaults to "off" for undefined / empty / unknown (safety net)', () => {
    expect(parseLogicInputCompositionMode(undefined)).toBe("off")
    expect(parseLogicInputCompositionMode("")).toBe("off")
    expect(parseLogicInputCompositionMode("   ")).toBe("off")
    expect(parseLogicInputCompositionMode("off")).toBe("off")
    expect(parseLogicInputCompositionMode("on")).toBe("off")
    expect(parseLogicInputCompositionMode("enforce")).toBe("off")
    expect(parseLogicInputCompositionMode("true")).toBe("off")
  })
})

describe("makeLogicInputCompositionRecorder — per-call + tool accumulation", () => {
  it("starts empty", () => {
    const r = makeLogicInputCompositionRecorder()
    expect(r.perCallInputTokens).toEqual([])
    expect(r.summedInputTokens).toBe(0)
    expect(r.callsMissingInputUsage).toBe(0)
    expect(r.toolCallsMade).toBe(0)
    expect(r.toolResultTokens).toBe(0)
  })

  it("records defined per-call input tokens and sums them", () => {
    const r = makeLogicInputCompositionRecorder()
    r.recordCall(100)
    r.recordCall(40)
    expect(r.perCallInputTokens).toEqual([100, 40])
    expect(r.summedInputTokens).toBe(140)
    expect(r.callsMissingInputUsage).toBe(0)
  })

  it("counts undefined usage in callsMissingInputUsage WITHOUT zero-filling the array", () => {
    const r = makeLogicInputCompositionRecorder()
    r.recordCall(50)
    r.recordCall(undefined)
    r.recordCall(undefined)
    r.recordCall(10)
    // missing calls are NOT pushed (so a 0-token call stays distinct from "no data")
    expect(r.perCallInputTokens).toEqual([50, 10])
    expect(r.summedInputTokens).toBe(60)
    expect(r.callsMissingInputUsage).toBe(2)
  })

  it("keeps a genuine 0-token call distinct from a missing one", () => {
    const r = makeLogicInputCompositionRecorder()
    r.recordCall(0)
    r.recordCall(undefined)
    expect(r.perCallInputTokens).toEqual([0])
    expect(r.summedInputTokens).toBe(0)
    expect(r.callsMissingInputUsage).toBe(1)
  })

  it("accumulates tool activity additively across calls", () => {
    const r = makeLogicInputCompositionRecorder()
    r.recordToolActivity(2, 300)
    r.recordToolActivity(1, 80)
    expect(r.toolCallsMade).toBe(3)
    expect(r.toolResultTokens).toBe(380)
  })
})

describe("buildLogicInputComposition — assembly (reuses measureLogicPrompt)", () => {
  const recorderWith = (perCall: Array<number | undefined>, tool?: { calls: number; tokens: number }) => {
    const r = makeLogicInputCompositionRecorder()
    for (const c of perCall) r.recordCall(c)
    if (tool) r.recordToolActivity(tool.calls, tool.tokens)
    return r
  }

  it("sizes the system prompt + initial message and carries per-call + tool stats", () => {
    const systemPrompt = "x".repeat(400) // 100 tokens
    const initialMessage = ["[DIFF]", "@@ +1,2 @@", "+line"].join("\n")
    const composition = buildLogicInputComposition({
      systemPrompt,
      initialMessage,
      toolsAvailable: false,
      recorder: recorderWith([120, 30]),
    })
    expect(composition.systemPromptTokens).toBe(100)
    // initialMessageTokens matches measureLogicPrompt's whole-prompt estimate.
    expect(composition.initialMessageTokens).toBeGreaterThan(0)
    expect(composition.sections.diff.present).toBe(true)
    expect(composition.toolLoop).toEqual({ toolsAvailable: false, toolCallsMade: 0, toolResultTokens: 0 })
    expect(composition.perCallInputTokens).toEqual([120, 30])
    expect(composition.summedInputTokens).toBe(150)
    expect(composition.callsMissingInputUsage).toBe(0)
  })

  it("reflects tool-loop activity + a missing-usage call", () => {
    const composition = buildLogicInputComposition({
      systemPrompt: "sys",
      initialMessage: "[DIFF]\n+ x",
      toolsAvailable: true,
      recorder: recorderWith([900, undefined], { calls: 1, tokens: 250 }),
    })
    expect(composition.toolLoop).toEqual({ toolsAvailable: true, toolCallsMade: 1, toolResultTokens: 250 })
    expect(composition.perCallInputTokens).toEqual([900])
    expect(composition.summedInputTokens).toBe(900)
    expect(composition.callsMissingInputUsage).toBe(1)
  })

  it("snapshots the per-call array (later recorder mutation doesn't leak in)", () => {
    const recorder = recorderWith([10])
    const composition = buildLogicInputComposition({
      systemPrompt: "s",
      initialMessage: "m",
      toolsAvailable: false,
      recorder,
    })
    recorder.recordCall(999)
    expect(composition.perCallInputTokens).toEqual([10])
  })
})

describe("estimateToolResultTokens — chars/4 over tool-result contents", () => {
  it("is 0 for no results", () => {
    expect(estimateToolResultTokens([])).toBe(0)
  })

  it("sums per-content ceil(chars/4)", () => {
    // 8 chars → 2 tokens; 4 chars → 1 token → 3 total.
    expect(estimateToolResultTokens(["abcdefgh", "abcd"])).toBe(3)
  })
})
