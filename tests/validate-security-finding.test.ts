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

function securityProvenance(sourceId = "security-0"): SynthesizerProvenance {
  return {
    findings: [
      { sourceSpecialists: ["security"], sourceFindingIds: [sourceId], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    softened: [],
    retrievalCallsUsed: 0,
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

  it("does NOT apply the gate to a non-security finding (logic finding with no evidence is untouched)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ category: "logic", headline: "Off-by-one in cursor", cweId: undefined, evidenceId: undefined })],
        },
        provenance: {
          findings: [{ sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [], retrievalCallsUsed: 0,
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
          dropped: [], softened: [], retrievalCallsUsed: 0,
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
          dropped: [], softened: [], retrievalCallsUsed: 0,
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
    const f = finding({ score: 5, cweId: undefined, evidenceId: "NONE" })
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
