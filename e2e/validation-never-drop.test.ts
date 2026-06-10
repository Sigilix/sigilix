// SIG-360 (PR 8, commit 1): the recall-safety CONSERVATION property for
// `validateForSubmission`. A real P0/P1 (score 4-5) must NEVER vanish without
// a recorded gate decision — i.e. a finding never silently disappears.
//
// "The output" of vFS, mapped onto the real `ValidatedOutput` fields:
//   - INLINE / submission set  → `result.verdict.findings`
//   - BODY-DEMOTED set         → `result.unanchoredFindings`
// A finding is CONSERVED iff it appears in either set. (Other ValidatedOutput
// fields are counters/provenance, not finding containers.)
//
// VERIFIED behavior split (this is the recall-safety contract being pinned):
// the 13 gates fall into two classes when they FIRE in enforce on a P0/P1 —
//
//   DEMOTE-class (8): the finding leaves the inline set but is conserved in
//     `unanchoredFindings` (body) — security-evidence (SIG-108),
//     tests-specificity (SIG-111), refutation-survival (SIG-325),
//     inline-grounding (SIG-281), absence-grounding (SIG-290),
//     window-blindness, security-grounding (SIG-293), security-usage (SIG-311).
//
//   HARD-DROP-class (5): the gate's verdict is that the finding is a
//     hallucination (vague/unanchored/provably-refuted/uncited), so it is
//     removed entirely with a recorded drop counter — logic-evidence
//     (SIG-109), logic-refutation (SIG-308), logic-claim-refutation (SIG-328),
//     perf-evidence (SIG-110), testing-citation (SIG-113). The per-gate tests
//     (e.g. validate-perf-finding.test.ts:165, validate-logic-finding.test.ts)
//     pin this hard drop directly; the golden matrix pins the exact counters.
//
// The CONSERVATION INVARIANT therefore is: a P0/P1 input finding is either
// (a) conserved (inline or body) when NO gate hard-dropped it, OR (b) removed
// by a HARD-DROP-class gate that recorded the drop in its counter. There is no
// third case where a P0/P1 vanishes with no recorded decision — that is the
// recall-safety property. NEVER-DROP failures would mean a real bug got buried
// silently. Each matrix case fires at most one gate, so we read the relevant
// drop counter per case.
//
// We run this over EVERY matrix case (imported) plus dedicated fail-closed
// scenarios (a gate given UNDECIDABLE / missing evidence keeps the finding)
// sourced from the existing per-gate tests' "keep" cases.

import { describe, it, expect } from "vitest"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "@/src/lib/diff-positions"
import { MATRIX_CASES, severityTierForScore } from "./_golden/validation-matrix-cases"

type ValidatedOut = ReturnType<typeof validateForSubmission>

/** The two finding containers in ValidatedOutput a P0/P1 may legitimately land in. */
function conservedHeadlines(out: ValidatedOut): Set<string> {
  const set = new Set<string>()
  for (const f of out.verdict.findings) set.add(f.headline)
  for (const f of out.unanchoredFindings) set.add(f.headline)
  return set
}

/** The P0/P1 input headlines that must be conserved (P0 >= 5, P1 === 4). */
function p0p1InputHeadlines(findings: readonly PrReviewFinding[]): string[] {
  return findings
    .filter((f) => severityTierForScore(f.score) === "P0" || severityTierForScore(f.score) === "P1")
    .map((f) => f.headline)
}

/** The sum of every HARD-DROP-class gate counter — a P0/P1 may legitimately
 *  leave both finding containers ONLY when one of these recorded a drop.
 *  CAVEAT: this is a per-OUTPUT total, not per-finding — it is airtight only
 *  while each case carries at most one P0/P1 (true today, see header). If a
 *  future case has N>1 P0/P1s, bind the counter delta to the specific vanished
 *  finding (or assert hardDropTotal >= number-vanished) to avoid masking. */
