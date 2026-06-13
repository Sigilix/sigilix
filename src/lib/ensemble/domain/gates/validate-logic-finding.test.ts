// SIG-109: logic-finding evidence gate tests.
//
// Two layers (mirror tests/validate-test-finding.test.ts):
//   1. evaluateLogicFinding pure unit tests — the FP-safe decision per
//      (finding shape, logic evidence). False-negative-sensitive: most
//      cases assert KEEP; only the unanchored / missing-path shapes drop.
//   2. validateForSubmission integration — logic applicability via the
//      `logic-` sourceFindingId prefix + score>=4, shadow vs enforce, the
//      droppedForFailedLogicValidation counter, and the
//      onLogicFindingDropped callback.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateLogicFinding,
  parseLogicValidatorMode,
  buildChangedLineTextByPath,
  type LogicEvidence,
} from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { AstFinding } from "@/src/features/ast-rules/domain/types"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

const PATH = "src/lib/scan.ts"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 4,
    category: "logic",
    headline: "`<= arr.length` reads one past the end of `arr`",
    body: "The loop guard uses `<=`, so the final iteration accesses `arr[arr.length]`.",
    ...overrides,
  }
}

function evidence(overrides: Partial<LogicEvidence> = {}): LogicEvidence {
  return {
    changedLineTextByPath: new Map([[PATH, ["  for (let i = 0; i <= arr.length; i++) {", "    total += arr[i]"]]]),
    astLogicFindings: [],
    ...overrides,
  }
}

function astHit(overrides: Partial<AstFinding> = {}): AstFinding {
  return {
    ruleId: "no-unsafe-negation",
    severity: "warning",
    roleHint: "logic",
    path: PATH,
    line: 17,
    column: 4,
    message: "unsafe negation",
    evidence: "!key in allowed",
    astFindingId: "ast/no-unsafe-negation/abc1234/17",
    ...overrides,
  }
}

describe("parseLogicValidatorMode", () => {
  it("defaults to shadow for unset / unknown values", () => {
    expect(parseLogicValidatorMode(undefined)).toBe("shadow")
    expect(parseLogicValidatorMode("")).toBe("shadow")
    expect(parseLogicValidatorMode("on")).toBe("shadow")
  })
  it("resolves enforce (case-insensitive, trimmed)", () => {
    expect(parseLogicValidatorMode("enforce")).toBe("enforce")
    expect(parseLogicValidatorMode("  ENFORCE  ")).toBe("enforce")
  })
})

describe("buildChangedLineTextByPath", () => {
  it("collects BOTH added (+) and removed (-) content, stripping the leading sign", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1",
      "+const y = 2",
      "-const z = 3",
      "+const w = 4",
    ].join("\n")
    const m = buildChangedLineTextByPath(diff)
    // Removed lines included (Codex review): a finding about deleted code
    // must be able to anchor on a token from the removed line.
    expect(m.get("src/a.ts")).toEqual(["const y = 2", "const z = 3", "const w = 4"])
  })

  it("treats a `++ `-prefixed content line as content, not a +++ header (hunk-tracked)", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "++ nested diff marker in code",
    ].join("\n")
    // Inside the hunk, `++ ...` is an added line whose content starts
    // `+ ...`; it must NOT corrupt currentPath.
    expect(buildChangedLineTextByPath(diff).get("src/a.ts")).toEqual(["+ nested diff marker in code"])
  })

  it("does NOT capture the +++ header line as content", () => {
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "+++ b/src/a.ts", "@@ -0,0 +1 @@", "+added"].join("\n")
    expect(buildChangedLineTextByPath(diff).get("src/a.ts")).toEqual(["added"])
  })

  it("skips deleted files (/dev/null new side)", () => {
    const diff = ["diff --git a/src/gone.ts b/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-const x = 1"].join("\n")
    expect(buildChangedLineTextByPath(diff).size).toBe(0)
  })

  it("returns an empty map for a non-string input", () => {
    expect(buildChangedLineTextByPath(undefined as unknown as string).size).toBe(0)
  })
})

