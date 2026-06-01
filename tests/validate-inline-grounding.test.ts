// SIG-281 PR C (Rec 4): inline-grounding gate tests.
//
// Layer 1 (this file, for now): evaluateInlineGrounding pure unit tests —
// the FP-safe decision per (finding shape, diff evidence). The
// validateForSubmission integration layer (shadow vs enforce, the
// droppedForFailedInlineGroundingValidation counter + callback) is added
// once the demote-vs-drop wiring is confirmed.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateInlineGrounding,
  hasResolvableBacktickedToken,
  parseInlineGroundingValidatorMode,
  type InlineGroundingEvidence,
} from "../src/lib/validate-inline-grounding"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { ReviewableMap } from "../src/lib/diff-positions"

const PATH = "src/lib/orders.ts"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 2, // sub-4 band by default — this gate's domain
    category: "style",
    headline: "naming is inconsistent here",
    body: "Consider a clearer name.",
    ...overrides,
  }
}

/** Build the per-line added-line map the ensemble supplies. */
function diff(
  byPath: Record<string, Record<number, string>> = {
    [PATH]: { 17: "  const totalAmount = computeTotal(rows)" },
  },
): ReadonlyMap<string, ReadonlyMap<number, string>> {
  return new Map(
    Object.entries(byPath).map(([p, lines]) => [
      p,
      new Map(Object.entries(lines).map(([ln, text]) => [Number(ln), text])),
    ]),
  )
}

const ev = (overrides: Partial<InlineGroundingEvidence> = {}): InlineGroundingEvidence => ({
  addedLineTextByLine: diff(),
  ...overrides,
})

describe("evaluateInlineGrounding — believability floor + back-compat", () => {
  it("ALWAYS keeps a score >= 4 finding, even ungrounded (the floor is untouchable)", () => {
    expect(evaluateInlineGrounding(finding({ score: 4 }), ev())).toEqual({ keep: true })
    expect(evaluateInlineGrounding(finding({ score: 5 }), ev())).toEqual({ keep: true })
  })

  it("ALWAYS keeps a score <= 1 finding even ungrounded with the diff wired (the score-1 advisory path owns it downstream — demoting here would bypass chill suppression)", () => {
    expect(
      evaluateInlineGrounding(
        finding({ score: 1, headline: "vague nit", body: "no refs" }),
        ev(),
      ),
    ).toEqual({ keep: true })
  })

  it("ALWAYS keeps when the diff is not wired (addedLineTextByLine undefined)", () => {
    expect(
      evaluateInlineGrounding(finding({ score: 1 }), { addedLineTextByLine: undefined }),
    ).toEqual({ keep: true })
    // even an utterly ungrounded sub-4 finding keeps when there's no diff
    // to evaluate against (back-compat / un-threaded caller / tests).
    expect(evaluateInlineGrounding(finding({ score: 2 }), {})).toEqual({ keep: true })
  })
})

describe("evaluateInlineGrounding — grounding signals keep a sub-4 finding inline", () => {
  it("keeps when it carries a committable fix (suggestedReplacement)", () => {
    expect(
      evaluateInlineGrounding(
        finding({ score: 2, suggestedReplacement: "const orderTotal = computeTotal(rows)" }),
        ev(),
      ),
    ).toEqual({ keep: true })
  })

  it("keeps a deletion suggestion (kind delete + empty replacement)", () => {
    expect(
      evaluateInlineGrounding(finding({ score: 2, kind: "delete", suggestedReplacement: "" }), ev()),
    ).toEqual({ keep: true })
  })

  it("keeps when it carries a repro (failureExample)", () => {
    expect(
      evaluateInlineGrounding(finding({ score: 2, failureExample: "throws on empty rows" }), ev()),
    ).toEqual({ keep: true })
  })

  it("keeps when it carries evidenceRefs", () => {
    expect(
      evaluateInlineGrounding(finding({ score: 3, evidenceRefs: ["src/lib/orders.ts:40"] }), ev()),
    ).toEqual({ keep: true })
  })

  it("keeps when it carries a real evidenceId", () => {
    expect(
      evaluateInlineGrounding(finding({ score: 3, evidenceId: "ast-logic-7" }), ev()),
    ).toEqual({ keep: true })
  })

  it("does NOT credit evidenceId === 'NONE' (the SIG-108 authz sentinel)", () => {
    // 'NONE' is a deliberate non-citation, so a finding whose ONLY signal
    // is evidenceId:'NONE' (and no resolvable token) is demoted.
    const out = evaluateInlineGrounding(
      finding({ score: 2, evidenceId: "NONE", headline: "vague note", body: "no code refs" }),
      ev(),
    )
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })

  it("keeps when a backticked token resolves to a changed line", () => {
    // `computeTotal` appears on changed line 17.
    expect(
      evaluateInlineGrounding(
        finding({ score: 2, headline: "rename `computeTotal` for clarity" }),
        ev(),
      ),
    ).toEqual({ keep: true })
  })
})

