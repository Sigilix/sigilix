// SIG-110: perf-finding evidence gate tests.
//
// Two layers (mirror tests/validate-logic-finding.test.ts):
//   1. evaluatePerfFinding pure unit tests — the FP-safe decision per
//      (finding shape, perf evidence). The structured complexityEstimate /
//      hotPathIdentifier fields are credited ONLY when they name real
//      changed code (the Codex + deepseek-v4-pro anti-boilerplate fix).
//   2. validateForSubmission integration — perf applicability via the
//      `performance-` sourceFindingId prefix + score>=4, shadow vs enforce,
//      the droppedForFailedPerfValidation counter + onPerfFindingDropped.

import { describe, it, expect, vi } from "vitest"
import {
  evaluatePerfFinding,
  parsePerfValidatorMode,
  type PerfEvidence,
} from "../src/lib/validate-perf-finding"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { AstFinding } from "@/features/ast-rules/domain/types"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "../src/lib/diff-positions"

const PATH = "src/lib/orders.ts"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 4,
    category: "performance",
    headline: "N+1 query awaiting `db.query` for each item in `rows`",
    body: "The loop over `rows` awaits a query per iteration; batch it instead.",
    complexityEstimate: "O(n): one round-trip per item in `rows`",
    ...overrides,
  }
}

function evidence(overrides: Partial<PerfEvidence> = {}): PerfEvidence {
  return {
    changedLineTextByPath: new Map([
      [PATH, ["  for (const r of rows) {", "    await db.query(r.id)"]],
    ]),
    astPerfFindings: [],
    ...overrides,
  }
}

function astHit(overrides: Partial<AstFinding> = {}): AstFinding {
  return {
    ruleId: "no-n-plus-one-call-in-loop",
    severity: "warning",
    roleHint: "performance",
    path: PATH,
    line: 17,
    column: 4,
    message: "awaited data-access call inside a loop (N+1)",
    evidence: "await db.query(r.id)",
    astFindingId: "ast/no-n-plus-one-call-in-loop/abc1234/17",
    ...overrides,
  }
}

describe("parsePerfValidatorMode", () => {
  it("defaults to shadow for unset / unknown values", () => {
    expect(parsePerfValidatorMode(undefined)).toBe("shadow")
    expect(parsePerfValidatorMode("")).toBe("shadow")
    expect(parsePerfValidatorMode("on")).toBe("shadow")
  })
  it("resolves enforce (case-insensitive, trimmed)", () => {
    expect(parsePerfValidatorMode("enforce")).toBe("enforce")
    expect(parsePerfValidatorMode("  ENFORCE  ")).toBe("enforce")
  })
})

