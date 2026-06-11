// SIG-236 — pure unit tests on the logic prompt-budget helpers.
//
// This module is the shadow-mode telemetry layer; the actual
// truncation lands in a follow-up enforce-mode PR. Tests here pin:
//   - parser invariants (off | shadow | enforce + default-off safety)
//   - token-estimate math (chars/4 ceiling — matches repo convention)
//   - per-section measurement (header-marker detection + span lengths)
//   - over-cap derivation against LOGIC_PROMPT_INPUT_TOKEN_CAP

import { describe, expect, it, vi } from "vitest"
import {
  applyLogicPromptBudget,
  estimateTokens,
  LOGIC_PROMPT_DROP_ORDER,
  LOGIC_PROMPT_INPUT_TOKEN_CAP,
  maybeEmitLogicPromptBudget,
  measureLogicPrompt,
  parseLogicPromptBudgetMode,
  trimLogicPrompt,
} from "@/src/lib/logic-prompt-budget"

describe("parseLogicPromptBudgetMode — env flag parser", () => {
  describe("happy path — recognized values", () => {
    it('returns "off" for exact "off"', () => {
      expect(parseLogicPromptBudgetMode("off")).toBe("off")
    })

    it('returns "shadow" for exact "shadow"', () => {
      expect(parseLogicPromptBudgetMode("shadow")).toBe("shadow")
    })

    it('returns "enforce" for exact "enforce"', () => {
      expect(parseLogicPromptBudgetMode("enforce")).toBe("enforce")
    })

    it("is case-insensitive + whitespace-tolerant", () => {
      expect(parseLogicPromptBudgetMode("OFF")).toBe("off")
      expect(parseLogicPromptBudgetMode("SHADOW")).toBe("shadow")
      expect(parseLogicPromptBudgetMode("  enforce  ")).toBe("enforce")
      expect(parseLogicPromptBudgetMode("\tShadow\n")).toBe("shadow")
    })
  })

  describe("safety net — default off for everything else", () => {
    it('returns "off" for undefined', () => {
      expect(parseLogicPromptBudgetMode(undefined)).toBe("off")
    })

    it('returns "off" for empty / whitespace-only', () => {
      expect(parseLogicPromptBudgetMode("")).toBe("off")
      expect(parseLogicPromptBudgetMode("   ")).toBe("off")
    })

    it('returns "off" for typos + unknown values', () => {
      expect(parseLogicPromptBudgetMode("on")).toBe("off")
      expect(parseLogicPromptBudgetMode("enabled")).toBe("off")
      expect(parseLogicPromptBudgetMode("enforced")).toBe("off")
      expect(parseLogicPromptBudgetMode("true")).toBe("off")
      expect(parseLogicPromptBudgetMode("1")).toBe("off")
    })
  })
})

describe("estimateTokens — char/4 heuristic", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })

  it("rounds UP via Math.ceil so partial tokens are charged", () => {
    expect(estimateTokens("a")).toBe(1)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("abcdefgh")).toBe(2)
    expect(estimateTokens("abcdefghi")).toBe(3)
  })

  it("scales linearly on large inputs", () => {
    const text = "x".repeat(8_000)
    expect(estimateTokens(text)).toBe(2_000)
  })
})