describe("evaluateInlineGrounding — demotes a truly ungrounded sub-4 finding", () => {
  it("demotes a sub-4 finding with no fix, no repro, no evidence, no resolvable token", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 2, headline: "this could be cleaner", body: "general style nit" }),
      ev(),
    )
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })

  it("demotes when the backticked token does NOT appear on any changed line", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 3, headline: "`unrelatedSymbol` is misused", body: "see `alsoNotChanged`" }),
      ev(),
    )
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })

  it("demotes when the only backticked tokens are too short or numeric (not real anchors)", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 2, headline: "off by `1`", body: "compare with `x` and `==`" }),
      ev({ addedLineTextByLine: diff({ [PATH]: { 17: "  const x = 1 == y" } }) }),
    )
    // `1`, `x`, `==` all fail the length>=2 && identifier filter.
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })

  it("Codex/CR FP: a pure-identifier token does NOT false-anchor on a longer identifier (`async` must not match `asyncHelper`)", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 2, headline: "Consider using `async` keyword", body: "style" }),
      ev({ addedLineTextByLine: diff({ [PATH]: { 17: "const asyncHelper = (x) => x" } }) }),
    )
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })

  it("keeps an EXPRESSION-fragment token via substring containment (`arr[i]`)", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 2, headline: "bounds on `arr[i]`" }),
      ev({ addedLineTextByLine: diff({ [PATH]: { 17: "  return arr[i] + 1" } }) }),
    )
    expect(out).toEqual({ keep: true })
  })

  it("demotes when the finding's path is not in the changed set", () => {
    const out = evaluateInlineGrounding(
      finding({ score: 2, path: "src/other.ts", headline: "rename `computeTotal`" }),
      ev(),
    )
    expect(out).toEqual({ keep: false, reason: "ungrounded-inline-finding" })
  })
})

describe("hasResolvableBacktickedToken", () => {
  it("matches a multi-char identifier token via substring containment", () => {
    expect(hasResolvableBacktickedToken(finding({ headline: "`computeTotal`" }), diff())).toBe(true)
  })
  it("is false when no token matches a changed line", () => {
    expect(hasResolvableBacktickedToken(finding({ headline: "`nope`" }), diff())).toBe(false)
  })
  it("is false for an empty / missing path entry", () => {
    expect(
      hasResolvableBacktickedToken(finding({ path: "src/missing.ts", headline: "`computeTotal`" }), diff()),
    ).toBe(false)
  })
})

describe("parseInlineGroundingValidatorMode", () => {
  it("returns 'enforce' only for the literal enforce (case/space-insensitive)", () => {
    expect(parseInlineGroundingValidatorMode("enforce")).toBe("enforce")
    expect(parseInlineGroundingValidatorMode("  ENFORCE  ")).toBe("enforce")
    expect(parseInlineGroundingValidatorMode("Enforce")).toBe("enforce")
  })
  it("defaults to 'shadow' for anything else (undefined, empty, shadow, off, garbage)", () => {
    expect(parseInlineGroundingValidatorMode(undefined)).toBe("shadow")
    expect(parseInlineGroundingValidatorMode("")).toBe("shadow")
    expect(parseInlineGroundingValidatorMode("shadow")).toBe("shadow")
    expect(parseInlineGroundingValidatorMode("off")).toBe("shadow")
    expect(parseInlineGroundingValidatorMode("enforced")).toBe("shadow")
  })
})

// ── Integration with validateForSubmission (shadow vs enforce wiring) ──

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeReviewable(path = PATH): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "logic", verdict: { findings: [{ id: "logic-0" }] } }] as unknown as SpecialistVerdictsArg
}
function prov(count = 1, sourceId = "logic-0"): SynthesizerProvenance {
  return {
    // One provenance entry per finding (the hallucination guard maps
    // synthOutput.verdict.findings to provenance.findings BY INDEX). All
    // point at the single valid source id so every finding survives the
    // guard and reaches the grounding gate.
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: ["logic"],
      sourceFindingIds: [sourceId],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}
// added-line text that contains NO token the ungrounded finding quotes.
const ADDED = new Map([[PATH, new Map([[17, "  const total = compute(items)"]])]])

// score-2 line-scoped finding with no grounding signal and no backticked
// token resolvable to ADDED — and NOT starting with a VAGUE_PREFIXES word
// (so it reaches the grounding gate rather than the vague-prefix filter).
function ungrounded(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return finding({
    score: 2,
    category: "style",
    headline: "naming is inconsistent here",
    body: "rename for clarity",
    ...overrides,
  })
}

function run(findings: PrReviewFinding[], opts: { mode?: "shadow" | "enforce"; onDrop?: (...a: unknown[]) => void } = {}) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
      provenance: prov(findings.length),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    addedLineTextByLine: ADDED,
    ...(opts.mode ? { inlineGroundingValidatorMode: opts.mode } : {}),
    ...(opts.onDrop ? { onInlineGroundingFindingDropped: opts.onDrop } : {}),
  })
}

