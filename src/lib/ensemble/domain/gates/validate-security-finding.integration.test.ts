// SIG-108 / SIG-141 / SIG-325 — security-finding evidence gate:
// `validateForSubmission` integration (applicability via provenance,
// shadow vs enforce, the droppedForFailedValidation counter, the
// onSecurityFindingDropped callback, over-fire suppression).
//
// Sibling of validate-security-finding.test.ts (split out under
// SIG-318/SIG-376 to keep each suite ≤1,000 lines). Shares the
// `finding`/`fact`/`manifestOf` fixtures via
// validate-security-finding.test-helpers.ts.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateSecurityFinding,
  deriveSecurityBucket,
} from "@/src/lib/ensemble/domain/gates/validate-security-finding"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { finding, fact, manifestOf } from "@/src/lib/ensemble/domain/gates/validate-security-finding.test-helpers"

function makeReviewable(path = "src/db.ts"): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
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
    {
      role: "security",
      verdict: { findings: sources.map((source) => ({ ...finding(), ...source })) },
    },
    { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
  ] as unknown as SpecialistVerdictsArg
}

function securityProvenance(sourceId = "security-0"): SynthesizerProvenance {
  return {
    findings: [
      {
        sourceSpecialists: ["security"],
        sourceFindingIds: [sourceId],
        action: "kept",
        verifiedViaRetrieval: false,
      },
    ],
    dropped: [],
    softened: [],
  }
}