describe("evaluateLogicFinding (pure FP-safe decision)", () => {
  it("passes any score < 4 logic finding untouched (evidence bar is sev>=4 only)", () => {
    expect(evaluateLogicFinding(finding({ score: 3 }), evidence()).keep).toBe(true)
  })

  it("keeps when no evidence is wired (empty map + no AST findings)", () => {
    const empty: LogicEvidence = { changedLineTextByPath: new Map(), astLogicFindings: [] }
    expect(evaluateLogicFinding(finding(), empty).keep).toBe(true)
  })

  // ── KEEP paths (the FP-safe crux) ─────────────────────────────────
  it("KEEPS a sev>=4 finding anchored by a concrete backticked token on an added line", () => {
    // `arr.length` and `<=` both appear in the added-line text.
    expect(evaluateLogicFinding(finding(), evidence()).keep).toBe(true)
  })

  it("KEEPS a sev>=4 finding corroborated by a co-located AST hit even with no quotable token", () => {
    const r = evaluateLogicFinding(
      finding({
        headline: "Negation binds before the membership test",
        body: "This negates the left operand before the in-check.",
        line: 19,
      }),
      // No token match (the body quotes nothing on the added lines), but
      // an AST hit at line 17 is within +/-5 of the finding's line 19.
      evidence({ astLogicFindings: [astHit({ line: 17 })] }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS an AST-corroborated finding even when changedLineTextByPath is EMPTY (AST-only caller)", () => {
    // CodeRabbit: an AST-only evidence caller (no diff text wired) must
    // NOT hard-drop as path-not-changed when a co-located AST hit exists.
    const r = evaluateLogicFinding(finding({ headline: "vague", body: "vague", line: 17 }), {
      changedLineTextByPath: new Map(),
      astLogicFindings: [astHit({ line: 17 })],
    })
    expect(r.keep).toBe(true)
  })

  it("KEEPS a finding anchored by a multi-token backticked expression on an added line", () => {
    const r = evaluateLogicFinding(
      finding({
        headline: "`arr[i]` read out of bounds",
        body: "Indexing `arr[i]` overruns the array.",
      }),
      evidence(),
    )
    expect(r.keep).toBe(true)
  })

  // ── REJECT paths ──────────────────────────────────────────────────
  it("REJECTS a sev>=4 logic finding with no path (missing-path)", () => {
    const r = evaluateLogicFinding(finding({ path: "" }), evidence())
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("missing-path")
  })

  it("REJECTS a sev>=4 logic finding on a NON-changed path (path-not-changed)", () => {
    const r = evaluateLogicFinding(finding({ path: "src/lib/legacy.ts" }), evidence())
    expect(r.keep).toBe(false)
    // Distinct reason (review) so shadow telemetry separates cross-file
    // findings from vague claims before enforce.
    if (!r.keep) expect(r.reason).toBe("path-not-changed")
  })

  it("REJECTS a sev>=4 vague claim on a changed path with no concrete token + no AST hit", () => {
    const r = evaluateLogicFinding(
      finding({
        headline: "This change could introduce subtle bugs",
        body: "The refactor here is risky and might break edge cases.",
      }),
      evidence(),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("unanchored-logic-claim")
  })

  it("REJECTS when the backticked token does NOT appear on any added line (no real anchor)", () => {
    const r = evaluateLogicFinding(
      finding({
        headline: "`computeTaxTier` is wrong",
        body: "The `computeTaxTier` rounding is off.",
      }),
      // The added lines mention arr/total, not computeTaxTier.
      evidence(),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("unanchored-logic-claim")
  })

  it("does NOT anchor on a 1-char backticked token (too noisy)", () => {
    const r = evaluateLogicFinding(
      finding({ headline: "`i` is wrong", body: "The variable `i` is misused." }),
      evidence({ changedLineTextByPath: new Map([[PATH, ["  i = i"]]]) }),
    )
    expect(r.keep).toBe(false)
  })

  it("does NOT anchor on a pure-punctuation backticked token (M4: `==`)", () => {
    // An operator is not a concrete anchor (it appears on almost any
    // line). Only identifier-bearing tokens count (review M4). Here the
    // ONLY backticked tokens are operators, so there's no real anchor.
    const r = evaluateLogicFinding(
      finding({ headline: "the `==` is loose", body: "should be `===` here" }),
      evidence({ changedLineTextByPath: new Map([[PATH, ["  if (a == b) {}"]]]) }),
    )
    expect(r.keep).toBe(false)
  })

  it("does NOT anchor on a numeric-only backticked token (CodeRabbit: `10` is not an identifier)", () => {
    const r = evaluateLogicFinding(
      finding({ headline: "magic number", body: "the literal `10` should be a constant" }),
      evidence({ changedLineTextByPath: new Map([[PATH, ["  const limit = 10"]]]) }),
    )
    expect(r.keep).toBe(false)
  })

  it("does NOT match a co-located AST hit on a DIFFERENT path", () => {
    const r = evaluateLogicFinding(
      finding({ headline: "vague", body: "vague claim" }),
      evidence({ astLogicFindings: [astHit({ path: "src/lib/other.ts" })] }),
    )
    expect(r.keep).toBe(false)
  })

  it("does NOT match a co-located AST hit too many lines away", () => {
    const r = evaluateLogicFinding(
      finding({ headline: "vague", body: "vague claim", line: 100 }),
      evidence({ astLogicFindings: [astHit({ line: 17, endLine: 17 })] }),
    )
    expect(r.keep).toBe(false)
  })
})

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(path = PATH, line = 17): ReviewableMap {
  return new Map([[path, [{ line, side: "RIGHT" as const, position: 1 }]]])
}

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "logic", verdict: { findings: [{ id: "logic-0" }] } }] as unknown as SpecialistVerdictsArg
}

function logicProvenance(sourceId = "logic-0"): SynthesizerProvenance {
  return {
    findings: [
      {
        sourceSpecialists: ["logic"],
        sourceFindingIds: [sourceId],
        action: "kept",
        verifiedViaRetrieval: false,
      },
    ],
    dropped: [],
    softened: [],
  }
}

describe("validateForSubmission — SIG-109 logic evidence gate", () => {
  it("ENFORCE: drops a vague unanchored logic finding + increments counter + fires callback", () => {
    const onDrop = vi.fn()
    const f = finding({
      headline: "This change could introduce subtle bugs",
      body: "The refactor here is risky and might break edge cases.",
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicEvidence: evidence(),
      logicValidatorMode: "enforce",
      onLogicFindingDropped: onDrop,
    })
    expect(result.droppedForFailedLogicValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "unanchored-logic-claim",
      dropped: true,
    })
  })

  it("SHADOW: counts the would-drop + fires callback with dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const f = finding({
      headline: "This change could introduce subtle bugs",
      body: "The refactor here is risky and might break edge cases.",
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicEvidence: evidence(),
      logicValidatorMode: "shadow",
      onLogicFindingDropped: onDrop,
    })
    expect(result.droppedForFailedLogicValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1) // NOT dropped in shadow
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "unanchored-logic-claim",
      dropped: false,
    })
  })

  it("defaults to SHADOW when logicValidatorMode is omitted", () => {
    const f = finding({
      headline: "This change could introduce subtle bugs",
      body: "The refactor here is risky and might break edge cases.",
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicEvidence: evidence(),
    })
    expect(result.droppedForFailedLogicValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: keeps a concrete anchored logic finding (token on an added line)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicEvidence: evidence(),
      logicValidatorMode: "enforce",
    })
    expect(result.droppedForFailedLogicValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("does NOT apply the gate to a score < 4 logic finding", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ score: 2, headline: "vague", body: "vague" })],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicEvidence: evidence(),
      logicValidatorMode: "enforce",
    })
    // score 2 → demoted to advisory, not dropped by the logic gate.
    expect(result.droppedForFailedLogicValidation).toBe(0)
  })

  it("does NOT apply the gate to a non-logic-sourced finding (security-sourced untouched)", () => {
    const f = finding({ headline: "vague", body: "vague claim", category: "security" })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["security"],
              sourceFindingIds: ["security-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
          softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: [
        { role: "security", verdict: { findings: [{ id: "security-0" }] } },
      ] as unknown as SpecialistVerdictsArg,
      logicEvidence: evidence(),
      logicValidatorMode: "enforce",
    })
    expect(result.droppedForFailedLogicValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("no-ops when logicEvidence is not threaded (back-compat)", () => {
    const f = finding({ headline: "vague", body: "vague claim" })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicValidatorMode: "enforce",
    })
    expect(result.droppedForFailedLogicValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })
})

