// SIG-108: security-finding evidence gate.
//
// The security analogue of SIG-113's `evaluateTestingFindingCitation`.
// A sev>=4 security finding must be backed by either (a) a verbatim
// `evidenceId` resolving to a real deterministic security fact whose
// path/line is within +/-10 lines of the finding, or (b) — for the
// AuthN / Access-Control bucket only — `evidenceId: "NONE"` plus a body
// justification, because real IDOR/authz bugs have no scanner fact to
// cite. Everything else in a scanner-covered bucket is dropped.
//
// FALSE-NEGATIVE SAFETY (deepseek §2 + Codex #4) — the crux:
//   The naive "every sev>=4 security finding must carry an evidenceId"
//   rule would drop exactly the high-value LLM-only findings (IDOR,
//   missing object-level authz) that no deterministic scanner emits.
//   This gate avoids that by:
//     1. AUTO-ENRICH: if cweId/evidenceId is missing but the finding's
//        path/line (+/-10) matches a manifest fact, adopt that fact's
//        evidenceId + cwe and KEEP the finding. The model forgetting
//        to copy an id never loses a corroborated finding.
//     2. AUTHZ EXEMPTION: the AuthN/Access-Control bucket may set
//        evidenceId === "NONE" with a body justification and pass.
//     3. HARD-DROP only fabricated (non-resolving) or non-linking
//        (path/line out of range) evidence, or an unsupported sev>=4
//        finding in a scanner-covered bucket after auto-link fails.
//
// SHADOW-FIRST: the actual drop is gated behind
//   `OPENCLAW_SECURITY_VALIDATOR_MODE` (shadow | enforce, default
//   shadow) at the call site. In shadow the validator's verdict is
//   only counted/telemetered — never dropped. This module is pure and
//   mode-agnostic; the orchestrator decides what to do with the
//   verdict.

import type { PrReviewFinding, ScanFactDismissal } from "./triage-pr-review"
import type { SecurityFact } from "./security-evidence-manifest"
import { containsCredentialToken } from "./secret-scan"

/**
 * Validator mode. `shadow` (default): emit telemetry counting what
 * WOULD be dropped, but keep every finding. `enforce`: actually drop
 * rejected findings.
 */