function hardDropTotal(out: ValidatedOut): number {
  return (
    out.droppedForFailedLogicValidation +
    out.droppedForFailedLogicRefutation +
    out.droppedForFailedLogicClaimRefutation +
    out.droppedForFailedPerfValidation +
    out.droppedForUncitedTestingEvidence +
    // The pre-gate hallucination guard also legitimately removes a finding with
    // a recorded count (invalid provenance) — never silent.
    out.droppedForHallucination +
    out.droppedForVaguePrefix
  )
}

describe("validateForSubmission — never-drop conservation over the full matrix", () => {
  it.each(MATRIX_CASES.map((c) => ({ id: c.id, gate: c.gate, c })))(
    "[$gate] $id — every P0/P1 input finding is conserved or hard-dropped WITH a recorded decision",
    ({ c }) => {
      const args = c.buildArgs()
      // Callbacks are pure telemetry — they never affect the returned value
      // (ensemble-golden-capture decodes them to no-op stubs for the same
      // reason), so we run without wiring them.
      const out = validateForSubmission(args as Parameters<typeof validateForSubmission>[0])
      const surviving = conservedHeadlines(out)
      const inputs = args.synthOutput.verdict.findings as PrReviewFinding[]
      const p0p1 = p0p1InputHeadlines(inputs)
      for (const headline of p0p1) {
        if (surviving.has(headline)) continue
        // Not in either container → it MUST have been removed by a hard-drop
        // gate that recorded the decision (never a silent disappearance).
        expect(
          hardDropTotal(out),
          `P0/P1 finding "${headline}" vanished with NO recorded gate decision in case "${c.id}" — recall-safety violation`,
        ).toBeGreaterThan(0)
      }
    },
  )

  it("a P0/P1 finding that NO gate flags is ALWAYS conserved inline (the strict floor)", () => {
    // Every matrix case whose enforce/shadow run records ZERO drops of ANY kind
    // must keep all its P0/P1 findings inline — proves the gates only ever act
    // with a recorded decision.
    for (const c of MATRIX_CASES) {
      const args = c.buildArgs()
      const out = validateForSubmission(args as Parameters<typeof validateForSubmission>[0])
      const totalRemovals =
        hardDropTotal(out) +
        out.droppedForFailedValidation +
        out.droppedForFailedTestValidation +
        out.droppedForFailedRefutationSurvival +
        out.droppedForFailedInlineGroundingValidation +
        out.droppedForFailedAbsenceGroundingValidation +
        out.droppedForFailedWindowBlindnessValidation +
        out.droppedForFailedSecurityGroundingValidation +
        out.droppedForFailedSecurityUsageValidation +
        out.demotedScore1
      if (totalRemovals !== 0) continue
      const inline = new Set(out.verdict.findings.map((f) => f.headline))
      const inputs = args.synthOutput.verdict.findings as PrReviewFinding[]
      for (const headline of p0p1InputHeadlines(inputs)) {
        expect(
          inline.has(headline),
          `P0/P1 finding "${headline}" left the inline set with NO recorded removal in case "${c.id}"`,
        ).toBe(true)
      }
    }
  })
})

// ── Dedicated fail-closed scenarios (UNDECIDABLE evidence keeps the finding) ──
// Each is the smallest "keep" arrangement from the matching per-gate test where
// a gate runs in ENFORCE but the evidence is undecidable, so the finding must
// survive inline. These are intentionally redundant with the matrix neutral
// cases but pin the fail-OPEN contract per-gate, in isolation.

const PATH = "src/lib/x.ts"
function reviewableAt(line = 17, path = PATH): ReviewableMap {
  return new Map([[path, [{ line, side: "RIGHT" as const, position: 1 }]]])
}
function provFor(role: "logic" | "security" | "performance" | "tests", id: string): SynthesizerProvenance {
  return {
    findings: [{ sourceSpecialists: [role], sourceFindingIds: [id], action: "kept", verifiedViaRetrieval: false }],
    dropped: [],
    softened: [],
  }
}
type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]
function specialistsFor(role: "logic" | "security" | "performance" | "tests", id: string): SpecialistVerdictsArg {
  return [{ role, verdict: { findings: [{ id }] } }] as unknown as SpecialistVerdictsArg
}
function synth(f: PrReviewFinding, provenance: SynthesizerProvenance): Parameters<typeof validateForSubmission>[0]["synthOutput"] {
  return { verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [f] }, provenance }
}