describe("validateForSubmission — SIG-308 logic-refutation backstop", () => {
  // The default `finding()` is a sev-4 logic finding with no
  // `independentAssessment` — the shape the backstop flags. logicEvidence is
  // omitted so the SIG-109 gate no-ops and this gate is exercised in isolation.
  it("ENFORCE: drops a sev>=4 logic finding lacking a survival rationale + counts + fires callback", () => {
    const onFlag = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicRefutationMode: "enforce",
      onLogicRefutationFindingDropped: onFlag,
    })
    expect(result.droppedForFailedLogicRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), {
      reason: "logic-finding-missing-refutation-survival",
      dropped: true,
    })
  })

  it("SHADOW: counts the would-flag + fires callback dropped:false but KEEPS the finding", () => {
    const onFlag = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicRefutationMode: "shadow",
      onLogicRefutationFindingDropped: onFlag,
    })
    expect(result.droppedForFailedLogicRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1) // NOT dropped in shadow
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), {
      reason: "logic-finding-missing-refutation-survival",
      dropped: false,
    })
  })

  it("KEEPS a sev>=4 logic finding that carries a survival rationale, even in enforce", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              independentAssessment: "No bound on `i`; the loop runs to arr.length inclusive with no guard.",
            }),
          ],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicRefutationMode: "enforce",
    })
    expect(result.droppedForFailedLogicRefutation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("defaults to OFF when logicRefutationMode is omitted (gate does not run)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
    })
    expect(result.droppedForFailedLogicRefutation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  // PR #290 review (fix C): the backstop reads the POST-synthesis finding. When
  // synthesis drops the specialist's `independentAssessment`, the deterministic
  // backfill restores it from the source finding BEFORE the gate runs, so a
  // genuinely-justified logic finding is not wrongly flagged.
  it("ENFORCE: backfills independentAssessment from the source finding when synthesis dropped it", () => {
    const sourceWithRationale = [
      {
        role: "logic",
        verdict: {
          findings: [
            {
              id: "logic-0",
              independentAssessment: "No bound on `i`; the loop runs to arr.length inclusive with no guard.",
            },
          ],
        },
      },
    ] as unknown as SpecialistVerdictsArg
    const result = validateForSubmission({
      synthOutput: {
        // synthesized finding LACKS independentAssessment (synthesis dropped it)
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: logicProvenance("logic-0"),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: sourceWithRationale,
      logicRefutationMode: "enforce",
    })
    expect(result.droppedForFailedLogicRefutation).toBe(0) // backfilled → survives refutation
    expect(result.verdict.findings).toHaveLength(1)
  })

  // PR #290 review (CodeRabbit, Major): independentAssessment is a shared field
  // (SIG-282 security confirmation vs SIG-308 logic survival rationale). For a
  // cross-lens-merged finding, a SECURITY note must NOT satisfy the logic gate.
  // The rationale map is role-scoped to "logic", so only a logic source's
  // rationale can backfill — here the logic source has none, so it stays flagged.
  it("ENFORCE: a co-merged security independentAssessment does NOT satisfy the logic gate", () => {
    const crossLensSources = [
      {
        role: "security",
        verdict: {
          findings: [
            {
              id: "security-0",
              independentAssessment: "Passed to the Stripe client as the secret key — confirms credential use.",
            },
          ],
        },
      },
      { role: "logic", verdict: { findings: [{ id: "logic-0" }] } }, // no survival rationale
    ] as unknown as SpecialistVerdictsArg
    const crossLensProvenance: SynthesizerProvenance = {
      findings: [
        {
          sourceSpecialists: ["security", "logic"],
          sourceFindingIds: ["security-0", "logic-0"],
          action: "merged",
          verifiedViaRetrieval: false,
        },
      ],
      dropped: [],
      softened: [],
    }
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding()],
        },
        provenance: crossLensProvenance,
      },
      reviewable: makeReviewable(),
      specialistVerdicts: crossLensSources,
      logicRefutationMode: "enforce",
    })
    expect(result.droppedForFailedLogicRefutation).toBe(1) // security note must not backfill the logic gate
    expect(result.verdict.findings).toHaveLength(0)
  })
})

