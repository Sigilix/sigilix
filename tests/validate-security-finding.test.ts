// SIG-108: security-finding evidence gate tests.
//
// Two layers (mirror tests/validate-testing-finding-citation.test.ts):
//   1. evaluateSecurityFinding pure unit tests — the FP-safe decision
//      per (finding shape, manifest).
//   2. validateForSubmission integration — security applicability via
//      provenance, shadow vs enforce, the droppedForFailedValidation
//      counter, and the onSecurityFindingDropped callback.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateSecurityFinding,
  evaluateScanFactDismissal,
  isDismissibleFact,
  remediationForFinding,
  REMEDIATION_BY_BUCKET,
  deriveSecurityBucket,
  parseSecurityValidatorMode,
} from "../src/lib/validate-security-finding"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { SecurityFact } from "../src/lib/security-evidence-manifest"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "../src/lib/diff-positions"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/db.ts",
    line: 17,
    score: 4,
    category: "security",
    headline: "SQL injection in query builder",
    body: "User input is concatenated directly into the SQL string.",
    ...overrides,
  }
}

function fact(overrides: Partial<SecurityFact> = {}): SecurityFact {
  return {
    evidenceId: "sarif:sql-injection:abc123abc123:17",
    tool: "sarif",
    path: "src/db.ts",
    line: 17,
    cwe: "CWE-89",
    summary: "Possible SQL injection at src/db.ts:17",
    ...overrides,
  }
}

function manifestOf(...facts: SecurityFact[]): Map<string, SecurityFact> {
  const m = new Map<string, SecurityFact>()
  for (const f of facts) m.set(f.evidenceId, f)
  return m
}

describe("parseSecurityValidatorMode", () => {
  it("defaults to shadow for unset / unknown values", () => {
    expect(parseSecurityValidatorMode(undefined)).toBe("shadow")
    expect(parseSecurityValidatorMode("")).toBe("shadow")
    expect(parseSecurityValidatorMode("on")).toBe("shadow")
  })
  it("resolves enforce (case-insensitive, trimmed)", () => {
    expect(parseSecurityValidatorMode("enforce")).toBe("enforce")
    expect(parseSecurityValidatorMode("  ENFORCE  ")).toBe("enforce")
  })
})

describe("deriveSecurityBucket", () => {
  it("maps a CWE id to its bucket", () => {
    expect(deriveSecurityBucket(finding({ cweId: "CWE-89" }))).toBe("injection")
    expect(deriveSecurityBucket(finding({ cweId: "CWE-862" }))).toBe("authn-access-control")
    expect(deriveSecurityBucket(finding({ cweId: "CWE-798" }))).toBe("secrets-exposure")
  })
  it("returns null for a bare security category with no usable cweId", () => {
    expect(deriveSecurityBucket(finding({ cweId: undefined }))).toBeNull()
    expect(deriveSecurityBucket(finding({ cweId: "CWE-99999" }))).toBeNull()
  })
})

describe("isDismissibleFact (SIG-282)", () => {
  it("only warn-level secret-scan facts are dismissible by the analyst", () => {
    expect(
      isDismissibleFact(fact({ tool: "secret", severity: "warn", ruleId: "generic-high-entropy-token" })),
    ).toBe(true)
    // high-confidence provider hit — a real secret must NEVER be waved off
    expect(
      isDismissibleFact(fact({ tool: "secret", severity: "error", ruleId: "aws-access-key" })),
    ).toBe(false)
    // non-secret facts (sarif/depvuln/ast) are not analyst-refutable here
    expect(isDismissibleFact(fact({ tool: "sarif" }))).toBe(false)
    // a secret fact missing severity is treated as non-dismissible
    expect(isDismissibleFact(fact({ tool: "secret", severity: undefined }))).toBe(false)
  })
})

