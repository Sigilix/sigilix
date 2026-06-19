// SIG-184 Phase 3 (VERIFIED corroboration bridge) — the shared canonical
// vulnerability-class taxonomy. A finding earns the `runner-confirmed` (VERIFIED)
// tier only when BOTH (a) Sigilix derives this class for the finding from a
// DETERMINISTIC signal (an AST rule-id or a CWE — never LLM free-text), AND (b)
// an independent, forge-proof-signed runner scan flagged the SAME class at the
// SAME path/line. The runner (`.github/scripts/sigilix_sarif_contract.py`) stamps
// these exact string literals onto its SARIF results as `properties.sigilixRuleClass`;
// keep the two lists in lockstep (this file is the source of truth).
//
// Pure leaf: no imports, no IO — importable from both the verification layer and
// any future renderer.

export type CanonicalVulnClass =
  | "command-injection"
  | "code-injection"
  | "sql-injection"
  | "nosql-injection"
  | "path-traversal"
  | "ssrf"
  | "xxe"
  | "ssti"
  | "proto-pollution"
  | "open-redirect"
  | "hardcoded-secret"
  | "weak-random"

export const CANONICAL_VULN_CLASSES: ReadonlySet<CanonicalVulnClass> = new Set<CanonicalVulnClass>([
  "command-injection",
  "code-injection",
  "sql-injection",
  "nosql-injection",
  "path-traversal",
  "ssrf",
  "xxe",
  "ssti",
  "proto-pollution",
  "open-redirect",
  "hardcoded-secret",
  "weak-random",
])

/**
 * Narrow an untrusted string to a `CanonicalVulnClass`, or `null`. Used to
 * validate the runner-supplied `properties.sigilixRuleClass` against the
 * allowlist — an unknown/garbage value is dropped (never trusted), so a
 * mis-stamped or attacker-smuggled class can't produce a false VERIFIED.
 */
export function asCanonicalVulnClass(value: string | undefined): CanonicalVulnClass | null {
  return value !== undefined && (CANONICAL_VULN_CLASSES as ReadonlySet<string>).has(value)
    ? (value as CanonicalVulnClass)
    : null
}
