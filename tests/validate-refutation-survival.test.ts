// SIG-325: generalized refutation-survival gate tests.
//
// Two layers (mirror tests/validate-security-finding.test.ts):
//   1. evaluateRefutationSurvival + parseRefutationSurvivalMode pure unit tests.
//   2. validateForSubmission integration — self-origination scoping (security
//      findings with no resolving manifest evidenceId), shadow vs enforce, the
//      droppedForFailedRefutationSurvival counter, demote-to-body FN-safety, and
//      the onRefutationSurvivalFindingDropped callback. The SIG-108 evidence
//      gate is kept out of the way by omitting `securityManifest` (its guard is
//      `if (securityManifest && ...)`), isolating the refutation gate.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateRefutationSurvival,
  parseRefutationSurvivalMode,
  REFUTATION_SURVIVAL_MIN_SEVERITY,
} from "../src/lib/validate-refutation-survival"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "../src/lib/diff-positions"
import type { PerfEvidence } from "../src/lib/validate-perf-finding"

// A self-originated security finding: a CWE claim with no manifest evidenceId.
// Defaults to the SSRF hallucination shape (sev>=4, no independentAssessment).
function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/parse/ndjson.ts",
    line: 17,
    score: 4,
    category: "security",
    headline: "SSRF via attacker-controlled Content-Type",
    body: "The decode path is driven by an attacker-controlled header.",
    cweId: "CWE-918",
    evidenceId: "NONE",
    ...overrides,
  }
}

describe("parseRefutationSurvivalMode", () => {
  it("parses the three states case- and whitespace-insensitively", () => {
    expect(parseRefutationSurvivalMode("shadow")).toBe("shadow")
    expect(parseRefutationSurvivalMode("  ENFORCE ")).toBe("enforce")
    expect(parseRefutationSurvivalMode("Off")).toBe("off")
  })

  it("falls back to off for unknown / missing values (cautious default)", () => {
    expect(parseRefutationSurvivalMode(undefined)).toBe("off")
    expect(parseRefutationSurvivalMode("")).toBe("off")
    expect(parseRefutationSurvivalMode("enabled")).toBe("off")
  })
})

describe("evaluateRefutationSurvival", () => {
  it("KEEPS a finding below the severity floor even with no rationale", () => {
    const r = evaluateRefutationSurvival(finding({ score: REFUTATION_SURVIVAL_MIN_SEVERITY - 1, independentAssessment: undefined }))
    expect(r.keep).toBe(true)
  })

  it("KEEPS a sev>=floor finding that carries a non-empty independentAssessment", () => {
    const r = evaluateRefutationSurvival(
      finding({ independentAssessment: "source=req.query.url → sink=fetch(url) → type=string; no allowlist." }),
    )
    expect(r.keep).toBe(true)
  })

  it("FLAGS a sev>=floor finding with a missing independentAssessment", () => {
    const r = evaluateRefutationSurvival(finding({ independentAssessment: undefined }))
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("refutation-survival-missing")
  })

  it("FLAGS a sev>=floor finding whose independentAssessment is whitespace-only", () => {
    const r = evaluateRefutationSurvival(finding({ independentAssessment: "   " }))
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("refutation-survival-missing")
  })
})

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(path = "src/parse/ndjson.ts"): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [
    { role: "security", verdict: { findings: [{ id: "security-0" }] } },
    { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
  ] as unknown as SpecialistVerdictsArg
}

function securityProvenance(sourceId = "security-0"): SynthesizerProvenance {
  return {
    findings: [
      { sourceSpecialists: ["security"], sourceFindingIds: [sourceId], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    softened: [],
  }
}

function run(args: {
  finding: PrReviewFinding
  mode: "off" | "shadow" | "enforce"
  onDrop?: (f: PrReviewFinding, info: { reason: string; dropped: boolean; lens: string }) => void
}) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [args.finding] },
      provenance: securityProvenance(),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    refutationSurvivalMode: args.mode,
    onRefutationSurvivalFindingDropped: args.onDrop,
    trustLedgerEnabled: true,
  })
}