describe("evaluateScanFactDismissal (SIG-282)", () => {
  const dismissible = fact({
    evidenceId: "secret:generic-high-entropy-token:abc123abc123:18",
    tool: "secret",
    ruleId: "generic-high-entropy-token",
    severity: "warn",
    path: "src/ui/sri.ts",
    line: 18,
    cwe: "CWE-798",
  })
  const provider = fact({
    evidenceId: "secret:aws-access-key:def456def456:42",
    tool: "secret",
    ruleId: "aws-access-key",
    severity: "error",
    path: "src/config.ts",
    line: 42,
    cwe: "CWE-798",
  })

  it("accepts a justified dismissal of a warn-level candidate (the SRI case)", () => {
    const decision = evaluateScanFactDismissal(
      { evidenceId: dismissible.evidenceId, reason: "SRI integrity hash next to a jsdelivr CDN URL; public by design" },
      manifestOf(dismissible),
    )
    expect(decision).toEqual({ accepted: true, ruleId: "generic-high-entropy-token" })
  })

  it("rejects a dismissal whose evidenceId does not resolve in the manifest", () => {
    const decision = evaluateScanFactDismissal(
      { evidenceId: "secret:made-up:000000000000:1", reason: "looks fine to me, trust me" },
      manifestOf(dismissible),
    )
    expect(decision).toEqual({ accepted: false, reason: "unknown-evidence-id", ruleId: null })
  })

  it("NEVER lets a high-confidence provider hit be waved off, even with a reason", () => {
    const decision = evaluateScanFactDismissal(
      { evidenceId: provider.evidenceId, reason: "this AKIA key is just a placeholder test fixture, ignore" },
      manifestOf(provider),
    )
    expect(decision).toEqual({ accepted: false, reason: "not-dismissible", ruleId: "aws-access-key" })
  })

  it("rejects a dismissal with no concrete justification", () => {
    const decision = evaluateScanFactDismissal(
      { evidenceId: dismissible.evidenceId, reason: "nah" },
      manifestOf(dismissible),
    )
    expect(decision).toEqual({ accepted: false, reason: "missing-justification", ruleId: "generic-high-entropy-token" })
  })
})

describe("remediationForFinding / REMEDIATION_BY_BUCKET (SIG-282)", () => {
  it("returns the bucket's vetted remediation for a classified security finding", () => {
    expect(remediationForFinding(finding({ cweId: "CWE-798" }))).toBe(REMEDIATION_BY_BUCKET["secrets-exposure"])
    expect(remediationForFinding(finding({ cweId: "CWE-89" }))).toBe(REMEDIATION_BY_BUCKET["injection"])
  })

  it("returns null for a non-security finding or an unclassified one", () => {
    expect(remediationForFinding(finding({ category: "logic", cweId: "CWE-89" }))).toBeNull()
    expect(remediationForFinding(finding({ cweId: undefined }))).toBeNull()
    expect(remediationForFinding(finding({ cweId: "CWE-99999" }))).toBeNull()
  })

  it("defines a non-empty remediation for all 11 security buckets", () => {
    const entries = Object.entries(REMEDIATION_BY_BUCKET)
    expect(entries).toHaveLength(11)
    for (const [, text] of entries) expect(text.length).toBeGreaterThan(20)
  })
})

