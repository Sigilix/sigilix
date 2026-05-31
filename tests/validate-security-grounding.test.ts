// SIG-293 v1: security-finding grounding gate (secrets-exposure) tests.
//
// Layer 1: evaluateSecurityGrounding + parseSecurityGroundingValidatorMode
// pure unit tests — the FP-safe decision per (finding shape, context). The
// bucket scope (secrets-exposure ONLY), the credential-token predicate, the
// manifest-corroboration ground-truth keep, every UNKNOWN→keep, and the
// never-throws contract.
//
// Layer 2: validateForSubmission integration — off / shadow / enforce
// wiring, the droppedForFailedSecurityGroundingValidation counter, the
// onSecurityGroundingFindingDropped callback, and the demote-to-body
// behavior.
//
// Mirrors the style of tests/validate-absence-grounding.test.ts.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateSecurityGrounding,
  parseSecurityGroundingValidatorMode,
  type SecurityGroundingContext,
} from "../src/lib/validate-security-grounding"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { SecurityFact } from "../src/lib/security-evidence-manifest"
import type { ReviewableMap } from "../src/lib/diff-positions"

const PATH = "src/lib/auth.ts"

// A proven credential line (secret-scan.test.ts) — provider rule (AWS) and a
// credential-named high-entropy assignment both resolve to `true`.
const CREDENTIAL_LINE = 'const apiKey = "AKIAIOSFODNN7EXAMPLE"'
// The #243 FP: a line the bot misread as a secret leak — no credential token.
const CLEAN_LINE = "  console.log(payload.length)"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 3,
    category: "security",
    cweId: "CWE-798", // → secrets-exposure bucket
    headline: "hardcoded credential leaked",
    body: "An `apiKey` literal is committed to source.",
    ...overrides,
  }
}

function added(lineText: string, line = 17, path = PATH): ReadonlyMap<string, ReadonlyMap<number, string>> {
  return new Map([[path, new Map([[line, lineText]])]])
}

function ctx(overrides: Partial<SecurityGroundingContext> = {}): SecurityGroundingContext {
  return {
    addedLineTextByLine: added(CREDENTIAL_LINE),
    ...overrides,
  }
}

