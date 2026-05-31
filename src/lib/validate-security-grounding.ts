// SIG-293 v1: security-finding grounding gate (secrets-exposure).
//
// The pattern-grounding companion to SIG-108's *evidence* gate, and the
// deeper root of Pattern A (#248). Where SIG-108 asks "does a sev>=4
// security finding carry a deterministic manifest fact?", and Pattern A
// gated only the alarmist "revoke and rotate" REMEDIATION text, THIS gate
// asks the soundness question for the ONE category where the cited line
// itself proves-or-refutes the claim: a `secrets-exposure` finding is only
// believable when the cited code actually CONTAINS a credential token. A
// secrets-exposure finding whose cited line holds no credential (the #243
// FP: a sev-3 finding that misread `console.log(payload.length)` as a leak)
// is a hallucination and is DEMOTED to the review body (content preserved,
// never hard-dropped).
//
// WHY ONLY secrets-exposure (deepseek-v4-pro §1 detectability ranking):
//   secrets-exposure (CWE-798) is the ONLY HIGH-confidence category — a
//   line either contains a credential-shaped token or it doesn't, and
//   `containsCredentialToken` (the Pattern A detector, biased toward false)
//   decides it deterministically. injection / xss / path-traversal are
//   MEDIUM (a parameterised query and a concatenated one look IDENTICAL at
//   the line level, so a regex gate there risks false-negatives — dropping
//   a REAL injection bug), and every other category (authn-access-control,
//   ssrf, deserialization, memory-safety, ...) is an ABSENCE with no
//   line-level signature. Gating any of those would suppress real findings,
//   so they are NOT evaluated — leaving them ungated IS the soundness
//   guarantee, not a gap.
//
// SOUNDNESS (deepseek-v4-pro §2 — suppress only when PROVABLY ungrounded):
//   SUPPRESS  ⟺  bucket = secrets-exposure
//             ∧  ¬HAS_CORROBORATING_MANIFEST_FACT   (no real scanner hit)
//             ∧  cited code is in hand AND non-empty AND has NO credential
//   - A corroborating manifest fact (a real secret-scanner / CWE-798 hit at
//     the finding's path within +/-10 lines, or a path-only secret fact)
//     ALWAYS keeps — deterministic tools are ground truth, never second-
//     guessed.
//   - Any non-secrets bucket (or an unbucketed finding with no CWE-798)
//     keeps — not in scope.
//   - No diff wired, or the cited line(s) could not be resolved to ANY
//     added-line text (empty) → keep. We only suppress when we hold the
//     actual cited code and it demonstrably lacks a credential. Every
//     uncertain case keeps → zero false-negatives.
//
// SHADOW-FIRST: the actual demotion is gated behind
//   `OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE` (off | shadow | enforce,
//   default off) at the call site. `off` ⇒ the gate never runs; `shadow` ⇒
//   counts/telemeters what WOULD demote but keeps every finding inline
//   (zero behavior change); only `enforce` demotes. This module is pure and
//   mode-agnostic — the orchestrator decides what to do with the verdict.

import type { PrReviewFinding } from "./triage-pr-review"
import type { SecurityFact } from "./security-evidence-manifest"
import {
  deriveSecurityBucket,
  EVIDENCE_LINE_TOLERANCE,
  type SecurityBucket,
} from "./validate-security-finding"
import { containsCredentialToken } from "./secret-scan"

/**
 * Validator mode. `off` (default): the gate doesn't run. `shadow`:
 * telemeter what WOULD be demoted but keep every finding inline.
 * `enforce`: actually demote ungrounded secrets-exposure findings to the
 * review body. Three-state with `off` as the cautious default — matches
 * the off|shadow|enforce idiom of `parseAbsenceClaimValidatorMode` /
 * `GateMode` / `OPENCLAW_GRAPH_EXPANSION`.
 */
export type SecurityGroundingValidatorMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE`. Case-insensitive,
 * whitespace-tolerant; any unknown / missing value resolves to `off` —
 * the cautious default that disables the gate entirely (a security-
 * critical gate must never auto-enable on a typo).
 */
export function parseSecurityGroundingValidatorMode(
  raw: string | undefined,
): SecurityGroundingValidatorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/** Single failure shape — a secrets-exposure claim whose cited line holds no credential. */
export type SecurityGroundingDropReason = "secrets-exposure-ungrounded-no-credential-token"

export type SecurityGroundingDecision =
  | { keep: true }
  | { keep: false; reason: SecurityGroundingDropReason }

/**
 * The categories this gate evaluates. v1 = `secrets-exposure` ONLY — the
 * single HIGH-detectability category (deepseek §1). Widening this set in
 * v2 requires a per-category detector AND a shadow-measured false-negative
 * rate; do NOT add MEDIUM/LOW buckets here without one.
 */
const GATED_BUCKETS: ReadonlySet<SecurityBucket> = new Set<SecurityBucket>(["secrets-exposure"])

/** CWE id that a corroborating secret manifest fact carries. */
const SECRETS_CWE = "CWE-798"

export interface SecurityGroundingContext {
  /**
   * Per-file new-side added-line text — the same map the ensemble passes
   * to `validateForSubmission` (`buildAddedLineTextByLine` output): keyed
   * by path, the inner map keyed by line number, values the added line
   * text with the leading "+" stripped. Undefined when the diff isn't
   * wired (back-compat / tests) → the gate keeps every finding.
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
  /**
   * Security fact manifest. A corroborating deterministic secret fact at
   * the finding's path (within +/-10 lines, or a path-only secret fact) is
   * ground truth → keep regardless of the cited line. Undefined when no
   * manifest is wired.
   */
  manifest?: Map<string, SecurityFact> | undefined
}

/**
 * Gather the cited code for a finding from the per-line added-text map:
 * the [startLine, line] range (single line when `startLine` is absent),
 * joined with "\n" — the same shape `containsCredentialToken` expects (it
 * splits on "\n" and checks each line independently).
 *
 * Returns null (→ caller keeps, FP-safe) UNLESS we hold the FULL cited
 * range: every line in [startLine, line] must resolve to an added line. The
 * map carries only `+` (added) lines, so a multi-line range that spans a
 * CONTEXT (unchanged) line — which could carry the real credential the bot
 * cited — would resolve only the added lines and falsely read as
 * credential-free. Requiring EVERY cited line to resolve preserves the
 * zero-false-negative guarantee: a partial range is "cited code not fully
 * in hand" → keep (Codex review catch). Single-line findings (the common
 * case, incl. the #243 FP) resolve trivially and are unaffected.
 */
function collectCitedCode(
  finding: PrReviewFinding,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string | null {
  const lineMap = addedLineTextByLine.get(finding.path)
  if (!lineMap || lineMap.size === 0) return null
  const a = finding.startLine ?? finding.line
  const b = finding.line
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const lines: string[] = []
  for (let ln = lo; ln <= hi; ln++) {
    const text = lineMap.get(ln)
    // A cited line that isn't a visible added line (e.g. a context line that
    // may hold the credential) → we can't see the whole range → keep.
    if (text === undefined) return null
    lines.push(text)
  }
  return lines.length > 0 ? lines.join("\n") : null
}

/**
 * Does the manifest hold a deterministic SECRET fact that corroborates this
 * finding? A real secret-scanner hit (`tool: "secret"`) or any CWE-798 fact
 * at the SAME path AND either line-less (a path-only secret fact) or within
 * +/-10 lines of the finding is ground truth — never suppress over it. A
 * non-secret fact (dep-vuln / unrelated SARIF) at the same path does NOT
 * corroborate a secrets-exposure claim, so it's excluded.
 */
function hasCorroboratingSecretFact(
  finding: PrReviewFinding,
  manifest: Map<string, SecurityFact>,
): boolean {
  for (const fact of manifest.values()) {
    if (fact.path !== finding.path) continue
    // Normalize the CWE before matching (same trim+upper as
    // deriveSecurityBucket) so a non-secret-tool fact tagged a differently-
    // cased/padded "cwe-798" still corroborates — a missed match here would
    // let enforce demote a grounded finding (CodeRabbit, KEEP-direction).
    const normalizedCwe = typeof fact.cwe === "string" ? fact.cwe.trim().toUpperCase() : undefined
    if (fact.tool !== "secret" && normalizedCwe !== SECRETS_CWE) continue
    if (fact.line === null) return true // path-only secret fact
    if (Math.abs(fact.line - finding.line) <= EVIDENCE_LINE_TOLERANCE) return true
  }
  return false
}

/**
 * Pure decision for ONE finding. Mode-agnostic — the orchestrator gates
 * the demotion behind off/shadow/enforce. Never throws, no I/O.
 *
 * Order (each short-circuits to keep before the next, narrowest-scope
 * first): not-a-gated-bucket → corroborated-by-manifest → no-cited-code →
 * has-credential-token. Only a secrets-exposure finding that survives all
 * four keep-paths (in a gated bucket, uncorroborated, with non-empty cited
 * code that holds NO credential) is demoted. No score floor — a P0/P1
 * ungrounded secrets claim is the worst case and is demoted too.
 */
export function evaluateSecurityGrounding(
  finding: PrReviewFinding,
  context: SecurityGroundingContext,
): SecurityGroundingDecision {
  const bucket = deriveSecurityBucket(finding)
  if (bucket === null || !GATED_BUCKETS.has(bucket)) return { keep: true }

  // Manifest = ground truth: a real secret-scanner / CWE-798 hit near the
  // cited line means the bot is corroborated even if THIS exact line is
  // clean (the credential may sit a few lines away). Never suppress.
  if (context.manifest && hasCorroboratingSecretFact(finding, context.manifest)) {
    return { keep: true }
  }

  // No diff wired → can't evaluate → keep (back-compat / FP-safe).
  if (context.addedLineTextByLine === undefined) return { keep: true }

  const cited = collectCitedCode(finding, context.addedLineTextByLine)
  // Cited code not in hand (path absent / cited line is context, not an
  // added line) → we can't PROVE the absence of a credential → keep.
  if (cited === null || cited.trim().length === 0) return { keep: true }

  // We hold the actual cited code. If it contains a credential token the
  // claim is grounded → keep. Otherwise the bot pointed at a line with no
  // credential and called it a leak → demote.
  if (containsCredentialToken(cited)) return { keep: true }

  return { keep: false, reason: "secrets-exposure-ungrounded-no-credential-token" }
}