describe("validateForSubmission — SIG-108 security evidence gate", () => {
  it("ENFORCE: DEMOTES a sev>=4 security finding with a fabricated evidenceId to the body (not dropped) + increments counter + fires callback", () => {
    const dropped: Array<{ reason: string; dropped: boolean }> = []
    const onDrop = vi.fn((_f: PrReviewFinding, info: { reason: string; dropped: boolean }) => {
      dropped.push(info)
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
      onSecurityFindingDropped: onDrop,
      trustLedgerEnabled: true,
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0) // no longer inline
    // SIG-108 demote-conversion (2026-06-01): the finding is DEMOTED to the body,
    // NOT hard-dropped — it stays visible with a security-evidence demote reason.
    expect(result.unanchoredFindings).toHaveLength(1)
    // Assert the FULL demoted record — path/line/evidenceId survive the move, proving
    // the finding was DEMOTED in place (not reconstructed or dropped) (CodeRabbit #271).
    expect(result.unanchoredFindings).toEqual([
      expect.objectContaining({
        path: "src/db.ts",
        line: 17,
        category: "security",
        cweId: "CWE-89",
        evidenceId: "sarif:fake:000000000000:17",
        trust: {
          tier: "body-only-ungrounded",
          surface: "body",
          demoteReason: "security-evidence",
        },
      }),
    ])
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(dropped[0]).toEqual({ reason: "fabricated-evidence-id", dropped: true })
  })

  it("ENFORCE + ledger OFF: still DEMOTES to the body but leaves the finding un-annotated (no trust)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: securityProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      securityManifest: manifestOf(fact()),
      securityValidatorMode: "enforce",
      // trustLedgerEnabled omitted (off): demotion still happens, but the finding must
      // NOT be trust-annotated — guards against silently writing trust when the ledger
      // is disabled (CodeRabbit #271).
    })
    expect(result.droppedForFailedValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings).toHaveLength(1)
    expect(result.unanchoredFindings[0]?.trust).toBeUndefined()
  })

  it("SHADOW: counts the would-drop + fires callback with dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
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
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "fabricated-evidence-id",
      dropped: false,
    })
  })

  it("defaults to SHADOW when securityValidatorMode is omitted", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              cweId: "CWE-862",
              evidenceId: "NONE",
              body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
            }),
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              cweId: undefined,
              evidenceId: undefined,
              body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
            }),
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ cweId: undefined, evidenceId: undefined })],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["security"],
              sourceFindingIds: ["security-0", "security-1"],
              action: "merged",
              verifiedViaRetrieval: false,
            },
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              cweId: undefined,
              evidenceId: "NONE",
              body: "Missing object-level authorization check; no static pattern exists for this IDOR.",
            }),
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["security"],
              sourceFindingIds: ["security-0", "security-1"],
              action: "merged",
              verifiedViaRetrieval: false,
            },
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              cweId: "CWE-89",
              evidenceId: "sarif:sql-injection:abc123abc123:17",
            }),
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              category: "logic",
              headline: "Off-by-one in cursor",
              cweId: undefined,
              evidenceId: undefined,
            }),
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
          softened: [],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          // category:"logic" but provenance says it came from security too.
          findings: [
            finding({
              category: "logic",
              cweId: "CWE-89",
              evidenceId: "sarif:fake:000000000000:17",
            }),
          ],
        },
        provenance: {
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })],
        },
        provenance: {
          // sourceSpecialists empty, but the validated id has the security- prefix.
          findings: [
            {
              sourceSpecialists: [],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
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
    const decision = evaluateSecurityFinding(finding({ score: 5, cweId: "CWE-89", evidenceId: "NONE" }), manifestOf())
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
      finding({
        score: 5,
        cweId: undefined,
        evidenceId: undefined,
        path: "package-lock.json",
        line: 999,
      }),
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              path: "src/do/repo-graph.ts",
              cweId: "CWE-639",
              evidenceId: "NONE",
              body: "The blastRadius method lacks an access check before reading caller-supplied symbol ids and could be invoked without authorization.",
            }),
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              path: "src/do/mixed.ts",
              line: 5, // a top-level helper ABOVE the DO class (span starts at 20)
              cweId: "CWE-639",
              evidenceId: "NONE",
              body: "The exported readRecord helper lacks an access check before returning the requested row and could leak another tenant's data.",
            }),
          ],
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
        {
          sourceSpecialists: ["logic"],
          sourceFindingIds: ["logic-0"],
          action: "kept",
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
          findings: [
            finding({
              path: "src/do/repo-graph.ts",
              line: 17,
              cweId: "CWE-639",
              category: "logic",
              headline: "Off-by-one lets the wrong record id through",
              body: "The bounds check uses <= instead of <, so the loop reads one record past the requested range.",
            }),
          ],
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
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [
            finding({
              path: "src/db.ts",
              cweId: "CWE-639",
              evidenceId: "NONE",
              body: "The query handler lacks an access check before reading the requested record id and could leak another tenant's data.",
            }),
          ],
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

  it("INLINES a line-1 finding when line 1 IS reviewable (SIG-245: top-of-file findings like secrets are anchorable)", () => {
    // SIG-245 reversal of the original SIG-141 blanket line-1 withhold: line 1
    // of a newly-added file is a real RIGHT anchor, so a genuine line-1 finding
    // (e.g. a hardcoded secret on the first line) must INLINE — inline-first.
    // (Header content over-fires are the grounding/evidence gates' job, not a
    // line-number heuristic's.)
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ path: "src/db.ts", line: 1 })],
        },
        provenance: securityProvenance(),
      },
      reviewable: new Map([["src/db.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
    })
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]?.line).toBe(1)
    expect(result.droppedForInvalidLine).toBe(0)
  })

  it("still body-routes a line-1 finding when line 1 is NOT reviewable (header on an unchanged file = outside-diff)", () => {
    // The SIG-141 suppression survives for the case it was really for: line 1
    // is not in the diff at all (an over-fire on an unchanged file's header).
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test",
          confidence: 3,
          confidenceReason: "Reason.",
          findings: [finding({ path: "src/db.ts", line: 1 })],
        },
        provenance: securityProvenance(),
      },
      // line 1 absent — only line 42 is reviewable.
      reviewable: new Map([["src/db.ts", [{ line: 42, side: "RIGHT" as const, position: 1 }]]]),
      specialistVerdicts: makeSpecialistVerdicts(),
    })
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.droppedForInvalidLine).toBe(1)
  })
})