function secretFact(overrides: Partial<SecurityFact> = {}): SecurityFact {
  return {
    evidenceId: "secret:aws-access-key:abc123:17",
    tool: "secret",
    path: PATH,
    line: 17,
    cwe: "CWE-798",
    summary: "AWS access key id",
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
describe("evaluateSecurityGrounding — bucket scope", () => {
  it("KEEPS a non-secrets bucket (injection CWE-89) — not in scope", () => {
    const f = finding({ cweId: "CWE-89", headline: "SQL injection via `id`" })
    expect(evaluateSecurityGrounding(f, ctx({ addedLineTextByLine: added(CLEAN_LINE) }))).toEqual({ keep: true })
  })

  it("KEEPS an authn bucket (CWE-862) — absence category, never gated", () => {
    const f = finding({ cweId: "CWE-862", headline: "missing access check" })
    expect(evaluateSecurityGrounding(f, ctx({ addedLineTextByLine: added(CLEAN_LINE) }))).toEqual({ keep: true })
  })

  it("KEEPS an unbucketed finding (bare 'security', no usable cweId)", () => {
    const f = finding({ cweId: undefined })
    expect(evaluateSecurityGrounding(f, ctx({ addedLineTextByLine: added(CLEAN_LINE) }))).toEqual({ keep: true })
  })
})

describe("evaluateSecurityGrounding — credential-token predicate (secrets-exposure)", () => {
  it("KEEPS when the cited line CONTAINS a credential token (grounded)", () => {
    expect(evaluateSecurityGrounding(finding(), ctx({ addedLineTextByLine: added(CREDENTIAL_LINE) }))).toEqual({
      keep: true,
    })
  })

  it("SUPPRESSES the #243 FP — cited line `console.log(payload.length)` holds no credential", () => {
    expect(evaluateSecurityGrounding(finding(), ctx({ addedLineTextByLine: added(CLEAN_LINE) }))).toEqual({
      keep: false,
      reason: "secrets-exposure-ungrounded-no-credential-token",
    })
  })

  it("no score floor — a P0/P1 (score 5) ungrounded secrets claim is suppressed too", () => {
    const f = finding({ score: 5 })
    expect(evaluateSecurityGrounding(f, ctx({ addedLineTextByLine: added(CLEAN_LINE) }))).toEqual({
      keep: false,
      reason: "secrets-exposure-ungrounded-no-credential-token",
    })
  })

  it("multi-line finding: credential on ANY line of [startLine, line] → keep", () => {
    const f = finding({ startLine: 16, line: 17 })
    const map = new Map([[PATH, new Map([[16, CLEAN_LINE], [17, CREDENTIAL_LINE]])]])
    expect(evaluateSecurityGrounding(f, { addedLineTextByLine: map })).toEqual({ keep: true })
  })

  it("multi-line finding with an UNRESOLVED line in range (a context line) → keep (zero-FN: the missing line may hold the credential)", () => {
    // Range [16,17] but only line 17 is an added line; line 16 is a context
    // line absent from the map — the credential the bot cited could be there,
    // so we must NOT suppress on the partial (clean) evidence. (Codex catch.)
    const f = finding({ startLine: 16, line: 17 })
    const map = new Map([[PATH, new Map([[17, CLEAN_LINE]])]])
    expect(evaluateSecurityGrounding(f, { addedLineTextByLine: map })).toEqual({ keep: true })
  })
})

describe("evaluateSecurityGrounding — UNKNOWN always keeps (zero false-negatives)", () => {
  it("KEEPS when no diff is wired (addedLineTextByLine undefined)", () => {
    expect(evaluateSecurityGrounding(finding(), { addedLineTextByLine: undefined })).toEqual({ keep: true })
  })

  it("KEEPS when the cited line isn't an added line (path absent in the map)", () => {
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE, 17, "other/file.ts") }),
    ).toEqual({ keep: true })
  })

  it("KEEPS when the cited line resolves to empty/whitespace text", () => {
    expect(evaluateSecurityGrounding(finding(), ctx({ addedLineTextByLine: added("   ") }))).toEqual({ keep: true })
  })

  it("never throws on degenerate input", () => {
    const degenerate = finding({ headline: "", body: "", cweId: "CWE-798" })
    expect(() => evaluateSecurityGrounding(degenerate, {})).not.toThrow()
    expect(evaluateSecurityGrounding(degenerate, {})).toEqual({ keep: true })
  })
})

describe("evaluateSecurityGrounding — manifest corroboration = ground truth", () => {
  it("KEEPS a clean-cited-line finding when a SECRET fact corroborates within +/-10 lines", () => {
    const manifest = new Map([["k", secretFact({ line: 20 })]]) // 3 lines from finding.line 17
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: true })
  })

  it("KEEPS via a non-secret-tool fact tagged a differently-cased CWE ('cwe-798') — normalized match", () => {
    const manifest = new Map([
      ["k", secretFact({ tool: "sarif", cwe: "  cwe-798 ", line: 17, evidenceId: "sarif:rule:..:17" })],
    ])
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: true })
  })

  it("KEEPS on a path-only secret fact (line === null)", () => {
    const manifest = new Map([["k", secretFact({ line: null })]])
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: true })
  })

  it("SUPPRESSES when the only manifest fact is non-secret (dep-vuln) — doesn't corroborate a secrets claim", () => {
    const manifest = new Map([
      ["k", secretFact({ tool: "depvuln", cwe: undefined, line: 17, evidenceId: "depvuln:lodash:..:17" })],
    ])
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: false, reason: "secrets-exposure-ungrounded-no-credential-token" })
  })

  it("SUPPRESSES when a secret fact is on the SAME path but >10 lines away", () => {
    const manifest = new Map([["k", secretFact({ line: 40 })]]) // 23 lines from finding.line 17
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: false, reason: "secrets-exposure-ungrounded-no-credential-token" })
  })

  it("does NOT corroborate from a secret fact on a DIFFERENT path", () => {
    const manifest = new Map([["k", secretFact({ path: "other/file.ts", line: 17 })]])
    expect(
      evaluateSecurityGrounding(finding(), { addedLineTextByLine: added(CLEAN_LINE), manifest }),
    ).toEqual({ keep: false, reason: "secrets-exposure-ungrounded-no-credential-token" })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("parseSecurityGroundingValidatorMode", () => {
  it("returns 'shadow' / 'enforce' for the literals (case/space-insensitive)", () => {
    expect(parseSecurityGroundingValidatorMode("shadow")).toBe("shadow")
    expect(parseSecurityGroundingValidatorMode("  SHADOW ")).toBe("shadow")
    expect(parseSecurityGroundingValidatorMode("enforce")).toBe("enforce")
    expect(parseSecurityGroundingValidatorMode("Enforce")).toBe("enforce")
  })
  it("defaults to 'off' for anything else (undefined, empty, garbage)", () => {
    expect(parseSecurityGroundingValidatorMode(undefined)).toBe("off")
    expect(parseSecurityGroundingValidatorMode("")).toBe("off")
    expect(parseSecurityGroundingValidatorMode("off")).toBe("off")
    expect(parseSecurityGroundingValidatorMode("enforced")).toBe("off")
  })
})

// ── Integration with validateForSubmission (off / shadow / enforce) ────

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeReviewable(path = PATH): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "security", verdict: { findings: [{ id: "security-0" }] } }] as unknown as SpecialistVerdictsArg
}
function prov(count = 1, sourceId = "security-0"): SynthesizerProvenance {
  return {
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: ["security"],
      sourceFindingIds: [sourceId],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}

// A secrets-exposure finding whose cited line holds no credential — the
// canonical #243 FP. score 3 + a backticked `payload` that resolves to the
// cited line so it survives the inline-grounding gate (default shadow keeps
// anyway, but this keeps the fixture honest) and reaches the security gate.
function secretsFinding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return finding({
    headline: "secret leaked via `payload`",
    body: "Looks like a credential is logged.",
    ...overrides,
  })
}

