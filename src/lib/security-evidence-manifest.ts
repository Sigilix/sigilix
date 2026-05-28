// SIG-108: security-specialist evidence manifest.
//
// Why this exists:
//   SIG-113 closed the testing-completeness false-positive class by
//   pairing a deterministic evidence pack with a post-LLM citation
//   gate. SIG-108 is the security analogue: the security specialist
//   tends to assert sev≥4 vulnerabilities ("hardcoded credential",
//   "SQL injection") that no deterministic scanner corroborates. This
//   module turns the role-scoped deterministic security facts (secret
//   scan, dep-vuln, SARIF, AST-security) into a manifest of
//   hard-to-fabricate `evidenceId`s the specialist must cite, and the
//   validator (`validateSecurityFinding`) cross-checks each citation
//   against this manifest before a finding reaches the customer.
//
// ID scheme (deepseek §2 — hard to fabricate, easy to validate):
//   `tool:rule-id:content-hash:line`, where the content hash is the
//   first 12 hex of SHA-256 over the fact's stable fields. The LLM
//   cannot guess a valid id without having actually seen the fact in
//   the [SECURITY EVIDENCE MANIFEST] block — so a fabricated id fails
//   the manifest lookup and the finding is dropped (in enforce mode).
//
// False-negative safety lives in the validator, NOT here: real
//   IDOR/authz bugs that no scanner detects legitimately carry
//   `evidenceId === "NONE"` + a body justification. This module only
//   surfaces the facts that DO exist; the validator decides how to
//   treat a finding that cites none of them.

import type { SecretHit } from "./secret-scan"
import type { DepVulnFinding } from "./dep-vulns/scanner"
import type { SarifFinding } from "./sarif-evidence/types"
import type { AstFinding } from "./ast-rules/types"

/**
 * One deterministic security fact, keyed by its `evidenceId`. The
 * validator looks the id up here and cross-checks the fact's
 * `path`/`line` against the finding's (anti-fabrication + relevance).
 */
export interface SecurityFact {
  /** `tool:rule-id:content-hash:line` — copied verbatim into a
   *  finding's `evidenceId` field. */
  evidenceId: string
  /** Source tool: "secret" | "depvuln" | "sarif" | "ast". */
  tool: "secret" | "depvuln" | "sarif" | "ast"
  /** Repo-relative file path the fact anchors to. */
  path: string
  /** 1-based line, or null for path-only facts (some dep-vuln /
   *  IaC SARIF findings have no line). */
  line: number | null
  /** CWE id when the fact carries one (e.g. "CWE-798" for a hardcoded
   *  secret). Absent for facts with no deterministic CWE mapping. */
  cwe?: string
  /** SIG-282: source rule id (e.g. "generic-high-entropy-token",
   *  "aws-access-key"). Lets the validator scope which facts the analyst
   *  may refute as false positives. Absent for non-secret facts. */
  ruleId?: string
  /** SIG-282: scanner confidence for secret facts. "warn" = the noisy
   *  generic catch-all (analyst-refutable); "error" = a high-confidence
   *  provider hit (NEVER refutable). Absent for non-secret facts. */
  severity?: "warn" | "error"
  /** One-line human summary rendered in the manifest block. */
  summary: string
}

export interface SecurityFactManifest {
  /** evidenceId → fact. The validator's source of truth. */
  manifest: Map<string, SecurityFact>
  /**
   * Render the `[SECURITY EVIDENCE MANIFEST]` block appended to the
   * security specialist's facts. Returns "" when the manifest is
   * empty (omit-when-empty contract, like the other fact renderers).
   */
  render(): string
}

/**
 * SHA-256 → first `length` hex chars. Mirrors `indexer.ts`'s
 * `sha256HexPrefix`. Async because Workers only exposes
 * `crypto.subtle.digest`.
 */
async function sha256HexPrefix(input: string, length: number): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return hex.slice(0, length)
}

const CONTENT_HASH_HEX = 12

/**
 * Map a secret-scan rule to a CWE. Hardcoded credentials are CWE-798
 * (use of hardcoded credentials) across the board — the rule id
 * distinguishes WHICH credential, not the weakness class.
 */
const SECRET_CWE = "CWE-798"

/**
 * Build the security fact manifest from the role-scoped deterministic
 * facts. Async (the content hash uses `crypto.subtle.digest`).
 *
 * The orchestrator builds this right after the role-scoped fact
 * blocks, appends `render()` to `securityFactsBlock`, and keeps the
 * returned `manifest` Map in scope to pass to `validateForSubmission`
 * at validation time — mirroring how SIG-113 threads the testing
 * pack.
 *
 * Pure aside from hashing — no I/O. The fact inputs are exactly the
 * ones the security specialist already sees rendered (secret hits,
 * dep-vuln findings, SARIF findings, AST findings with
 * `roleHint === "security"`); this layer adds the citable ids on top.
 */