describe("measureLogicPrompt — section detection + span counting", () => {
  it("returns 0 totalTokens + all sections absent on empty input", () => {
    const m = measureLogicPrompt("")
    expect(m.totalTokens).toBe(0)
    expect(m.sections.diff.present).toBe(false)
    expect(m.sections.graphContext.present).toBe(false)
    expect(m.sections.symbolRetrieval.present).toBe(false)
    expect(m.sections.vectorizeRetrieval.present).toBe(false)
    expect(m.sections.dynamicEvidence.present).toBe(false)
    expect(m.sections.deterministicChecks.present).toBe(false)
  })

  it("detects [DIFF] header marker (anchored to start-of-line)", () => {
    // Anchored ^\[DIFF\]$/m so a code block mentioning [DIFF] inline
    // can't false-positive.
    const m = measureLogicPrompt("intro\n[DIFF]\n@@ +5,3 @@ ...")
    expect(m.sections.diff.present).toBe(true)
    expect(m.sections.diff.tokens).toBeGreaterThan(0)
  })

  it("detects [GRAPH CONTEXT — …] header marker (descriptor-tolerant via \\b)", () => {
    const m = measureLogicPrompt("intro\n[GRAPH CONTEXT — dependency-graph neighbors of the changed code]\nedges here")
    expect(m.sections.graphContext.present).toBe(true)
    expect(m.sections.graphContext.tokens).toBeGreaterThan(0)
  })

  it("detects [LOGIC SYMBOL CONTEXT — …] header marker (NOT the originally-assumed [SYMBOL RETRIEVAL])", () => {
    // Code-reviewer's C1 catch: the actual emitter from
    // `symbol-retrieval.ts` writes `[LOGIC SYMBOL CONTEXT — ...`, not
    // `[SYMBOL RETRIEVAL]`. Before the fix this test would have read
    // `present: false` despite the section being fully populated.
    const m = measureLogicPrompt("[LOGIC SYMBOL CONTEXT — local code for changed symbols]\nfoo bar")
    expect(m.sections.symbolRetrieval.present).toBe(true)
  })

  it("detects [RETRIEVAL SNAPSHOT] header marker (anchored to line)", () => {
    const m = measureLogicPrompt("intro\n[RETRIEVAL SNAPSHOT]\nchunks here")
    expect(m.sections.vectorizeRetrieval.present).toBe(true)
  })

  it("detects [DYNAMIC REVIEW EVIDENCE — …] header marker", () => {
    const m = measureLogicPrompt("[DYNAMIC REVIEW EVIDENCE — changed-symbol context]\nevidence")
    expect(m.sections.dynamicEvidence.present).toBe(true)
  })

  it("detects [DETERMINISTIC CHECKS — …] header marker", () => {
    const m = measureLogicPrompt("[DETERMINISTIC CHECKS — pre-computed before LLM]\nast facts")
    expect(m.sections.deterministicChecks.present).toBe(true)
  })

  it("computes section spans by next-marker distance", () => {
    // First section span is from [LOGIC SYMBOL CONTEXT] to [GRAPH CONTEXT],
    // second span is from [GRAPH CONTEXT] to end-of-string.
    const prompt =
      "[LOGIC SYMBOL CONTEXT — header]\n" +
      "x".repeat(40) + // ~10 tokens (40 chars / 4)
      "\n[GRAPH CONTEXT — header]\n" +
      "y".repeat(80) // ~20+ tokens
    const m = measureLogicPrompt(prompt)
    expect(m.sections.symbolRetrieval.present).toBe(true)
    expect(m.sections.graphContext.present).toBe(true)
    expect(m.sections.graphContext.tokens).toBeGreaterThan(m.sections.symbolRetrieval.tokens)
  })

  it("does NOT false-positive on marker-like literals mid-line (CR Major anchor fix — 2026-05-26)", () => {
    // CodeRabbit's catch: before this fix, four markers (graphContext,
    // symbolRetrieval, dynamicEvidence, deterministicChecks) matched
    // anywhere in the body via `\b` alone. A diff editing this very
    // file — or a user docstring — could contain a marker-like literal
    // mid-line and skew section telemetry. All six are now anchored
    // to start-of-line via `^...` + `/m`.
    const promptWithMidLineLiterals = [
      "[DIFF]",
      '+ const fakeRef = "[GRAPH CONTEXT — embedded in a string literal]"',
      "+ // prose mentioning [DETERMINISTIC CHECKS — in a comment] mid-line",
      '+ console.log("[LOGIC SYMBOL CONTEXT — string literal")',
      "+ // edited review-evidence-pack.ts to handle [DYNAMIC REVIEW EVIDENCE",
    ].join("\n")
    const m = measureLogicPrompt(promptWithMidLineLiterals)
    // Only [DIFF] should detect (the only marker on its own line).
    expect(m.sections.diff.present).toBe(true)
    expect(m.sections.graphContext.present).toBe(false)
    expect(m.sections.symbolRetrieval.present).toBe(false)
    expect(m.sections.deterministicChecks.present).toBe(false)
    expect(m.sections.dynamicEvidence.present).toBe(false)
  })

  it("detects ALL SIX section markers in a representative logic prompt (regression guard for marker drift — C1)", () => {
    // Code-reviewer's C1: the previous marker set missed 3 of 6 actual
    // headers. This integration-shaped test exercises all six markers
    // simultaneously using the EXACT strings the production emitters
    // produce (verified against `pr-review-specialists.ts`,
    // `symbol-retrieval.ts`, `review-evidence-pack.ts`,
    // `deterministic-checks.ts`). If any emitter ever changes its
    // header text without updating PROMPT_SECTION_MARKERS, this test
    // fails — preventing the silent shadow-telemetry drift that the
    // shipped-but-broken regex would have caused.
    const representative = [
      "[DETERMINISTIC CHECKS — pre-computed before LLM, treat as authoritative facts]",
      "fact 1",
      "fact 2",
      "",
      "[DIFF]",
      "@@ +1,3 @@",
      " line a",
      "+line b",
      "",
      "[RETRIEVAL SNAPSHOT]",
      "chunk 1 content",
      "chunk 2 content",
      "[LOGIC SYMBOL CONTEXT — local code for changed symbols]",
      "function foo() { ... }",
      "",
      "[GRAPH CONTEXT — dependency-graph neighbors of the changed code; additive, may be incomplete]",
      "src/a.ts (hop1, dependsOn)",
      "src/b.ts (hop2, dependent)",
      "",
      "[DYNAMIC REVIEW EVIDENCE — changed-symbol context]",
      "evidence card 1",
    ].join("\n")
    const m = measureLogicPrompt(representative)
    expect(m.sections.diff.present).toBe(true)
    expect(m.sections.graphContext.present).toBe(true)
    expect(m.sections.symbolRetrieval.present).toBe(true)
    expect(m.sections.vectorizeRetrieval.present).toBe(true)
    expect(m.sections.dynamicEvidence.present).toBe(true)
    expect(m.sections.deterministicChecks.present).toBe(true)
    // Each detected section has a positive token count.
    expect(m.sections.diff.tokens).toBeGreaterThan(0)
    expect(m.sections.graphContext.tokens).toBeGreaterThan(0)
    expect(m.sections.symbolRetrieval.tokens).toBeGreaterThan(0)
    expect(m.sections.vectorizeRetrieval.tokens).toBeGreaterThan(0)
    expect(m.sections.dynamicEvidence.tokens).toBeGreaterThan(0)
    expect(m.sections.deterministicChecks.tokens).toBeGreaterThan(0)
    // Per-section sums can exceed totalTokens slightly because each
    // section's token count is `Math.ceil(slice.length / 4)`; six
    // ceilings can add up to ~+5 tokens over the total. The shape
    // invariant is "every section detected + positive size," not
    // strict sum-equals-total.
  })

  it("flags overCap when totalTokens exceeds LOGIC_PROMPT_INPUT_TOKEN_CAP", () => {
    // Build a prompt slightly over the 6_000-token cap (~24_001 chars).
    const overSized = "x".repeat(LOGIC_PROMPT_INPUT_TOKEN_CAP * 4 + 100)
    const m = measureLogicPrompt(overSized)
    expect(m.overCap).toBe(true)
    expect(m.overByTokens).toBeGreaterThan(0)
  })

  it("reports overByTokens as negative when under cap", () => {
    const m = measureLogicPrompt("short prompt")
    expect(m.overCap).toBe(false)
    expect(m.overByTokens).toBeLessThan(0)
  })
})