describe("evaluateSecurityFinding (pure FP-safe decision)", () => {
  it("passes any score < 4 finding untouched (evidence rule is sev>=4 only)", () => {
    const r = evaluateSecurityFinding(finding({ score: 3, evidenceId: undefined, cweId: undefined }), manifestOf())
    expect(r.keep).toBe(true)
  })

  it("keeps a sev>=4 finding citing a resolving evidenceId at the same path/line", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-89", evidenceId: "sarif:sql-injection:abc123abc123:17" }),
      manifestOf(fact()),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS a fabricated evidenceId not present in the manifest", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-89", evidenceId: "sarif:made-up:000000000000:17" }),
      manifestOf(fact()),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("fabricated-evidence-id")
  })

  it("DROPS a real evidenceId whose fact is more than +/-10 lines from the finding (anti-fabrication / relevance)", () => {
    const r = evaluateSecurityFinding(
      finding({ line: 200, cweId: "CWE-89", evidenceId: "sarif:sql-injection:abc123abc123:17" }),
      manifestOf(fact({ line: 17 })),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("evidence-out-of-range")
  })

  it("DROPS a real evidenceId pointing at a DIFFERENT file than the finding", () => {
    const r = evaluateSecurityFinding(
      finding({ path: "src/other.ts", cweId: "CWE-89", evidenceId: "sarif:sql-injection:abc123abc123:17" }),
      manifestOf(fact({ path: "src/db.ts" })),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("evidence-out-of-range")
  })

  it("keeps a path-only fact (line=null) cited by an evidenceId regardless of the finding's line", () => {
    const r = evaluateSecurityFinding(
      finding({ path: "package.json", line: 5, cweId: "CWE-1035", evidenceId: "depvuln:GHSA-x:abc123abc123" }),
      manifestOf(fact({ evidenceId: "depvuln:GHSA-x:abc123abc123", tool: "depvuln", path: "package.json", line: null, cwe: undefined })),
    )
    expect(r.keep).toBe(true)
  })

  // AUTO-ENRICH (FP-safe crux): the model forgot the id but a manifest
  // fact corroborates the finding → keep + enrich.
  it("AUTO-ENRICHES a finding missing cweId/evidenceId when a manifest fact matches path/+-10 lines", () => {
    const r = evaluateSecurityFinding(
      finding({ line: 20, cweId: undefined, evidenceId: undefined }),
      manifestOf(fact({ line: 17, cwe: "CWE-89" })),
    )
    expect(r.keep).toBe(true)
    if (r.keep) {
      expect(r.enrich?.evidenceId).toBe("sarif:sql-injection:abc123abc123:17")
      expect(r.enrich?.cweId).toBe("CWE-89")
    }
  })

  // AUTHZ exemption: real IDOR/authz bug, NONE + justification → keep.
  it("keeps an authz-bucket finding with evidenceId NONE + a body justification", () => {
    const r = evaluateSecurityFinding(
      finding({
        cweId: "CWE-862",
        evidenceId: "NONE",
        body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
      }),
      manifestOf(),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS an authz-bucket finding with evidenceId NONE but no body justification", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-862", evidenceId: "NONE", body: "bad" }),
      manifestOf(),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("authz-none-without-justification")
  })

  // Scanner-covered bucket can't use the NONE exemption.
  it("DROPS a scanner-covered (injection) finding with no cweId and no auto-enrich match", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: undefined, evidenceId: undefined, line: 999 }),
      manifestOf(fact({ line: 17 })), // too far to auto-enrich
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("unsupported-scanner-covered")
  })

  it("DROPS an injection finding that sets evidenceId NONE (NONE is authz-only)", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-89", evidenceId: "NONE", body: "A long enough body explaining the SQL injection in detail here." }),
      manifestOf(),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("unsupported-scanner-covered")
  })
})

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(path = "src/db.ts"): ReviewableMap {
  return new Map([
    [path, [{ line: 17, side: "RIGHT" as const, position: 1 }]],
  ])
}

// The real param type, extracted from validateForSubmission's signature
// (CollectedVerdict[] isn't exported). Referencing it here means an
// incompatible change to the shape the validator actually reads
// (`verdict.findings[].id`) surfaces at this single cast site rather
// than being silently masked.
type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

// Minimal mock: validateForSubmission only reads `verdict.findings[].id`
// from this param (to build the hallucination-guard valid-id set). One
// localized `as unknown as` documents the minimal-mock intent instead of
// scattering `as never` across every call site (CodeRabbit phase-end).
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [
    { role: "security", verdict: { findings: [{ id: "security-0" }] } },
    { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
  ] as unknown as SpecialistVerdictsArg
}

function makeSpecialistVerdictsWithSecuritySource(
  source: Partial<PrReviewFinding> & { id: string },
): SpecialistVerdictsArg {
  return makeSpecialistVerdictsWithSecuritySources([source])
}