export async function buildSecurityFactManifest(args: {
  secretHits: readonly SecretHit[]
  depVulnFindings: readonly DepVulnFinding[]
  sarifFindings: readonly SarifFinding[]
  /** Pre-filtered to `roleHint === "security"` by the caller. */
  astSecurityFindings: readonly AstFinding[]
}): Promise<SecurityFactManifest> {
  const manifest = new Map<string, SecurityFact>()

  for (const h of args.secretHits) {
    // Stable fields: rule + path + line + redacted preview. The raw
    // secret never enters the hash input (it never leaves the runner).
    const hash = await sha256HexPrefix(
      `secret|${h.ruleId}|${h.path}|${h.line}|${h.redactedPreview}`,
      CONTENT_HASH_HEX,
    )
    const evidenceId = `secret:${h.ruleId}:${hash}:${h.line}`
    manifest.set(evidenceId, {
      evidenceId,
      tool: "secret",
      path: h.path,
      line: h.line,
      cwe: SECRET_CWE,
      // SIG-282: carry rule id + severity so the validator can decide
      // which candidates the analyst may refute (warn-level only).
      ruleId: h.ruleId,
      severity: h.severity,
      // L1 (code review): normalize so no embedded newline in an
      // untrusted field can forge a `- \`fake-id\`` manifest line.
      summary: normalizeSummary(`${h.category}/${h.ruleId} at ${h.path}:${h.line} (preview ${h.redactedPreview})`),
    })
  }

  for (const f of args.depVulnFindings) {
    // Dep-vuln facts are path-anchored (the manifest file) but have no
    // diff line. Stable fields: advisory + package@version + path.
    const hash = await sha256HexPrefix(
      `depvuln|${f.advisory_id}|${f.package_name}|${f.version}|${f.source_path}`,
      CONTENT_HASH_HEX,
    )
    const evidenceId = `depvuln:${f.advisory_id}:${hash}`
    manifest.set(evidenceId, {
      evidenceId,
      tool: "depvuln",
      path: f.source_path,
      line: null,
      summary: normalizeSummary(`${f.advisory_id} in ${f.package_name}@${f.version} (${f.severity}): ${f.summary}`),
    })
  }

  for (const f of args.sarifFindings) {
    const line = typeof f.line === "number" ? f.line : null
    const hash = await sha256HexPrefix(
      `sarif|${f.ruleId}|${f.path}|${line ?? ""}|${f.message}`,
      CONTENT_HASH_HEX,
    )
    // Path-only SARIF findings render without the trailing `:line`.
    const evidenceId = line === null
      ? `sarif:${f.ruleId}:${hash}`
      : `sarif:${f.ruleId}:${hash}:${line}`
    manifest.set(evidenceId, {
      evidenceId,
      tool: "sarif",
      path: f.path,
      line,
      summary: normalizeSummary(`${f.toolName}/${f.ruleId} (${f.category}) at ${f.path}${line === null ? "" : `:${line}`}: ${f.message}`),
    })
  }

  for (const f of args.astSecurityFindings) {
    // AST findings already carry a stable `astFindingId`; reuse it as
    // the content-addressed component so two scans of the same hit
    // produce the same evidenceId.
    const evidenceId = `ast:${f.ruleId}:${f.astFindingId}`
    manifest.set(evidenceId, {
      evidenceId,
      tool: "ast",
      path: f.path,
      line: f.line,
      summary: `${f.ruleId} at ${f.path}:${f.line}: ${normalizeSummary(f.message)}`,
    })
  }

  return {
    manifest,
    render: () => renderManifest(manifest),
  }
}

/**
 * Collapse whitespace runs to single spaces so a multi-line message
 * doesn't split a manifest line. Mirrors `ast-rules/render.ts`'s
 * `normalizePromptScalar`.
 */
function normalizeSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function renderManifest(manifest: Map<string, SecurityFact>): string {
  if (manifest.size === 0) return ""
  const lines: string[] = [
    "[SECURITY EVIDENCE MANIFEST — scanner-proposed candidates; the CWE is a PROPOSED classification, not a verdict]",
    "Each id below is a deterministic scanner hit with a PROPOSED CWE. The classification is a hypothesis to verify against the code, not an established fact. When you CONFIRM a sev>=4 security finding, copy the matching id VERBATIM into the finding's `evidenceId` to corroborate it. Inventing an id is rejected by the validator. For an access-control / IDOR / authz bug that NO scanner can detect, set `evidenceId: \"NONE\"` and justify in the body why no deterministic check exists.",
    "",
  ]
  for (const fact of manifest.values()) {
    const loc = fact.line === null ? fact.path : `${fact.path}:${fact.line}`
    const cwe = fact.cwe ? ` [proposed ${fact.cwe}]` : ""
    lines.push(`- \`${fact.evidenceId}\` — ${loc}${cwe}: ${fact.summary}`)
  }
  return lines.join("\n").trimEnd()
}