describe("validateForSubmission — fail-closed: an UNDECIDABLE gate keeps the finding inline", () => {
  it("security (SIG-108) enforce: no manifest threaded → gate no-ops, sev-4 finding kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 4, category: "security",
      headline: "SQL injection in query builder",
      body: "User input is concatenated directly into the SQL string.",
      cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("security", "security-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("security", "security-0"),
      // securityManifest intentionally omitted → the gate's `if (manifest && …)`
      // guard short-circuits, so it cannot decide → keep.
      securityValidatorMode: "enforce",
    })
    expect(out.droppedForFailedValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("logic evidence (SIG-109) enforce: no logicEvidence threaded → gate no-ops, sev-4 finding kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 4, category: "logic",
      headline: "vague claim with no anchor", body: "risky refactor",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("logic", "logic-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("logic", "logic-0"),
      // logicEvidence omitted → back-compat no-op.
      logicValidatorMode: "enforce",
    })
    expect(out.droppedForFailedLogicValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("perf evidence (SIG-110) enforce: no perfEvidence threaded → gate no-ops, sev-4 finding kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 4, category: "performance",
      headline: "Performance could be improved", body: "This area is slow.",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("performance", "performance-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("performance", "performance-0"),
      // perfEvidence omitted → back-compat no-op.
      perfValidatorMode: "enforce",
    })
    expect(out.droppedForFailedPerfValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("security-grounding (SIG-293) enforce: no diff wired → UNKNOWN → kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 3, category: "security", cweId: "CWE-798",
      headline: "secret leaked via `payload`", body: "Looks like a credential is logged.",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("security", "security-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("security", "security-0"),
      // addedLineTextByLine omitted → cited line unresolvable → UNKNOWN → keep.
      securityGroundingValidatorMode: "enforce",
    })
    expect(out.droppedForFailedSecurityGroundingValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("absence-grounding (SIG-290) enforce: path NOT dropped → UNKNOWN → kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 4, category: "security",
      headline: "no null check on `userInput` before deref", body: "A null `userInput` would throw.",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("security", "security-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("security", "security-0"),
      addedLineTextByLine: new Map([[PATH, new Map([[17, "  return userInput.value"]])]]),
      absenceClaimValidatorMode: "enforce",
      droppedPaths: [], // the cited path was NOT dropped → can't prove ungrounded → keep
    })
    expect(out.droppedForFailedAbsenceGroundingValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("window-blindness enforce: no full file for the path → can't prove out-of-window → kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 5, category: "logic",
      headline: "`amount` can be NaN", body: "computeFee(amount) returns NaN; no finite check guards it.",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("logic", "logic-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("logic", "logic-0"),
      // fullFileByPath omitted → the gate can't reconstruct a guard → keep.
      windowBlindnessValidatorMode: "enforce",
    })
    expect(out.droppedForFailedWindowBlindnessValidation).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })

  it("refutation-survival (SIG-325) enforce: finding carries a survival rationale → kept inline", () => {
    const f: PrReviewFinding = {
      path: PATH, line: 17, score: 4, category: "security", cweId: "CWE-918", evidenceId: "NONE",
      headline: "SSRF via attacker-controlled Content-Type",
      body: "The decode path is driven by an attacker-controlled header.",
      independentAssessment: "source=req.query.url -> sink=fetch(url) -> type=string; no allowlist.",
    }
    const out = validateForSubmission({
      synthOutput: synth(f, provFor("security", "security-0")),
      reviewable: reviewableAt(),
      specialistVerdicts: specialistsFor("security", "security-0"),
      refutationSurvivalMode: "enforce",
    })
    expect(out.droppedForFailedRefutationSurvival).toBe(0)
    expect(out.verdict.findings).toHaveLength(1)
  })
})