function run(
  findings: PrReviewFinding[],
  opts: {
    mode?: "off" | "shadow" | "enforce"
    citedLine?: string
    manifest?: Map<string, SecurityFact>
    onDrop?: (...a: unknown[]) => void
  } = {},
) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
      provenance: prov(findings.length),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    addedLineTextByLine: added(opts.citedLine ?? CLEAN_LINE),
    ...(opts.manifest ? { securityManifest: opts.manifest } : {}),
    ...(opts.mode ? { securityGroundingValidatorMode: opts.mode } : {}),
    ...(opts.onDrop ? { onSecurityGroundingFindingDropped: opts.onDrop } : {}),
  })
}

describe("validateForSubmission — SIG-293 security-grounding gate", () => {
  it("OFF (default): the gate never runs — counter 0, finding kept inline, callback not fired", () => {
    const onDrop = vi.fn()
    const result = run([secretsFinding()], { onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("SHADOW: counts the would-demote + fires callback dropped:false but KEEPS the finding inline", () => {
    const onDrop = vi.fn()
    const result = run([secretsFinding()], { mode: "shadow", onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.unanchoredFindings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "secrets-exposure-ungrounded-no-credential-token",
      dropped: false,
    })
  })

  it("ENFORCE: demotes the ungrounded secrets claim to the body (counter++, callback dropped:true)", () => {
    const onDrop = vi.fn()
    const result = run([secretsFinding()], { mode: "enforce", onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline.includes("secret leaked"))).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "secrets-exposure-ungrounded-no-credential-token",
      dropped: true,
    })
  })

  it("ENFORCE: KEEPS a grounded secrets finding (cited line HAS a credential) inline — counter 0", () => {
    const onDrop = vi.fn()
    const result = run([secretsFinding()], { mode: "enforce", citedLine: CREDENTIAL_LINE, onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("ENFORCE: KEEPS a clean-cited-line finding corroborated by a manifest secret fact — counter 0", () => {
    const onDrop = vi.fn()
    const manifest = new Map([["k", secretFact({ line: 17 })]])
    const result = run([secretsFinding()], { mode: "enforce", citedLine: CLEAN_LINE, manifest, onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("ENFORCE: KEEPS a non-secrets finding (injection bucket) inline even on a clean line — counter 0", () => {
    const onDrop = vi.fn()
    const f = secretsFinding({ cweId: "CWE-89", headline: "SQL injection via `payload`" })
    const result = run([f], { mode: "enforce", onDrop })
    expect(result.droppedForFailedSecurityGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