describe("maybeEmitLogicPromptBudget — telemetry side-effect", () => {
  const baseArgs = {
    prompt: "[GRAPH CONTEXT — header]\nedges",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 188,
    headSha: "deadbeefcafe",
  }

  it('is a no-op when mode === "off"', () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      maybeEmitLogicPromptBudget({ ...baseArgs, mode: "off" })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('emits a `logic-prompt-budget` event in shadow mode with mode: "shadow"', () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      maybeEmitLogicPromptBudget({ ...baseArgs, mode: "shadow" })
      expect(spy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(spy.mock.calls[0]![0] as string)
      expect(payload.event).toBe("logic-prompt-budget")
      expect(payload.mode).toBe("shadow")
      expect(payload.owner).toBe("Sigilix")
      // CR-trivial fix: also assert repo + headSha to confirm full
      // join-key set lands on the event for dashboard correlation.
      expect(payload.repo).toBe("sigilix")
      expect(payload.headSha).toBe("deadbee")
      expect(payload.prNumber).toBe(188)
      expect(payload.capTokens).toBe(LOGIC_PROMPT_INPUT_TOKEN_CAP)
      expect(typeof payload.totalTokens).toBe("number")
      expect(payload.sections.graphContext.present).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('records mode: "enforce-pending" in enforce mode (truncation not yet implemented)', () => {
    // Enforce-mode signals an OPS-level expectation but doesn't
    // truncate in this PR. Emitting "enforce-pending" lets the
    // dashboard catch premature flips.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      maybeEmitLogicPromptBudget({ ...baseArgs, mode: "enforce" })
      expect(spy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(spy.mock.calls[0]![0] as string)
      expect(payload.mode).toBe("enforce-pending")
    } finally {
      spy.mockRestore()
    }
  })

  it("truncates headSha to 7 chars in the emitted event", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      maybeEmitLogicPromptBudget({
        ...baseArgs,
        mode: "shadow",
        headSha: "0123456789abcdef",
      })
      const payload = JSON.parse(spy.mock.calls[0]![0] as string)
      expect(payload.headSha).toBe("0123456")
    } finally {
      spy.mockRestore()
    }
  })
})

// ─── SIG-287: enforce-mode trim ──────────────────────────────────────
// Build a section as `MARKER\n<filler>` sized to ~`tokens` (chars = tokens*4).
function section(marker: string, tokens: number): string {
  const fill = "x".repeat(Math.max(0, tokens * 4 - marker.length - 1))
  return `${marker}\n${fill}`
}
// A prompt where dropping the lowest-priority sections brings it under `cap`,
// but the diff + graph + symbol + deterministic checks should survive.
function buildPrompt(sizes: {
  diff: number
  graph: number
  symbol: number
  vectorize: number
  dynamic: number
  det: number
}): string {
  return [
    section("[DIFF]", sizes.diff),
    section("[GRAPH CONTEXT — neighbors]", sizes.graph),
    section("[LOGIC SYMBOL CONTEXT — symbols]", sizes.symbol),
    section("[RETRIEVAL SNAPSHOT]", sizes.vectorize),
    section("[DYNAMIC REVIEW EVIDENCE — cards]", sizes.dynamic),
    section("[DETERMINISTIC CHECKS — ast]", sizes.det),
  ].join("\n")
}

describe("trimLogicPrompt — SIG-287 enforce trimming", () => {
  it("documents the drop order (lowest-value first) + never drops diff/graph/AST", () => {
    expect(LOGIC_PROMPT_DROP_ORDER).toEqual(["dynamicEvidence", "vectorizeRetrieval", "symbolRetrieval"])
    // Mandatory / precision-relevant sections are NOT droppable:
    expect(LOGIC_PROMPT_DROP_ORDER).not.toContain("diff")
    expect(LOGIC_PROMPT_DROP_ORDER).not.toContain("deterministicChecks")
    expect(LOGIC_PROMPT_DROP_ORDER).not.toContain("graphContext")
  })

  it("is a no-op when already within cap", () => {
    const prompt = buildPrompt({ diff: 10, graph: 5, symbol: 5, vectorize: 5, dynamic: 5, det: 2 })
    const r = trimLogicPrompt(prompt, 100)
    expect(r.trimmed).toEqual([])
    expect(r.prompt).toBe(prompt)
    expect(r.afterTokens).toBe(r.beforeTokens)
  })

  it("drops only enough low-priority sections to fit, keeping higher-priority ones", () => {
    // total 160 tokens, cap 100. Drop dynamic(40)→120, vectorize(40)→80 ≤100 → stop.
    const prompt = buildPrompt({
      diff: 30,
      graph: 20,
      symbol: 20,
      vectorize: 40,
      dynamic: 40,
      det: 10,
    })
    const r = trimLogicPrompt(prompt, 100)
    expect(r.trimmed).toEqual(["dynamicEvidence", "vectorizeRetrieval"])
    expect(r.afterTokens).toBeLessThanOrEqual(100)
    expect(r.afterTokens).toBeLessThan(r.beforeTokens)
    // Survivors present, dropped sections gone:
    expect(r.prompt).toContain("[DIFF]")
    expect(r.prompt).toContain("[GRAPH CONTEXT")
    expect(r.prompt).toContain("[LOGIC SYMBOL CONTEXT")
    expect(r.prompt).toContain("[DETERMINISTIC CHECKS")
    expect(r.prompt).not.toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(r.prompt).not.toContain("[RETRIEVAL SNAPSHOT]")
  })

  it("NEVER drops the diff, graph, or deterministic-checks, even if still over cap after all droppables", () => {
    // diff alone (200) blows a tiny cap; every DROPPABLE section is removed but
    // diff + graph + det stay (graph is precision-relevant, not droppable).
    const prompt = buildPrompt({
      diff: 200,
      graph: 50,
      symbol: 50,
      vectorize: 50,
      dynamic: 50,
      det: 20,
    })
    const r = trimLogicPrompt(prompt, 100)
    expect(r.trimmed).toEqual(["dynamicEvidence", "vectorizeRetrieval", "symbolRetrieval"])
    expect(r.prompt).toContain("[DIFF]")
    expect(r.prompt).toContain("[GRAPH CONTEXT") // precision signal preserved
    expect(r.prompt).toContain("[DETERMINISTIC CHECKS")
    // Still over cap (diff is mandatory + huge) — but the diff/graph are never sacrificed.
    expect(r.afterTokens).toBeGreaterThan(100)
  })

  it("dropping a section NEVER absorbs the trailing unrecognized blocks (Codex HIGH: [REPO RULES] etc.)", () => {
    // vectorizeRetrieval is the LAST recognized section here, followed by an
    // UNRECOGNIZED block ([REPO RULES — LOGIC], appended by appendRoleRule).
    // Before the span-bounding fix, dropping vectorize would have absorbed +
    // deleted the repo rules. Now the span ends at the next [HEADER, so the
    // repo rules survive.
    const prompt = [
      section("[DIFF]", 30),
      section("[RETRIEVAL SNAPSHOT]", 200), // big → forces a drop; last recognized section
      "[REPO RULES — LOGIC (from sigilix.json)]\n- prefer X over Y", // unrecognized trailing block
    ].join("\n")
    const r = trimLogicPrompt(prompt, 100)
    expect(r.trimmed).toContain("vectorizeRetrieval")
    expect(r.prompt).not.toContain("[RETRIEVAL SNAPSHOT]") // dropped
    expect(r.prompt).toContain("[REPO RULES — LOGIC") // PRESERVED — not absorbed
    expect(r.prompt).toContain("prefer X over Y")
    expect(r.prompt).toContain("[DIFF]")
  })
})

describe("applyLogicPromptBudget — mode routing", () => {
  const big = buildPrompt({
    diff: 30,
    graph: 20,
    symbol: 20,
    vectorize: 8000,
    dynamic: 4000,
    det: 10,
  })
  const args = (mode: "off" | "shadow" | "enforce") => ({
    mode,
    prompt: big,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "abcdef0",
  })

  it("off → passthrough (prompt unchanged)", () => {
    expect(applyLogicPromptBudget(args("off"))).toBe(big)
  })

  it("shadow → passthrough (measures but does not trim)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(applyLogicPromptBudget(args("shadow"))).toBe(big)
    } finally {
      spy.mockRestore()
    }
  })

  it("enforce → returns a trimmed prompt under the cap", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const out = applyLogicPromptBudget(args("enforce"))
      expect(out).not.toBe(big)
      expect(estimateTokens(out)).toBeLessThanOrEqual(LOGIC_PROMPT_INPUT_TOKEN_CAP)
      expect(estimateTokens(out)).toBeLessThan(estimateTokens(big))
      expect(out).toContain("[DIFF]") // mandatory survives
    } finally {
      spy.mockRestore()
    }
  })
})