describe("validateForSubmission — SIG-325 refutation-survival gate", () => {
  it("ENFORCE: DEMOTES a sev>=4 self-originated security finding lacking a rationale to the body + counter + callback", () => {
    const onDrop = vi.fn()
    const result = run({ finding: finding(), mode: "enforce", onDrop })

    expect(result.droppedForFailedRefutationSurvival).toBe(1)
    expect(result.verdict.findings).toHaveLength(0) // no longer inline
    expect(result.unanchoredFindings).toEqual([
      expect.objectContaining({
        path: "src/parse/ndjson.ts",
        category: "security",
        cweId: "CWE-918",
        trust: expect.objectContaining({ surface: "body", demoteReason: "refutation-survival" }),
      }),
    ])
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop.mock.calls[0]![1]).toEqual({
      reason: "refutation-survival-missing",
      dropped: true,
      lens: "security",
    })
  })

  it("SHADOW: KEEPS the finding inline but still counts + fires the callback with dropped:false", () => {
    const onDrop = vi.fn()
    const result = run({ finding: finding(), mode: "shadow", onDrop })

    expect(result.droppedForFailedRefutationSurvival).toBe(1)
    expect(result.verdict.findings).toHaveLength(1) // still inline
    expect(result.unanchoredFindings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ dropped: false, lens: "security" })
  })

  it("OFF: does not run — finding stays inline, counter stays 0, callback never fires", () => {
    const onDrop = vi.fn()
    const result = run({ finding: finding(), mode: "off", onDrop })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("does NOT flag a self-originated finding that DID carry a mechanism rationale", () => {
    const onDrop = vi.fn()
    const result = run({
      finding: finding({ independentAssessment: "source=req header → sink=fetch → type=string; no allowlist guard present." }),
      mode: "enforce",
      onDrop,
    })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("does NOT gate a TOOL-BACKED security finding (real evidenceId) — that's the SIG-108 gate's job", () => {
    const onDrop = vi.fn()
    const result = run({
      finding: finding({ evidenceId: "sarif:ssrf:abc123abc123:17", independentAssessment: undefined }),
      mode: "enforce",
      onDrop,
    })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("does NOT flag a self-originated finding below the severity floor", () => {
    const onDrop = vi.fn()
    const result = run({ finding: finding({ score: 3, independentAssessment: undefined }), mode: "enforce", onDrop })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })
})

// ── Performance lens (self-originated = no co-located AST hit) ────

function perfFinding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/parse/ndjson.ts",
    line: 17,
    score: 4,
    category: "performance",
    headline: "recomputes the HMAC key on every call",
    body: "No caching of the imported key on the hot path.",
    ...overrides,
  }
}

function makePerfSpecialistVerdicts(): SpecialistVerdictsArg {
  return [
    { role: "performance", verdict: { findings: [{ id: "performance-0" }] } },
    { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
  ] as unknown as SpecialistVerdictsArg
}

function perfProvenance(sourceId = "performance-0"): SynthesizerProvenance {
  return {
    findings: [
      { sourceSpecialists: ["performance"], sourceFindingIds: [sourceId], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    softened: [],
  }
}

function runPerf(args: {
  finding: PrReviewFinding
  mode: "off" | "shadow" | "enforce"
  astHit?: boolean
  onDrop?: (f: PrReviewFinding, info: { reason: string; dropped: boolean; lens: string }) => void
}) {
  const astPerfFindings = args.astHit
    ? ([{ path: "src/parse/ndjson.ts", line: 17, endLine: 17, roleHint: "performance" }] as unknown as PerfEvidence["astPerfFindings"])
    : []
  const perfEvidence: PerfEvidence = {
    changedLineTextByPath: new Map([["src/parse/ndjson.ts", ["const key = await importKey(secret)"]]]),
    astPerfFindings,
  }
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [args.finding] },
      provenance: perfProvenance(),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makePerfSpecialistVerdicts(),
    perfEvidence,
    refutationSurvivalMode: args.mode,
    onRefutationSurvivalFindingDropped: args.onDrop,
    trustLedgerEnabled: true,
  })
}

describe("validateForSubmission — SIG-325 refutation-survival gate (performance lens)", () => {
  it("ENFORCE: DEMOTES a sev>=4 self-originated (no-AST-hit) perf finding lacking a rationale + callback lens=performance", () => {
    const onDrop = vi.fn()
    const result = runPerf({ finding: perfFinding(), mode: "enforce", onDrop })

    expect(result.droppedForFailedRefutationSurvival).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings).toEqual([
      expect.objectContaining({
        category: "performance",
        trust: expect.objectContaining({ surface: "body", demoteReason: "refutation-survival" }),
      }),
    ])
    expect(onDrop.mock.calls[0]![1]).toEqual({ reason: "refutation-survival-missing", dropped: true, lens: "performance" })
  })

  it("does NOT flag a self-originated perf finding that carried a cost rationale", () => {
    const onDrop = vi.fn()
    const result = runPerf({
      finding: perfFinding({ independentAssessment: "Runs on every gate-middleware request; re-derives the WebCrypto key per call under load." }),
      mode: "enforce",
      onDrop,
    })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("does NOT gate a TOOL-BACKED perf finding (co-located AST hit) — that's the SIG-110 gate's job", () => {
    const onDrop = vi.fn()
    const result = runPerf({
      finding: perfFinding({ independentAssessment: undefined }),
      mode: "enforce",
      astHit: true,
      onDrop,
    })

    expect(result.droppedForFailedRefutationSurvival).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