describe("evaluatePerfFinding (pure FP-safe decision)", () => {
  it("passes any score < 4 perf finding untouched", () => {
    expect(evaluatePerfFinding(finding({ score: 3 }), evidence())).toEqual({ keep: true })
  })
  it("keeps when no evidence is wired (empty map + no AST findings)", () => {
    expect(evaluatePerfFinding(finding(), { changedLineTextByPath: new Map(), astPerfFindings: [] })).toEqual({ keep: true })
  })
  it("KEEPS a sev>=4 finding anchored by a concrete backticked token on a changed line", () => {
    // `rows` appears on a changed line; `db.query` too.
    expect(evaluatePerfFinding(finding({ complexityEstimate: undefined }), evidence())).toEqual({ keep: true })
  })
  it("KEEPS via a complexityEstimate that names a changed token", () => {
    const f = finding({ headline: "Slow loop", body: "This loop is slow.", complexityEstimate: "O(n^2) rebuilding `rows`" })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: true })
  })
  it("KEEPS via a hotPathIdentifier matching a changed token", () => {
    const f = finding({ headline: "Hot path", body: "Slow here.", complexityEstimate: undefined, hotPathIdentifier: "rows" })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: true })
  })
  it("KEEPS a finding corroborated by a co-located AST perf hit (even with empty changed text)", () => {
    const f = finding({ headline: "slow", body: "slow", complexityEstimate: undefined })
    expect(evaluatePerfFinding(f, { changedLineTextByPath: new Map(), astPerfFindings: [astHit({ line: 17 })] })).toEqual({ keep: true })
  })
  it("REJECTS a sev>=4 perf finding with no path (missing-path)", () => {
    expect(evaluatePerfFinding(finding({ path: "" }), evidence())).toEqual({ keep: false, reason: "missing-path" })
  })
  it("REJECTS a sev>=4 perf finding on a NON-changed path (path-not-changed)", () => {
    const f = finding({ path: "src/lib/other.ts" })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: false, reason: "path-not-changed" })
  })
  it("REJECTS a vague sev>=4 perf claim on a changed path with no concrete token / field / AST hit", () => {
    const f = finding({ headline: "Performance could be improved", body: "This area is slow and inefficient.", complexityEstimate: undefined })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: false, reason: "unanchored-perf-claim" })
  })
  it("does NOT anchor on a hotPathIdentifier of only generic/stopword tokens", () => {
    const f = finding({ headline: "slow", body: "slow", complexityEstimate: undefined, hotPathIdentifier: "GET /api" })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: false, reason: "unanchored-perf-claim" })
  })
  it("treats a whitespace-padded path as the same changed path for anchoring", () => {
    const f = finding({ path: `  ${PATH}  `, complexityEstimate: "O(n^2) over `rows`" })
    expect(evaluatePerfFinding(f, evidence())).toEqual({ keep: true })
  })
  it("REJECTS path-not-changed even when an AST hit sits on that same unchanged path (changed-path gate runs first)", () => {
    const other = "src/lib/other.ts"
    const f = finding({ path: other, headline: "slow", body: "slow", complexityEstimate: undefined })
    expect(evaluatePerfFinding(f, evidence({ astPerfFindings: [astHit({ path: other })] }))).toEqual({ keep: false, reason: "path-not-changed" })
  })
  it("does NOT match a co-located AST hit on a DIFFERENT path", () => {
    const f = finding({ headline: "slow", body: "slow", complexityEstimate: undefined })
    expect(evaluatePerfFinding(f, evidence({ astPerfFindings: [astHit({ path: "src/lib/other.ts" })] }))).toEqual({ keep: false, reason: "unanchored-perf-claim" })
  })
})

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(path = PATH): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "performance", verdict: { findings: [{ id: "performance-0" }] } }] as unknown as SpecialistVerdictsArg
}

function perfProvenance(sourceId = "performance-0"): SynthesizerProvenance {
  return {
    findings: [{ sourceSpecialists: ["performance"], sourceFindingIds: [sourceId], action: "kept", verifiedViaRetrieval: false }],
    dropped: [], softened: [],
  }
}

const vague = { headline: "Performance could be improved", body: "This area is slow.", complexityEstimate: undefined }

describe("validateForSubmission — SIG-110 perf evidence gate", () => {
  it("ENFORCE: drops a vague unanchored perf finding + increments counter + fires callback", () => {
    const onDrop = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding(vague)] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfEvidence: evidence(),
      perfValidatorMode: "enforce",
      onPerfFindingDropped: onDrop,
    })
    expect(result.droppedForFailedPerfValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "unanchored-perf-claim", dropped: true })
  })

  it("SHADOW: counts the would-drop + fires callback with dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding(vague)] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfEvidence: evidence(),
      perfValidatorMode: "shadow",
      onPerfFindingDropped: onDrop,
    })
    expect(result.droppedForFailedPerfValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "unanchored-perf-claim", dropped: false })
  })

  it("defaults to SHADOW when perfValidatorMode is omitted", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding(vague)] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfEvidence: evidence(),
    })
    expect(result.droppedForFailedPerfValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: keeps a concrete anchored perf finding (token on a changed line)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding()] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfEvidence: evidence(),
      perfValidatorMode: "enforce",
    })
    expect(result.droppedForFailedPerfValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("does NOT apply the gate to a score < 4 perf finding", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding({ score: 2, ...vague })] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfEvidence: evidence(),
      perfValidatorMode: "enforce",
    })
    expect(result.droppedForFailedPerfValidation).toBe(0)
  })

  it("does NOT apply the gate to a non-perf-sourced finding (logic-sourced untouched)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding({ ...vague, category: "logic" })] },
        provenance: {
          findings: [{ sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: [{ role: "logic", verdict: { findings: [{ id: "logic-0" }] } }] as unknown as SpecialistVerdictsArg,
      perfEvidence: evidence(),
      perfValidatorMode: "enforce",
    })
    expect(result.droppedForFailedPerfValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("no-ops when perfEvidence is not threaded (back-compat)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings: [finding(vague)] },
        provenance: perfProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      perfValidatorMode: "enforce",
    })
    expect(result.droppedForFailedPerfValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })
})