describe("validateForSubmission — SIG-281 PR C inline-grounding gate", () => {
  it("ENFORCE: demotes an ungrounded score-2 finding to the body (counter++, callback dropped:true, leaves verdict.findings)", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded()], { mode: "enforce", onDrop })
    expect(result.droppedForFailedInlineGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline === "naming is inconsistent here")).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "ungrounded-inline-finding", dropped: true })
  })

  it("SHADOW: counts the would-demote + fires callback dropped:false but KEEPS the finding inline", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded()], { mode: "shadow", onDrop })
    expect(result.droppedForFailedInlineGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.unanchoredFindings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "ungrounded-inline-finding", dropped: false })
  })

  it("defaults to SHADOW when the mode is omitted", () => {
    const result = run([ungrounded()])
    expect(result.droppedForFailedInlineGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: KEEPS a grounded finding (backticked token on a changed line) inline — counter stays 0", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded({ headline: "rename `compute` for clarity" })], { mode: "enforce", onDrop })
    expect(result.droppedForFailedInlineGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("believability floor: ENFORCE never demotes a score-4 ungrounded finding (counter 0, callback not fired)", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded({ score: 4 })], { mode: "enforce", onDrop })
    expect(result.droppedForFailedInlineGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("score-1 regression: ENFORCE does NOT demote a score-1 nit to the body (the gate keeps it; the advisory path owns it) — gate counter 0", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded({ score: 1 })], { mode: "enforce", onDrop })
    // The grounding gate must not act on score<=1 (else it would surface a
    // score-1 nit in the body, bypassing the chill advisory suppression).
    expect(result.droppedForFailedInlineGroundingValidation).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
    // Under the default chill profile the score-1 nit is suppressed entirely
    // (advisory), so it appears in neither inline nor body.
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline === "naming is inconsistent here")).toBe(false)
  })

  it("SIG-245 line-1 reversal: a reviewable line-1 over-fire is STILL demoted by the grounding gate (not bypassed)", () => {
    // After the SIG-245 line-1 fix, an anchorable line-1 finding falls through
    // the line-1 guard to the inline path — but the inline-grounding gate runs
    // AFTER that guard, so a CONTENT over-fire on line 1 (ungrounded score-2)
    // must still be demoted to the body. Proves content truth is the gate's
    // job, not the line-number heuristic's, post-reversal.
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [ungrounded({ line: 1 })] },
        provenance: prov(1),
      },
      reviewable: new Map([[PATH, [{ line: 1, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      addedLineTextByLine: new Map([[PATH, new Map([[1, "  const total = compute(items)"]])]]),
      inlineGroundingValidatorMode: "enforce",
    })
    expect(result.verdict.findings).toHaveLength(0) // demoted by inline-grounding, NOT inlined at line 1
    expect(result.droppedForFailedInlineGroundingValidation).toBe(1)
    expect(result.unanchoredFindings.some((f) => f.line === 1)).toBe(true)
  })

  it("ENFORCE: processes a mixed grounded/ungrounded batch correctly (counter + callback reflect only the ungrounded)", () => {
    const onDrop = vi.fn()
    const findings = [
      ungrounded({ headline: "ungrounded nit one" }),
      ungrounded({ headline: "rename `compute` for clarity" }), // grounded — token on changed line
      ungrounded({ headline: "ungrounded nit two" }),
    ]
    const result = run(findings, { mode: "enforce", onDrop })
    expect(result.droppedForFailedInlineGroundingValidation).toBe(2)
    expect(result.verdict.findings).toHaveLength(1) // only the grounded one stays inline
    expect(result.verdict.findings[0]?.headline).toBe("rename `compute` for clarity")
    expect(result.unanchoredFindings).toHaveLength(2)
    expect(onDrop).toHaveBeenCalledTimes(2)
  })

  it("ordering: a vague-prefix finding is dropped BEFORE the grounding gate (gate counter 0)", () => {
    const onDrop = vi.fn()
    const result = run([ungrounded({ headline: "Consider renaming this" })], { mode: "enforce", onDrop })
    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.droppedForFailedInlineGroundingValidation).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