describe("validateForSubmission — SIG-328 logic-claim refutation gate", () => {
  const AUTH_PATH = "src/middleware/auth.ts"
  const AUTH_SOURCE = `export function requireAdmin(svc) {
  return async (req, res, next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
  const refutableFinding = finding({
    path: AUTH_PATH,
    line: 6,
    headline: "`next()` runs after 403 response, causing a double-response error",
    body: "When `svc.isAdmin(req.user)` returns false, the middleware sends `res.status(403).end()` and then calls `next()`.",
  })
  const FILTER_PATH = "src/search/filter.ts"
  const FILTER_SOURCE = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  return rows.filter((r) => r.name.includes(needle))
}`
  const regexSubstringFinding = finding({
    path: FILTER_PATH,
    line: 3,
    score: 5,
    headline: "User-controlled regex can cause ReDoS",
    body: "`needle` is compiled into a regular expression, but the cited filter uses includes.",
  })

  it("ENFORCE: drops a provably-refuted logic claim + counts + fires callback", () => {
    const onFlag = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [refutableFinding],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(AUTH_PATH, 6),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicClaimRefutationMode: "enforce",
      fullFileByPath: new Map([[AUTH_PATH, AUTH_SOURCE]]),
      onLogicClaimRefutationFindingDropped: onFlag,
    })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), {
      reason: "control-flow-claim-refuted-by-guard",
      dropped: true,
    })
  })

  it("ENFORCE: drops a regex/ReDoS claim refuted by an exact literal substring statement", () => {
    const onFlag = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [regexSubstringFinding],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(FILTER_PATH, 3),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicClaimRefutationMode: "enforce",
      fullFileByPath: new Map([[FILTER_PATH, FILTER_SOURCE]]),
      onLogicClaimRefutationFindingDropped: onFlag,
    })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), {
      reason: "regex-substring-claim-refuted-by-literal-string-filter",
      dropped: true,
    })
  })

  it("SHADOW: counts the would-drop + fires callback dropped:false but KEEPS the finding", () => {
    const onFlag = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [refutableFinding],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(AUTH_PATH, 6),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicClaimRefutationMode: "shadow",
      fullFileByPath: new Map([[AUTH_PATH, AUTH_SOURCE]]),
      onLogicClaimRefutationFindingDropped: onFlag,
    })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), {
      reason: "control-flow-claim-refuted-by-guard",
      dropped: false,
    })
  })

  it("defaults to OFF when logicClaimRefutationMode is omitted (gate does not run)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [refutableFinding],
        },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(AUTH_PATH, 6),
      specialistVerdicts: makeSpecialistVerdicts(),
      fullFileByPath: new Map([[AUTH_PATH, AUTH_SOURCE]]),
    })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  // SIG-392: the balance-sign shape + reason-scoped enforce allowlist.
  const BAL_PATH = "server/payments.ts"
  const BAL_SOURCE = `export function balance(amountCents, paidCents, refundedCents) {
  const outstandingCents = amountCents - paidCents + refundedCents
  return outstandingCents
}`
  const balanceFpFinding = finding({
    path: BAL_PATH,
    line: 2,
    headline: "outstandingCents formula is wrong: refunds should reduce the balance, not increase it",
    body: "The outstanding balance adds the refund; it should subtract it.",
  })
  const BAL_REASON = "balance-sign-claim-refuted-by-correct-accounting-direction"

  function runBalance(args: {
    mode: "shadow" | "enforce"
    enforceReasons?: ReadonlySet<string>
    onFlag: ReturnType<typeof vi.fn>
  }) {
    return validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [balanceFpFinding] },
        provenance: logicProvenance(),
      },
      reviewable: makeReviewable(BAL_PATH, 2),
      specialistVerdicts: makeSpecialistVerdicts(),
      logicClaimRefutationMode: args.mode,
      logicClaimRefutationEnforceReasons: args.enforceReasons as never,
      fullFileByPath: new Map([[BAL_PATH, BAL_SOURCE]]),
      onLogicClaimRefutationFindingDropped: args.onFlag,
    })
  }

  it("SHADOW: the balance-sign FP is flagged (dropped:false) but KEPT", () => {
    const onFlag = vi.fn()
    const result = runBalance({ mode: "shadow", onFlag })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), { reason: BAL_REASON, dropped: false })
  })

  it("ENFORCE + reason allowlisted: drops the balance-sign FP", () => {
    const onFlag = vi.fn()
    const result = runBalance({ mode: "enforce", enforceReasons: new Set([BAL_REASON]), onFlag })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), { reason: BAL_REASON, dropped: true })
  })

  it("ENFORCE + reason NOT allowlisted: KEEPS the FP (reason-scoping gates the drop)", () => {
    const onFlag = vi.fn()
    const result = runBalance({
      mode: "enforce",
      enforceReasons: new Set(["control-flow-claim-refuted-by-guard"]),
      onFlag,
    })
    expect(result.droppedForFailedLogicClaimRefutation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onFlag).toHaveBeenCalledWith(expect.anything(), { reason: BAL_REASON, dropped: false })
  })
})