export type SecurityValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_SECURITY_VALIDATOR_MODE`. Anything other than the
 * literal "enforce" (case-insensitive, trimmed) resolves to "shadow"
 * — the cautious default for a security-critical gate's staged
 * rollout. Mirrors how the other OPENCLAW_*_MODE knobs treat unknown
 * values conservatively.
 */
export function parseSecurityValidatorMode(raw: string | undefined): SecurityValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/**
 * CWE-Top-25 → 11 category buckets (deepseek §1). Maps each CWE id to
 * its bucket. A finding's bucket is derived from `cweId` when present,
 * else from `category`. The AuthN/Access-Control bucket is the only
 * one allowed the `evidenceId: "NONE"` exemption.
 */
const CWE_TO_BUCKET: Record<string, SecurityBucket> = {}
const BUCKET_CWES: Record<SecurityBucket, readonly number[]> = {
  injection: [89, 78, 77, 94, 611],
  xss: [79],
  "path-traversal": [22],
  deserialization: [502],
  ssrf: [918],
  "memory-safety": [787, 416, 125, 476, 190, 119],
  // H1 (code review): include the canonical IDOR / broken-access-control
  // CWEs beyond the CWE-25 core five. CWE-639 (Authorization Bypass
  // Through User-Controlled Key) is THE IDOR CWE; CWE-285 (Improper
  // Authorization), CWE-306 (Missing Authentication), CWE-638 (Not Using
  // Complete Mediation), CWE-913 (Improper Control of Dynamically-Managed
  // Resources), CWE-1220 (Insufficient Granularity of Access Control) are
  // the other common authz weaknesses a security reviewer cites. Without
  // these, a correctly-tagged IDOR (the exact class the NONE exemption
  // protects) would map to no bucket and be dropped.
  "authn-access-control": [862, 863, 287, 352, 276, 639, 285, 284, 306, 638, 913, 1220],
  "secrets-exposure": [798],
  "resource-exhaustion": [400, 770],
  "unrestricted-upload": [434],
  "input-validation": [20],
}
for (const [bucket, cwes] of Object.entries(BUCKET_CWES) as Array<[SecurityBucket, readonly number[]]>) {
  for (const n of cwes) CWE_TO_BUCKET[`CWE-${n}`] = bucket
}

export type SecurityBucket =
  | "injection"
  | "xss"
  | "path-traversal"
  | "deserialization"
  | "ssrf"
  | "memory-safety"
  | "authn-access-control"
  | "secrets-exposure"
  | "resource-exhaustion"
  | "unrestricted-upload"
  | "input-validation"

/**
 * The AuthN/Access-Control bucket is the only one where a sev>=4
 * finding may legitimately carry NO deterministic evidence (real
 * IDOR/authz bugs have no static pattern). Every other bucket has
 * widespread scanner coverage, so an unsupported sev>=4 finding there
 * is a likely hallucination.
 */
export const AUTHZ_BUCKET: SecurityBucket = "authn-access-control"

/**
 * Lines within which a cited/auto-enriched fact must sit relative to
 * the finding's line for the citation to count (deepseek §2:
 * "cross-checks that the fact's file and line (+/- 10 lines) match").
 */
export const EVIDENCE_LINE_TOLERANCE = 10

/**
 * Minimum body length for the AuthN/Access-Control NONE exemption. An
 * empty / one-word body is not a justification. Kept low because the
 * negative-constraint prompt already pushes the model toward concrete
 * bodies; this is a floor, not a quality bar.
 */
const AUTHZ_JUSTIFICATION_MIN_CHARS = 40

/**
 * Derive a finding's security bucket. Prefer the explicit `cweId`
 * (the specialist's own classification); fall back to the coarse
 * schema `category`. Returns null when neither maps to a known bucket
 * — caller treats null as "no recognized bucket" (a scanner-covered
 * unsupported claim once auto-enrich also fails).
 */
export function deriveSecurityBucket(finding: PrReviewFinding): SecurityBucket | null {
  if (typeof finding.cweId === "string") {
    const bucket = CWE_TO_BUCKET[finding.cweId.trim().toUpperCase()]
    if (bucket) return bucket
  }
  // The schema `category` enum is coarse — only "security" maps here,
  // and it carries no bucket discrimination. Treat a bare "security"
  // category (no usable cweId) as an unknown bucket so the
  // scanner-covered rule applies unless auto-enrich rescues it.
  return null
}

/**
 * SIG-282 Phase 3: vetted, deterministic remediation per security bucket.
 * A CONFIRMED security finding's remediation comes from here (keyed by the
 * finding's CWE → bucket) rather than from LLM-authored prose — so the fix
 * guidance is consistent, reviewed, and never hallucinated/alarmist. The
 * model describes the problem (the finding body); the system supplies the
 * standard remediation.
 */
export const REMEDIATION_BY_BUCKET: Record<SecurityBucket, string> = {
  injection:
    "Treat all external input as untrusted: use parameterized queries / prepared statements (or the framework's safe API) and never build SQL, shell, or template strings by concatenation.",
  xss:
    "Escape untrusted data for the exact output context (HTML, attribute, JS, URL) at render time, prefer framework auto-escaping, and apply a Content-Security-Policy as defense in depth.",
  "path-traversal":
    "Resolve the path and confirm it stays within an allowed base directory (reject `..` and absolute paths); prefer an allow-list of known-safe names over user-supplied paths.",
  deserialization:
    "Do not deserialize untrusted data into arbitrary types. Use a safe format and validate against a strict schema; never run language-native object deserialization on external input.",
  ssrf:
    "Validate and allow-list the destination host/port before the request, resolve DNS and block private/link-local/loopback ranges, and do not follow redirects to untrusted hosts.",
  "memory-safety":
    "Bound every read/write to the allocation size, check for integer overflow before size/index arithmetic, and clear freed pointers to avoid use-after-free. Prefer safe buffer wrappers.",
  "authn-access-control":
    "Enforce an explicit authorization check on every request against the authenticated principal and the specific object being accessed (object-level authz), and fail closed when the check is missing.",
  "secrets-exposure":
    "Treat the value as compromised: revoke and rotate it now, remove it from source, and load it from a secret store or environment variable. If it was committed, rewrite history so it is not recoverable from git.",
  "resource-exhaustion":
    "Bound the work: cap input size, paginate or stream large results, and apply timeouts plus a concurrency/rate limit so a single request cannot exhaust memory, connections, or CPU.",
  "unrestricted-upload":
    "Validate uploads by content type and size, store them outside the web root under a generated name, and never execute or serve them as code.",
  "input-validation":
    "Validate input against a strict allow-list (type, length, format, range) at the trust boundary and reject anything that does not match, rather than sanitizing bad input.",
}

/**
 * Believability gate (secret-remediation): the DE-ALARMED, conditional
 * remediation used for a `secrets-exposure` finding whose cited code does
 * NOT actually contain a credential-like token. The alarmist
 * `REMEDIATION_BY_BUCKET["secrets-exposure"]` text asserts compromise
 * outright ("treat the value as compromised … rewrite history"); firing
 * that off the CWE-798 label alone — with no real credential present —
 * mortified a partner demo when the specialist hallucinated a secret (it
 * misread a `.length` COUNT as a leak).
 *
 * This fallback NEVER asserts compromise. It still tells a genuine secret
 * to rotate, but conditioned on the reader first confirming it IS one — so
 * even a detector miss can't fully drop the guidance.
 */
export const SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED =
  "If this value is an actual credential, treat it as compromised — revoke/rotate it, move it to a secret store or environment variable, and purge it from history. First confirm it is a real secret (not a hash, a length/identifier, a placeholder, or another non-sensitive value)."

/**
 * SIG-282 Phase 3: the deterministic remediation for a finding, or null
 * when it isn't a security finding with a resolvable CWE bucket (then the
 * renderer falls back to whatever the finding body already says).
 *
 * Believability gate (secret-remediation): for the `secrets-exposure`
 * bucket ONLY, the alarmist "treat as compromised / rewrite history" text
 * is gated on a real credential signal. `citedLineText` is the cited
 * added-line(s) text at the finding's location (threaded from the render
 * site, where `addedLineTextByLine` is already in scope). When that text
 * contains a credential-like token (reusing `secret-scan`'s vetted
 * detector), the full alarmist remediation is kept; otherwise the
 * de-alarmed conditional remediation is returned instead.
 *
 * Back-compat: `citedLineText` is OPTIONAL. When omitted (existing
 * callers / tests that don't thread cited text), a `secrets-exposure`
 * finding gets the de-alarmed conditional text — never a confident
 * assertion of compromise we cannot back with the cited code. Every OTHER
 * bucket is UNCHANGED regardless of `citedLineText`. Non-security findings
 * still return null.
 */
export function remediationForFinding(
  finding: PrReviewFinding,
  citedLineText?: string,
): string | null {
  if (finding.category !== "security") return null
  const bucket = deriveSecurityBucket(finding)
  if (!bucket) return null
  if (bucket === "secrets-exposure") {
    return containsCredentialToken(citedLineText ?? "")
      ? REMEDIATION_BY_BUCKET["secrets-exposure"]
      : SECRETS_EXPOSURE_REMEDIATION_UNVERIFIED
  }
  return REMEDIATION_BY_BUCKET[bucket]
}

/**
 * Result of evaluating one in-scope security finding. `keep:true` may
 * carry `enrich` — the manifest fact's evidenceId/cwe the orchestrator
 * should stamp onto the finding (auto-enrich path). `keep:false`
 * carries a structured reason for telemetry.
 */
export type SecurityFindingDecision =
  | { keep: true; enrich?: { evidenceId: string; cweId?: string } }
  | { keep: false; reason: SecurityDropReason }

export type SecurityDropReason =
  | "fabricated-evidence-id" // cited evidenceId doesn't resolve in the manifest
  | "evidence-out-of-range" // cited fact resolves but its line is >+/-10 away
  | "evidence-class-mismatch" // SIG-325: cited/enriched fact's CWE bucket differs from the finding's claimed class (cross-class laundering)
  | "authz-none-without-justification" // NONE exemption without a body justification
  | "unsupported-scanner-covered" // sev>=4 in a scanner-covered bucket, no cwe + no auto-enrich match
  | "do-method-authz-trust-boundary" // SIG-141: authz finding on a DurableObject method — the binding is the trust boundary

/**
 * SIG-282: why an analyst false-positive dismissal was NOT accepted.
 */
export type ScanFactDismissalReason =
  | "unknown-evidence-id" // evidenceId doesn't resolve in the manifest
  | "not-dismissible" // high-confidence provider hit — a real secret must not be waved off
  | "missing-justification" // no concrete code-grounded reason supplied

export type ScanFactDismissalDecision =
  | { accepted: true; ruleId: string | null }
  | { accepted: false; reason: ScanFactDismissalReason; ruleId: string | null }

/** Minimum chars for a dismissal reason to count as a justification. */
const DISMISSAL_JUSTIFICATION_MIN_CHARS = 12

/**
 * SIG-282: is this deterministic fact one the analyst (LLM) may refute as
 * a false positive? Only the noisy secret-scan candidate — the `warn`-
 * severity generic catch-all. High-confidence provider hits
 * (aws/github/stripe/… → `error` severity) are NEVER dismissible: a real
 * `AKIA…` / `sk-…` key must not be waved off by judgment.
 */
export function isDismissibleFact(fact: SecurityFact): boolean {
  return fact.tool === "secret" && fact.severity === "warn"
}

/**
 * SIG-282: evaluate ONE analyst false-positive dismissal of a scan fact.
 * Pure; the orchestrator emits telemetry and (shadow-first) decides what
 * to do. Accepted only when the evidenceId resolves, the fact is
 * dismissible, and a concrete reason is supplied.
 */
export function evaluateScanFactDismissal(
  dismissal: ScanFactDismissal,
  manifest: Map<string, SecurityFact>,
): ScanFactDismissalDecision {
  const fact = manifest.get((dismissal.evidenceId ?? "").trim())
  if (!fact) return { accepted: false, reason: "unknown-evidence-id", ruleId: null }
  const ruleId = fact.ruleId ?? null
  if (!isDismissibleFact(fact)) return { accepted: false, reason: "not-dismissible", ruleId }
  if ((dismissal.reason ?? "").trim().length < DISMISSAL_JUSTIFICATION_MIN_CHARS) {
    return { accepted: false, reason: "missing-justification", ruleId }
  }
  return { accepted: true, ruleId }
}

/**
 * Pure decision for ONE security-applicable finding. The caller has
 * already decided this finding's derived role set includes `security`;
 * this helper only applies the evidence rule. Mode-agnostic — the
 * orchestrator gates the drop behind shadow/enforce.
 *
 * Contract (deepseek §2):
 *   - score < 4 security findings always pass (the evidence
 *     requirement is sev>=4 only; lower-severity hardening notes don't
 *     need a deterministic fact).
 *   - evidenceId === "NONE": allowed ONLY for the authz bucket WITH a
 *     body justification. Other buckets: fall through to the
 *     scanner-covered / auto-enrich logic (NONE is treated as "no id
 *     supplied").
 *   - evidenceId present (not NONE): must resolve in the manifest AND
 *     the fact's path must equal the finding's path AND the fact's
 *     line must be within +/-10 of the finding's line AND (SIG-325) the
 *     fact's CWE bucket must not PROVABLY differ from the finding's
 *     claimed class. Else reject (evidence-out-of-range / -class-mismatch).
 *   - evidenceId absent: try auto-enrich (a manifest fact at the same
 *     path within +/-10 lines whose class is not provably different —
 *     SIG-325). On match → keep + enrich. On no match: authz bucket with
 *     justification → keep; otherwise reject as unsupported-scanner-covered.
 */
export function evaluateSecurityFinding(
  finding: PrReviewFinding,
  manifest: Map<string, SecurityFact>,
): SecurityFindingDecision {
  // Evidence requirement is severity-gated: only sev>=4 security
  // findings must be corroborated. Lower-severity hardening notes pass
  // untouched (deepseek scopes the rule to sev>=4).
  if (finding.score < 4) return { keep: true }

  const bucket = deriveSecurityBucket(finding)
  const rawEvidenceId = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""

  // ── evidenceId === "NONE" ────────────────────────────────────────
  // The authz exemption: real IDOR/authz bugs no scanner detects. Keep
  // only when the bucket is authn-access-control AND the body carries
  // a non-trivial justification. For any other bucket, NONE is treated
  // as "no id" — fall through to auto-enrich / scanner-covered.
  if (rawEvidenceId === "NONE") {
    // `evidenceId:"NONE"` is the access-control/IDOR exemption: a bug no
    // scanner can detect. CR-2 (CodeRabbit): restrict it to the CONFIRMED
    // authz bucket. H1 expanded that bucket with the real IDOR/authz CWEs
    // (639/285/284/306/...), and the prompt now lists them, so a genuine
    // authz finding maps here via its CWE. An UNbucketed NONE (no/unmapped
    // cweId) is therefore more likely a hallucination than a real IDOR —
    // honoring it would widen the escape hatch to any sev>=4 security
    // finding with 40 chars of body. So a non-authz (incl. unbucketed)
    // NONE falls through to auto-enrich / scanner-covered below.
    if (bucket === AUTHZ_BUCKET) {
      return hasJustification(finding.body)
        ? { keep: true }
        : { keep: false, reason: "authz-none-without-justification" }
    }
    // Non-authz / unbucketed NONE → treat as no usable id; fall through.
  } else if (rawEvidenceId.length > 0) {
    // ── explicit evidenceId — cross-check against the manifest ──────
    const fact = manifest.get(rawEvidenceId)
    if (!fact) {
      // Cited an id that doesn't exist → fabricated. Hard reject.
      return { keep: false, reason: "fabricated-evidence-id" }
    }
    if (!factMatchesFinding(fact, finding)) {
      // Real id but pointed at a different file/line than the finding
      // claims → non-linking. Hard reject (anti-fabrication + relevance).
      return { keep: false, reason: "evidence-out-of-range" }
    }
    // SIG-325: the cited fact must corroborate the finding's vulnerability
    // CLASS, not merely sit at the same line. A CWE-22/CWE-918 claim citing a
    // nearby CWE-798 secret-scan fact is laundering a fabricated mechanism
    // through a real id — reject it (the finding then has no backing, so it
    // falls to unsupported / the SIG-325 refutation-survival gate). Bucket-
    // level so a same-family CWE relabel (SIG-282) still corroborates.
    if (!factClassCompatible(fact, finding)) {
      return { keep: false, reason: "evidence-class-mismatch" }
    }
    // Resolved + relevant + same class. Enrich the cwe from the fact when the
    // finding lacks one so downstream consumers see a bucket.
    if (!finding.cweId && fact.cwe) {
      return { keep: true, enrich: { evidenceId: fact.evidenceId, cweId: fact.cwe } }
    }
    return { keep: true }
  }

  // ── no usable evidenceId — try auto-enrich ─────────────────────────
  // Find a manifest fact at the same path within +/-10 lines. This
  // rescues a corroborated finding the model forgot to cite.
  const match = findEnrichingFact(finding, manifest)
  if (match) {
    return match.cwe
      ? { keep: true, enrich: { evidenceId: match.evidenceId, cweId: match.cwe } }
      : { keep: true, enrich: { evidenceId: match.evidenceId } }
  }

  // No id, no auto-enrich match. The authz bucket may still pass on a
  // justification alone (logic-only IDOR with no scanner fact). Every
  // other (scanner-covered or unknown) bucket is an unsupported sev>=4
  // claim → reject.
  if (bucket === AUTHZ_BUCKET && hasJustification(finding.body)) {
    return { keep: true }
  }
  return { keep: false, reason: "unsupported-scanner-covered" }
}

/**
 * A manifest fact corroborates a finding when it names the same file
 * AND sits within +/-10 lines (or is a path-only fact, in which case
 * the path match alone suffices — dep-vuln / IaC findings have no
 * diff line).
 */
function factMatchesFinding(fact: SecurityFact, finding: PrReviewFinding): boolean {
  if (fact.path !== finding.path) return false
  if (fact.line === null) return true
  return Math.abs(fact.line - finding.line) <= EVIDENCE_LINE_TOLERANCE
}

/**
 * SIG-325: a fact CORROBORATES a finding's vulnerability CLASS unless we can
 * PROVE the two belong to different security buckets. Returns false ONLY when
 * BOTH the finding's bucket AND the fact's CWE bucket are known and differ —
 * the laundering shape where e.g. a CWE-22 path-traversal claim borrows a
 * nearby CWE-798 secret-scan fact to satisfy the evidence gate. When either
 * side's bucket is unknown (the fact has no CWE, or carries a CVE/non-CWE id;
 * or the finding has no usable cweId — the "model forgot the id" auto-enrich
 * case) we cannot prove a mismatch, so we allow it. FN-safe: only PROVABLE
 * cross-class corroboration is blocked.
 *
 * Granularity is the bucket, not the exact CWE id, which preserves SIG-282's
 * allowance for the specialist to adopt a different CWE within the same family
 * than the scanner proposed (e.g. a CWE-862 finding citing a CWE-863 fact —
 * both authn-access-control — still corroborates).
 */
function factClassCompatible(fact: SecurityFact, finding: PrReviewFinding): boolean {
  const findingBucket = deriveSecurityBucket(finding)
  if (!findingBucket) return true
  const factCwe = typeof fact.cwe === "string" ? fact.cwe.trim().toUpperCase() : ""
  const factBucket = factCwe ? CWE_TO_BUCKET[factCwe] : undefined
  if (!factBucket) return true
  return factBucket === findingBucket
}

/**
 * Scan the manifest for the fact that best corroborates the finding for
 * the AUTO-ENRICH path (the model omitted the id). M1/Codex-M2 (review):
 * auto-enrich is stricter than an explicit citation because the model
 * didn't actually point at this fact —
 *   - path-only facts (`line === null`, e.g. every dep-vuln on a
 *     manifest file) are SKIPPED: otherwise any hallucinated finding on
 *     that path would silently borrow a real id and look corroborated.
 *     An explicit citation may still resolve to a path-only fact (the
 *     model deliberately named it); auto-enrich may not.
 *   - among line-bearing matches within +/-10, pick the CLOSEST line so
 *     a finding doesn't grab an unrelated nearby fact's id when a better
 *     match exists.
 *   - SIG-325: skip facts whose CWE bucket is PROVABLY different from the
 *     finding's claimed class. Otherwise a fabricated CWE-22/CWE-918 finding
 *     auto-enriches against any nearby secret-scan (CWE-798) fact and looks
 *     corroborated — the cross-class laundering hole. When the finding has no
 *     usable cweId (the canonical "model forgot the id" case) its bucket is
 *     unknown, so `factClassCompatible` allows the enrich as before.
 */
function findEnrichingFact(
  finding: PrReviewFinding,
  manifest: Map<string, SecurityFact>,
): SecurityFact | null {
  let best: SecurityFact | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const fact of manifest.values()) {
    if (fact.path !== finding.path) continue
    if (fact.line === null) continue // skip path-only facts for auto-enrich
    if (!factClassCompatible(fact, finding)) continue // SIG-325: no cross-class enrich
    const distance = Math.abs(fact.line - finding.line)
    if (distance <= EVIDENCE_LINE_TOLERANCE && distance < bestDistance) {
      best = fact
      bestDistance = distance
    }
  }
  return best
}

/**
 * A NONE-exemption body counts as a justification when it's
 * non-trivially long. Real authz justifications explain why no
 * scanner can detect the flaw ("missing object-level authorization
 * check, no static pattern exists"); a stub body isn't enough.
 */
function hasJustification(body: string | undefined): boolean {
  return typeof body === "string" && body.trim().length >= AUTHZ_JUSTIFICATION_MIN_CHARS
}