function makeSpecialistVerdictsWithSecuritySources(
  sources: Array<Partial<PrReviewFinding> & { id: string }>,
): SpecialistVerdictsArg {
  return [
    { role: "security", verdict: { findings: sources.map((source) => ({ ...finding(), ...source })) } },
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

describe("validateForSubmission — SIG-108 security evidence gate", () => {
  it("ENFORCE: drops a sev>=4 security finding with a fabricated evidenceId + increments counter + fires callback", () => {
    const dropped: Array<{ reason: string; dropped: boolean }> = []
    const onDrop = vi.fn((_f: PrReviewFinding, info: { reason: string; dropped: boolean }) => {
      dropped.push(info)
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
      onSecurityFindingDropped: onDrop,
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(dropped[0]).toEqual({ reason: "fabricated-evidence-id", dropped: true })
  })

  it("SHADOW: counts the would-drop + fires callback with dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "shadow",
      onSecurityFindingDropped: onDrop,
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1) // NOT dropped in shadow
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "fabricated-evidence-id", dropped: false })
  })

  it("defaults to SHADOW when securityValidatorMode is omitted", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: AUTO-ENRICHES a corroborated finding (missing id) — keeps it + stamps evidenceId/cweId", () => {
    const f = finding({ line: 20, cweId: undefined, evidenceId: undefined })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: securityProvenance(),
      },
      // The finding is at line 20 — register it as reviewable so it
      // survives line validation after the gate keeps it.
      reviewable: new Map([["src/db.ts", [{ line: 20, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact({ line: 17, cwe: "CWE-89" })),
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.evidenceId).toBe("sarif:sql-injection:abc123abc123:17")
    expect(result.verdict.findings[0]!.cweId).toBe("CWE-89")
  })

  it("ENFORCE: keeps an authz IDOR finding with NONE + justification", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            cweId: "CWE-862",
            evidenceId: "NONE",
            body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
          })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(),
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("SIG-117: backfills missing cweId/evidenceId from source findings before validation", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            cweId: undefined,
            evidenceId: undefined,
            body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
          })],
        },
        provenance: securityProvenance("security-0"),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdictsWithSecuritySource({
        id: "security-0",
        cweId: "CWE-862",
        evidenceId: "NONE",
      }),
      securityManifest: manifestOf(),
      securityValidatorMode: "enforce",
    })

    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.cweId).toBe("CWE-862")
    expect(result.verdict.findings[0]!.evidenceId).toBe("NONE")
  })

  it("SIG-117: does not combine cweId/evidenceId from different source findings", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: undefined, evidenceId: undefined })],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["security"],
            sourceFindingIds: ["security-0", "security-1"],
            action: "merged",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdictsWithSecuritySources([
        { id: "security-0", cweId: "CWE-862", evidenceId: undefined },
        { id: "security-1", cweId: undefined, evidenceId: "NONE" },
      ]),
    })

    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.cweId).toBe("CWE-862")
    expect(result.verdict.findings[0]!.evidenceId).toBeUndefined()
  })

  it("SIG-117: prefers a source record matching an existing synth evidenceId", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            cweId: undefined,
            evidenceId: "NONE",
            body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
          })],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["security"],
            sourceFindingIds: ["security-0", "security-1"],
            action: "merged",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdictsWithSecuritySources([
        { id: "security-0", cweId: "CWE-89", evidenceId: undefined },
        { id: "security-1", cweId: "CWE-862", evidenceId: "NONE" },
      ]),
      securityManifest: manifestOf(),
      securityValidatorMode: "enforce",
    })

    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.cweId).toBe("CWE-862")
    expect(result.verdict.findings[0]!.evidenceId).toBe("NONE")
  })

  it("SIG-117: does not overwrite cweId/evidenceId already emitted by synth", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            cweId: "CWE-89",
            evidenceId: "sarif:sql-injection:abc123abc123:17",
          })],
        },
        provenance: securityProvenance("security-0"),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdictsWithSecuritySource({
        id: "security-0",
        cweId: "CWE-862",
        evidenceId: "NONE",
      }),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
    })

    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.cweId).toBe("CWE-89")
    expect(result.verdict.findings[0]!.evidenceId).toBe("sarif:sql-injection:abc123abc123:17")
  })

  it("does NOT apply the gate to a non-security finding (logic finding with no evidence is untouched)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ category: "logic", headline: "Off-by-one in cursor", cweId: undefined, evidenceId: undefined })],
        },
        provenance: {
          findings: [{ sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("applies the gate to a MERGED security+logic finding (security in sourceSpecialists)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          // category:"logic" but provenance says it came from security too.
          findings: [finding({ category: "logic", cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: {
          findings: [{ sourceSpecialists: ["security", "logic"], sourceFindingIds: ["security-0", "logic-0"], action: "merged", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("derives security applicability from a sourceFindingId prefix when sourceSpecialists omits it", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: {
          // sourceSpecialists empty, but the validated id has the security- prefix.
          findings: [{ sourceSpecialists: [], sourceFindingIds: ["security-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("back-compat: when no securityManifest is supplied, the gate no-ops", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      // securityManifest intentionally omitted
      securityValidatorMode: "enforce",
    })
    expect(result.droppedForFailedValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })
})

describe("evaluateSecurityFinding — review fixes (H1 / H2 / auto-enrich)", () => {
  // H1: a correctly-tagged IDOR (CWE-639) declaring NONE + a body
  // justification must KEEP. Before the fix CWE-639 mapped to no bucket
  // and the finding was dropped as unsupported-scanner-covered — the
  // exact false-negative the exemption exists to prevent.
  it("H1: CWE-639 IDOR + evidenceId NONE + justification → keep", () => {
    expect(deriveSecurityBucket(finding({ cweId: "CWE-639" }))).toBe("authn-access-control")
    const decision = evaluateSecurityFinding(
      finding({
        score: 5,
        cweId: "CWE-639",
        evidenceId: "NONE",
        body: "Missing object-level authorization check on the order lookup; no static pattern detects this.",
      }),
      manifestOf(),
    )
    expect(decision.keep).toBe(true)
  })

  it("H1: CWE-284 (improper access control) maps to the authz bucket", () => {
    expect(deriveSecurityBucket(finding({ cweId: "CWE-284" }))).toBe("authn-access-control")
  })

  // CR-2 (CodeRabbit): the NONE exemption is authz-bucket-ONLY. An
  // unbucketed NONE (no/unmapped cweId) is NOT honored, even with a
  // justification — otherwise any sev>=4 security finding with 40 chars
  // of body could escape the gate. H1's expanded authz bucket means a
  // genuine authz finding maps here via its CWE (see the CWE-639 case
  // above); an unbucketed NONE is more likely a hallucination.
  it("CR-2: NONE with no/unmapped cweId (bucket null) → reject (NONE is authz-only)", () => {
    // Explicit body (> the authz justification threshold) so the test
    // pins the "NONE is authz-only" behavior even if finding()'s default
    // body text changes (CodeRabbit nitpick).
    const f = finding({
      score: 5,
      cweId: undefined,
      evidenceId: "NONE",
      body: "Missing object-level authorization check; no static pattern exists for this flow.",
    })
    expect(deriveSecurityBucket(f)).toBeNull()
    expect(evaluateSecurityFinding(f, manifestOf())).toEqual({
      keep: false,
      reason: "unsupported-scanner-covered",
    })
  })

  // NONE is NOT a free pass for a scanner-covered bucket: an injection
  // finding (CWE-89) claiming NONE falls through to auto-enrich and, with
  // no backing fact, is rejected.
  it("scanner-covered bucket (CWE-89) claiming NONE with no fact → reject", () => {
    const decision = evaluateSecurityFinding(
      finding({ score: 5, cweId: "CWE-89", evidenceId: "NONE" }),
      manifestOf(),
    )
    expect(decision).toEqual({ keep: false, reason: "unsupported-scanner-covered" })
  })

  // Auto-enrich must SKIP path-only facts (line === null): otherwise a
  // hallucinated finding anywhere in a file with a path-only fact (every
  // dep-vuln on a manifest file) would silently borrow that fact's id.
  it("auto-enrich skips path-only facts (no borrowed id for an uncited finding)", () => {
    const pathOnly = fact({
      evidenceId: "depvuln:CVE-2025-1:deadbeef0001",
      tool: "depvuln",
      path: "package-lock.json",
      line: null,
      cwe: undefined,
    })
    const decision = evaluateSecurityFinding(
      finding({ score: 5, cweId: undefined, evidenceId: undefined, path: "package-lock.json", line: 999 }),
      manifestOf(pathOnly),
    )
    expect(decision).toEqual({ keep: false, reason: "unsupported-scanner-covered" })
  })

  // A line-bearing fact within +/-10 still auto-enriches a finding the
  // model forgot to cite.
  it("auto-enrich keeps + stamps a line-bearing fact within +/-10", () => {
    const decision = evaluateSecurityFinding(
      finding({ score: 5, cweId: undefined, evidenceId: undefined, path: "src/db.ts", line: 20 }),
      manifestOf(fact({ line: 17 })),
    )
    expect(decision.keep).toBe(true)
    if (decision.keep) {
      expect(decision.enrich?.evidenceId).toBe("sarif:sql-injection:abc123abc123:17")
      expect(decision.enrich?.cweId).toBe("CWE-89")
    }
  })

  // When multiple line-bearing facts match, the CLOSEST line wins.
  it("auto-enrich picks the closest line among multiple matches", () => {
    const near = fact({ evidenceId: "ast:rule:near", line: 19 })
    const far = fact({ evidenceId: "ast:rule:far", line: 12 })
    const decision = evaluateSecurityFinding(
      finding({ score: 5, cweId: undefined, evidenceId: undefined, path: "src/db.ts", line: 20 }),
      manifestOf(far, near),
    )
    expect(decision.keep).toBe(true)
    if (decision.keep) expect(decision.enrich?.evidenceId).toBe("ast:rule:near")
  })
})

// ── SIG-141: reviewer over-fire suppression (DO-authz + line-1 anchor) ──

describe("validateForSubmission — SIG-141 over-fire suppression", () => {
  it("suppresses an authz finding on a DurableObject path — unconditionally, even in shadow", () => {
    const dropped: Array<{ reason: string; dropped: boolean }> = []
    const onDrop = vi.fn((_f: PrReviewFinding, info: { reason: string; dropped: boolean }) => {
      dropped.push(info)
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            path: "src/do/repo-graph.ts",
            cweId: "CWE-639",
            evidenceId: "NONE",
            body: "The blastRadius method lacks an access check before reading caller-supplied symbol ids and could be invoked without authorization.",
          })],
        },
        provenance: securityProvenance(),
      },
      reviewable: new Map([["src/do/repo-graph.ts", [{ line: 17, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      // line 17 is inside the DO class span → suppressed.
      durableObjectClassSpans: new Map([["src/do/repo-graph.ts", [{ start: 1, end: 100 }]]]),
      securityValidatorMode: "shadow", // shadow — but DO-authz suppression is a correctness drop, unconditional
      onSecurityFindingDropped: onDrop,
    })
    expect(result.verdict.findings).toHaveLength(0) // dropped despite shadow mode
    expect(dropped[0]).toEqual({ reason: "do-method-authz-trust-boundary", dropped: true })
  })

  it("does NOT suppress an authz finding OUTSIDE the DO class span (co-located top-level helper)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            path: "src/do/mixed.ts",
            line: 5, // a top-level helper ABOVE the DO class (span starts at 20)
            cweId: "CWE-639",
            evidenceId: "NONE",
            body: "The exported readRecord helper lacks an access check before returning the requested row and could leak another tenant's data.",
          })],
        },
        provenance: securityProvenance(),
      },
      reviewable: new Map([["src/do/mixed.ts", [{ line: 5, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      durableObjectClassSpans: new Map([["src/do/mixed.ts", [{ start: 20, end: 120 }]]]),
      securityValidatorMode: "shadow",
    })
    // Real authz bug in a co-located helper (line 5, outside the class span)
    // must NOT be hidden — kept via the AUTHZ NONE + justification path.
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("does NOT suppress an authz-CWE finding that is NOT security-sourced (came from logic/tests/perf)", () => {
    // A logic-sourced finding that happens to carry an authz CWE must not be
    // caught by the DO suppression — that gate is scoped to security provenance.
    const logicProvenance: SynthesizerProvenance = {
      findings: [
        { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
      ],
      dropped: [],
      softened: [],
    }
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            path: "src/do/repo-graph.ts",
            line: 17,
            cweId: "CWE-639",
            category: "logic",
            headline: "Off-by-one lets the wrong record id through",
            body: "The bounds check uses <= instead of <, so the loop reads one record past the requested range.",
          })],
        },
        provenance: logicProvenance,
      },
      reviewable: new Map([["src/do/repo-graph.ts", [{ line: 17, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      durableObjectClassSpans: new Map([["src/do/repo-graph.ts", [{ start: 1, end: 100 }]]]),
      securityValidatorMode: "shadow",
    })
    // Not security-sourced → DO gate skips → kept.
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("does NOT suppress an authz finding when the path is not a DurableObject", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({
            path: "src/db.ts",
            cweId: "CWE-639",
            evidenceId: "NONE",
            body: "The query handler lacks an access check before reading the requested record id and could leak another tenant's data.",
          })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable("src/db.ts"),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      durableObjectClassSpans: new Map(), // not a DO file
      securityValidatorMode: "shadow",
    })
    // AUTHZ NONE + body justification keeps it; the DO gate does not fire.
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("withholds a line-1 (file-header) finding from inline anchoring even when line 1 is reviewable", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ path: "src/db.ts", line: 1 })],
        },
        provenance: securityProvenance(),
      },
      // line 1 IS in the reviewable set — proves the withhold is by the line-1
      // guard, not by side-derivation failing.
      reviewable: new Map([["src/db.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
      // no securityManifest → security gate no-ops; finding flows to line-1 gate
    })
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.droppedForInvalidLine).toBe(1)
  })
})
