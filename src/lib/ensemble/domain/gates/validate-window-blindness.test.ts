// Cross-cutting over-fire Option B: window-blindness gate tests.
//
// Layer 1: evaluateWindowBlindness + isPositiveMisread + extractCitedIdentifiers
// pure unit tests — the FP-safe decision per (finding shape, full file, window).
// The detector + every exclusion, the same-symbol / upstream / out-of-window /
// dominating-indent predicate, and the never-throws contract.
//
// Layer 2: validateForSubmission integration — off / shadow / enforce wiring,
// the droppedForFailedWindowBlindnessValidation counter, the
// onWindowBlindnessFindingDropped callback, and the demote-to-body behavior.
//
// Mirrors tests/validate-absence-grounding.test.ts.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateWindowBlindness,
  isPositiveMisread,
  extractCitedIdentifiers,
  parseWindowBlindnessValidatorMode,
  type WindowBlindnessContext,
} from "@/src/lib/ensemble/domain/gates/validate-window-blindness"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

const PATH = "src/lib/fee.ts"

// A full file whose finite-guard on `amount` lives at line 5, far above the
// flagged use at line 17. The model's diff window only ever saw line 17.
const FULL_FILE = [
  /* 1 */ "export function fee(amount: number): number {",
  /* 2 */ "  const raw = amount",
  /* 3 */ "  // compute",
  /* 4 */ "  // setup",
  /* 5 */ "  if (!Number.isFinite(amount)) return 0",
  /* 6 */ "  // l6",
  /* 7 */ "  // l7",
  /* 8 */ "  // l8",
  /* 9 */ "  // l9",
  /* 10 */ "  // l10",
  /* 11 */ "  // l11",
  /* 12 */ "  // l12",
  /* 13 */ "  // l13",
  /* 14 */ "  // l14",
  /* 15 */ "  // l15",
  /* 16 */ "  // l16",
  /* 17 */ "  return computeFee(amount)",
  /* 18 */ "}",
].join("\n")

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 5,
    category: "logic",
    headline: "`amount` can be NaN",
    body: "computeFee(amount) returns NaN; no finite check guards it.",
    ...overrides,
  }
}

function ctx(overrides: Partial<WindowBlindnessContext> = {}): WindowBlindnessContext {
  return {
    fullFileByPath: new Map([[PATH, FULL_FILE]]),
    // Window = the lines the model saw. Default: only the flagged use (17).
    windowLinesByPath: new Map([[PATH, new Set([17])]]),
    ...overrides,
  }
}

// ── Layer 1a: isPositiveMisread detector ──────────────────────────────
describe("isPositiveMisread — detector + exclusions", () => {
  it("detects positive-misread phrasings", () => {
    expect(isPositiveMisread(finding({ headline: "`x` can be undefined", body: "" }))).toBe(true)
    expect(isPositiveMisread(finding({ headline: "the sum returns NaN", body: "" }))).toBe(true)
    expect(isPositiveMisread(finding({ headline: "index is unbounded", body: "" }))).toBe(true)
    expect(isPositiveMisread(finding({ headline: "value is never validated", body: "" }))).toBe(true)
    expect(isPositiveMisread(finding({ headline: "no bounds check on the array index", body: "" }))).toBe(true)
    expect(isPositiveMisread(finding({ headline: "unchecked index access", body: "" }))).toBe(true)
  })

  it("EXCLUDES past-tense / fix / conditional / negation phrasings", () => {
    expect(isPositiveMisread(finding({ headline: "now validates the input", body: "" }))).toBe(false)
    expect(isPositiveMisread(finding({ headline: "adds the missing clamp", body: "" }))).toBe(false)
    expect(isPositiveMisread(finding({ headline: "`amount` was unbounded before this PR", body: "" }))).toBe(false)
    expect(isPositiveMisread(finding({ headline: "if `x` can be undefined we should guard", body: "" }))).toBe(false)
    expect(isPositiveMisread(finding({ headline: "the value is not unbounded", body: "" }))).toBe(false)
  })

  it("does not fire on unrelated prose", () => {
    expect(isPositiveMisread(finding({ headline: "rename this variable", body: "for clarity" }))).toBe(false)
  })
})

// ── Layer 1b: extractCitedIdentifiers ─────────────────────────────────
describe("extractCitedIdentifiers", () => {
  it("extracts user identifiers, drops reserved words + built-ins + 1-char names", () => {
    const ids = extractCitedIdentifiers("  return computeFee(amount)")
    expect(ids).toContain("computeFee")
    expect(ids).toContain("amount")
    expect(ids).not.toContain("return")
    const ids2 = extractCitedIdentifiers("  const x = Math.min(raw, 100)")
    expect(ids2).toContain("raw")
    expect(ids2).not.toContain("Math")
    expect(ids2).not.toContain("const")
    expect(ids2).not.toContain("x") // 1-char dropped
  })
})

