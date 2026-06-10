// SIG-108: security-finding evidence gate tests — the pure
// `evaluateSecurityFinding` unit layer (the FP-safe decision per
// (finding shape, manifest)), plus the dismissal / bucket / remediation
// helpers (mirror tests/validate-testing-finding-citation.test.ts).
//
// The `validateForSubmission` integration layer (security applicability
// via provenance, shadow vs enforce, the droppedForFailedValidation
// counter, the onSecurityFindingDropped callback, over-fire suppression)
// is exercised in the sibling file
// `validate-security-finding.integration.test.ts`.

import { describe, it, expect } from "vitest"
import {
  evaluateSecurityFinding,
  evaluateScanFactDismissal,
  isDismissibleFact,
  remediationForFinding,
  REMEDIATION_BY_BUCKET,
  SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED,
  deriveSecurityBucket,
  parseSecurityValidatorMode,
} from "@/lib/ensemble/domain/gates/validate-security-finding"
import {
  finding,
  fact,
  manifestOf,
} from "@/lib/ensemble/domain/gates/validate-security-finding.test-helpers"

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
  it("returns the bucket's vetted remediation for a non-secrets security finding", () => {
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

describe("remediationForFinding — secrets-exposure credential gate (Pattern A)", () => {
  it("keeps the full alarmist remediation when the cited line holds a real credential", () => {
    const f = finding({ cweId: "CWE-798", headline: "Hard-coded AWS key" })
    expect(remediationForFinding(f, 'const apiKey = "AKIAIOSFODNN7EXAMPLE"')).toBe(
      REMEDIATION_BY_BUCKET["secrets-exposure"],
    )
  })

  it("de-alarms when the cited line has NO credential (the hallucinated .length leak)", () => {
    const f = finding({ cweId: "CWE-798", headline: "Secret leaked to logs" })
    expect(remediationForFinding(f, "console.log(payload.length)")).toBe(
      SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED,
    )
    // The de-alarmed text must NEVER confidently assert compromise.
    expect(SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED).not.toContain("Treat the value as compromised")
    expect(SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED.toLowerCase()).toContain("if this value is an actual credential")
  })

  it("de-alarms a secrets-exposure finding when no cited line text is threaded (back-compat)", () => {
    expect(remediationForFinding(finding({ cweId: "CWE-798" }))).toBe(SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED)
  })

  it("leaves every other bucket's remediation unchanged regardless of cited text", () => {
    // injection / xss / authz etc. ignore the cited-line argument entirely.
    expect(remediationForFinding(finding({ cweId: "CWE-89" }), "console.log(x.length)")).toBe(
      REMEDIATION_BY_BUCKET["injection"],
    )
    expect(remediationForFinding(finding({ cweId: "CWE-79" }), 'const apiKey = "AKIAIOSFODNN7EXAMPLE"')).toBe(
      REMEDIATION_BY_BUCKET["xss"],
    )
    expect(remediationForFinding(finding({ cweId: "CWE-639" }), "anything")).toBe(
      REMEDIATION_BY_BUCKET["authn-access-control"],
    )
  })

  it("returns null for a non-security finding even with credential-looking cited text", () => {
    expect(remediationForFinding(finding({ category: "logic", cweId: "CWE-798" }), 'const apiKey = "AKIAIOSFODNN7EXAMPLE"')).toBeNull()
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

describe("evaluateSecurityFinding — SIG-325 cross-class laundering", () => {
  it("REJECTS an explicit citation whose fact is a DIFFERENT CWE bucket (CWE-22 finding citing a CWE-798 secret fact)", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-22", evidenceId: "secret:generic:abc123abc123:17", line: 17 }),
      manifestOf(fact({ evidenceId: "secret:generic:abc123abc123:17", cwe: "CWE-798", line: 17 })),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("evidence-class-mismatch")
  })

  it("does NOT auto-enrich a CWE-918 finding against a nearby CWE-798 fact (laundering closed → unsupported)", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-918", evidenceId: undefined, line: 17 }),
      manifestOf(fact({ evidenceId: "secret:generic:abc123abc123:17", cwe: "CWE-798", line: 17 })),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("unsupported-scanner-covered")
  })

  it("ALLOWS a same-bucket CWE relabel (CWE-862 finding citing a CWE-863 fact — both authn-access-control)", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-862", evidenceId: "sarif:authz:abc123abc123:17", line: 17 }),
      manifestOf(fact({ evidenceId: "sarif:authz:abc123abc123:17", cwe: "CWE-863", line: 17 })),
    )
    expect(r.keep).toBe(true)
  })

  it("ALLOWS a citation when the fact has no usable CWE bucket (cannot prove a mismatch → FN-safe)", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: "CWE-22", evidenceId: "depvuln:cve:abc123abc123:17", line: 17 }),
      manifestOf(fact({ evidenceId: "depvuln:cve:abc123abc123:17", cwe: "CVE-2024-0001", line: 17 })),
    )
    expect(r.keep).toBe(true)
  })

  it("still auto-enriches a finding with NO cweId (the 'model forgot the id' case) against a real fact", () => {
    const r = evaluateSecurityFinding(
      finding({ cweId: undefined, evidenceId: undefined, line: 17 }),
      manifestOf(fact({ evidenceId: "sarif:sqli:abc123abc123:17", cwe: "CWE-89", line: 17 })),
    )
    expect(r.keep).toBe(true)
    if (r.keep) expect(r.enrich).toEqual({ evidenceId: "sarif:sqli:abc123abc123:17", cweId: "CWE-89" })
  })
})