// ── Layer 1c: evaluateWindowBlindness predicate ───────────────────────
describe("evaluateWindowBlindness — DEMOTE only on a provable out-of-window guard", () => {
  it("DEMOTES: sev5 logic misread, finite guard on the SAME symbol upstream + out-of-window", () => {
    const d = evaluateWindowBlindness(finding(), ctx())
    expect(d.keep).toBe(false)
    if (!d.keep) {
      expect(d.reason).toBe("positive-misread-guard-out-of-window")
      expect(d.matchedIdentifier).toBe("amount")
      expect(d.guardLine).toBe(5)
    }
  })

  it("KEEPS when the subject is REASSIGNED between the guard and the flagged use (guard may be undone)", () => {
    const full = [
      "export function fee(amount: number): number {", // 1
      "  if (!Number.isFinite(amount)) return 0", // 2 — guard
      "  // l3",
      "  // l4",
      "  amount = readRaw()", // 5 — reassignment undoes the guard
      "  // l6",
      "  return computeFee(amount)", // 7 — flagged use
      "}",
    ].join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 7 }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([7])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the cited-line guard candidate is NOT a subject of the finding text (co-cited variable)", () => {
    // cited line names both `amount` and `helper`; the finding only complains
    // about `amount`; the out-of-window guard is on `helper` → must KEEP.
    const full = [
      "export function fee(amount: number): number {", // 1
      "  if (!Number.isFinite(helper)) return 0", // 2 — guard on helper, not amount
      "  // l3",
      "  return helper(amount)", // 4 — both cited, finding is about amount
      "}",
    ].join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 4, headline: "`amount` can be NaN", body: "amount is never finite-checked." }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([4])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("word-boundary: a guard on `myAmount` does NOT count for cited `amount`", () => {
    const full = [
      "export function fee(amount: number): number {", // 1
      "  if (!Number.isFinite(myAmount)) return 0", // 2 — superset identifier
      "  // l3",
      "  return computeFee(amount)", // 4
      "}",
    ].join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 4 }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([4])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("a bare `.length` read is NOT a guard; a `.length` comparison IS", () => {
    const bare = [
      "export function fee(items: number[]): number {", // 1
      "  const n = items.length", // 2 — bare read, not a guard
      "  // l3",
      "  return items[5]", // 4
      "}",
    ].join("\n")
    const keep = evaluateWindowBlindness(
      finding({ line: 4, headline: "`items` index is unbounded", body: "items has no length check." }),
      ctx({ fullFileByPath: new Map([[PATH, bare]]), windowLinesByPath: new Map([[PATH, new Set([4])]]) }),
    )
    expect(keep.keep).toBe(true)

    const cmp = bare.replace("const n = items.length", "if (items.length > 5) return 0")
    const demote = evaluateWindowBlindness(
      finding({ line: 4, headline: "`items` index is unbounded", body: "items has no length check." }),
      ctx({ fullFileByPath: new Map([[PATH, cmp]]), windowLinesByPath: new Map([[PATH, new Set([4])]]) }),
    )
    expect(demote.keep).toBe(false)
  })

  it("KEEPS when the guard line IS in the window (the model saw it and judged it insufficient)", () => {
    const d = evaluateWindowBlindness(
      finding(),
      ctx({ windowLinesByPath: new Map([[PATH, new Set([5, 17])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the guard is on a DIFFERENT symbol than any cited identifier", () => {
    const full = FULL_FILE.replace("if (!Number.isFinite(amount)) return 0", "if (!Number.isFinite(other)) return 0")
    const d = evaluateWindowBlindness(finding(), ctx({ fullFileByPath: new Map([[PATH, full]]) }))
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the only guard is DOWNSTREAM of the flagged use", () => {
    const full = [
      "export function fee(amount: number): number {",
      "  return computeFee(amount)", // line 2 = flagged use
      "  if (!Number.isFinite(amount)) return 0", // line 3 = guard, downstream
      "}",
    ].join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 2 }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([2])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the guard is nested DEEPER than the flagged use (non-dominating branch)", () => {
    const full = [
      "export function fee(amount: number): number {", // 1
      "  if (flag) {", // 2
      "      if (!Number.isFinite(amount)) return 0", // 3 — deeply indented guard
      "  }", // 4
      "  // l5",
      "  // l6",
      "  // l7",
      "  return computeFee(amount)", // 8 — flagged use, indent 2
      "}",
    ].join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 8 }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([8])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("KEEPS when no full file is available for the path", () => {
    const d = evaluateWindowBlindness(finding(), ctx({ fullFileByPath: new Map() }))
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the window is not reconstructable for the path", () => {
    const d = evaluateWindowBlindness(finding(), ctx({ windowLinesByPath: new Map() }))
    expect(d.keep).toBe(true)
  })

  it("KEEPS a non-logic finding even with the same shape", () => {
    const d = evaluateWindowBlindness(finding({ category: "security" }), ctx())
    expect(d.keep).toBe(true)
  })

  it("KEEPS a sub-4 logic finding (scoped to the high-severity over-fire)", () => {
    const d = evaluateWindowBlindness(finding({ score: 3 }), ctx())
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the finding is not a positive misread", () => {
    const d = evaluateWindowBlindness(finding({ headline: "rename for clarity", body: "" }), ctx())
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the guard is beyond the upstream proximity bound", () => {
    // guard at line 1, flagged use at line 60 (> 40 lines away)
    const lines = ["  if (!Number.isFinite(amount)) return 0"]
    for (let i = 2; i < 60; i++) lines.push(`  // l${i}`)
    lines.push("  return computeFee(amount)") // line 60
    const full = lines.join("\n")
    const d = evaluateWindowBlindness(
      finding({ line: 60 }),
      ctx({ fullFileByPath: new Map([[PATH, full]]), windowLinesByPath: new Map([[PATH, new Set([60])]]) }),
    )
    expect(d.keep).toBe(true)
  })

  it("KEEPS when the cited line is out of range vs the full file (stale anchor)", () => {
    const d = evaluateWindowBlindness(finding({ line: 9999 }), ctx())
    expect(d.keep).toBe(true)
  })

  it("never throws on a malformed finding/context", () => {
    expect(() =>
      evaluateWindowBlindness(finding({ headline: "", body: "" }), {
        fullFileByPath: new Map(),
        windowLinesByPath: new Map(),
      }),
    ).not.toThrow()
  })
})

describe("parseWindowBlindnessValidatorMode", () => {
  it("parses shadow/enforce, defaults everything else to off", () => {
    expect(parseWindowBlindnessValidatorMode("shadow")).toBe("shadow")
    expect(parseWindowBlindnessValidatorMode("ENFORCE")).toBe("enforce")
    expect(parseWindowBlindnessValidatorMode(undefined)).toBe("off")
    expect(parseWindowBlindnessValidatorMode("")).toBe("off")
    expect(parseWindowBlindnessValidatorMode("on")).toBe("off")
  })
})

// ── Layer 2: validateForSubmission integration ────────────────────────

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeReviewable(): ReviewableMap {
  // The model's window = line 17 only (RIGHT side). The guard at line 5 is NOT
  // a reviewable position, so the gate sees it as out-of-window. Typed directly
  // (no `unknown as`) so the ReviewablePosition contract is actually exercised.
  return new Map([[PATH, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "logic", verdict: { findings: [{ id: "logic-0" }] } }] as unknown as SpecialistVerdictsArg
}
function prov(count = 1): SynthesizerProvenance {
  return {
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: ["logic"],
      sourceFindingIds: ["logic-0"],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}

function run(
  findings: PrReviewFinding[],
  opts: { mode?: "off" | "shadow" | "enforce"; onDrop?: (...a: unknown[]) => void } = {},
) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
      provenance: prov(findings.length),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    fullFileByPath: new Map([[PATH, FULL_FILE]]),
    ...(opts.mode ? { windowBlindnessValidatorMode: opts.mode } : {}),
    ...(opts.onDrop ? { onWindowBlindnessFindingDropped: opts.onDrop } : {}),
  })
}

describe("validateForSubmission — window-blindness gate wiring", () => {
  it("OFF (default): the gate never runs — counter 0, finding kept inline, callback not fired", () => {
    const onDrop = vi.fn()
    const result = run([finding()], { onDrop })
    expect(result.droppedForFailedWindowBlindnessValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("SHADOW: counts the would-demote + fires callback dropped:false but KEEPS the finding inline", () => {
    const onDrop = vi.fn()
    const result = run([finding()], { mode: "shadow", onDrop })
    expect(result.droppedForFailedWindowBlindnessValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.unanchoredFindings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "positive-misread-guard-out-of-window",
      matchedIdentifier: "amount",
      guardLine: 5,
      dropped: false,
    })
  })

  it("ENFORCE: demotes the misread to the body (counter++, callback dropped:true, leaves verdict.findings)", () => {
    const onDrop = vi.fn()
    const result = run([finding()], { mode: "enforce", onDrop })
    expect(result.droppedForFailedWindowBlindnessValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline.includes("amount"))).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "positive-misread-guard-out-of-window",
      matchedIdentifier: "amount",
      guardLine: 5,
      dropped: true,
    })
  })
})
