// SIG-285 v2 PR1 — receipt-join verification (shadow, NO new GitHub permission).
//
// The companion to verify-finding.ts's worker-token check. Where THAT re-checks
// a finding's cited token against the PR DIFF, this re-checks a scanner-
// corroborated security finding against the deterministic scan the SIG-184
// runner ALREADY ran on HEAD (the verified receipt's SARIF). No dispatch, no
// subprocess, no new permission — the receipt SARIF is already ingested +
// integrity-checked; this just JOINS the bot's finding to it.
//
// THE SOUND MODEL (validated 2026-05-31, 5-agent adversarial workflow):
//   - CONFIRMED    — the SAME rule-class that produced this finding's cited
//                    fact STILL fires at the finding's path + (windowed) line in
//                    HEAD's scan. A trust-pill signal ("verified against HEAD").
//                    CONFIRMED NEVER elevates a finding (DeepSeek §2 — else the
//                    runner becomes a new false-positive source).
//   - INCONCLUSIVE — no matching scan result. CRITICAL: absence is OVER-
//                    DETERMINED — a result can be missing because the rule
//                    didn't fire, OR the diff-line filter / 200-finding cap /
//                    severity-config drop / secret-redaction dropped it, OR the
//                    rule isn't in the runner's ruleset, OR (the commit-basis
//                    blocker) the merge-anchored SARIF line ≠ the HEAD-anchored
//                    finding line. So absence is NEVER a refutation here. This
//                    module emits NO `refuted` verdict — sound REFUTED needs the
//                    PR4 work (merge→head line remap + un-filtered/un-capped
//                    join + ruleset-version pin). FN-cost >> FP-cost.
//   - NO-CHECK     — the finding isn't receipt-join-eligible (not a sev>=4
//                    security finding with a resolvable evidenceId), or no
//                    receipt was available.
//
// Shadow/measure-only: the ensemble emits a `verification-receiptjoin` event
// keyed by `findingKey` (the SIG-114 join). PR2 reads the CONFIRMED/INCONCLUSIVE
// split = the refutable-eligible fraction, the load-bearing unknown that decides
// whether the demote path (PR4/5) is worth building vs receipts-as-trust.
//
// Pure + side-effect-free (like verify-finding.ts) so it is trivially testable.

import type { PrReviewFinding } from "../triage-pr-review"
import type { SarifRun } from "@/features/sarif-evidence"
import { findingKey, type VerificationCheck, type VerificationResult } from "./verify-finding"

export { findingKey }

/**
 * Receipt-join gate mode. `off` (default): the gate doesn't run. `shadow`:
 * compute + telemeter the verdict, no behavior change. `enforce`: reserved —
 * PR1 treats it as shadow (demotion is PR4/5, gated on the data). Read from
 * `OPENCLAW_RECEIPTJOIN_MODE`. Three-state with `off` default, matching the
 * other gates' idiom.
 */
export type ReceiptJoinMode = "off" | "shadow" | "enforce"

export function parseReceiptJoinMode(raw: string | undefined): ReceiptJoinMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/**
 * The minimal slice of a receipt SARIF result this join needs. The ensemble
 * builds these from the verified receipt's UN-FILTERED, UN-CAPPED parseSarif
 * output (NOT runSarifEvidence's diff/severity-filtered findings — a filtered-
 * out result would read as a false absence). `path` MUST be pre-normalized with
 * the same `normalizeSarifPath` the bot finding path is expressed in.
 */
export interface ReceiptScanResult {
  /** Pre-normalized repo-relative path. */
  path: string
  /** SARIF ruleId. */
  ruleId: string
  /** 1-based line, or undefined for path-only (IaC/dep) results. */
  line?: number
}

/** Line drift absorbed around a result before a same-line match fails. The
 *  receipt SARIF is MERGE-commit-anchored while the finding is HEAD-anchored
 *  (the commit-basis blocker), so an exact-line match would under-confirm; a
 *  window keeps CONFIRMED a true SUPERSET signal. PR4 replaces this with a real
 *  merge→head line remap. Generous on purpose: a false INCONCLUSIVE is FN-safe
 *  (no demotion happens here); a false CONFIRMED is just a slightly-too-eager
 *  trust pill, which the rule-class match below still bounds. */
const LINE_WINDOW = 10

/**
 * The subset of `normalizeSarifPath` the extractor needs — injected so this
 * module stays runtime-decoupled from sarif-evidence (the ensemble passes the
 * real one; tests pass a stub). Mirrors NormalizeArgs (uriBaseId / index /
 * artifacts) so a receipt result that resolves its path via an artifacts index
 * or a `%SRCROOT%` base — not an inline uri — still resolves.
 */
export type SarifPathNormalizer = (
  uri: string | undefined,
  opts: {
    uriBaseId?: string
    index?: number
    // Mutable to match normalizeSarifPath's NormalizeArgs (param contravariance).
    artifacts?: Array<{ location?: { uri?: string } }>
  },
) => { ok: true; path: string } | { ok: false; reason: string }

/**
 * Map parsed SARIF runs → the receipt scan-result list (path / ruleId / line),
 * the input to `buildReceiptIndex`. Pure (the path normalizer is injected), so
 * the SARIF→index extraction is unit-testable without the sarif-evidence
 * runtime or the whole ensemble. Drops rule-less results; mirrors runner.ts path
 * resolution (uriBaseId / index / run.artifacts) so the index path form matches
 * the bot findings'.
 */
export function extractReceiptScanResults(
  runs: ReadonlyArray<SarifRun>,
  normalizePath: SarifPathNormalizer,
): ReceiptScanResult[] {
  const out: ReceiptScanResult[] = []
  for (const run of runs) {
    for (const res of run.results ?? []) {
      const ruleId = typeof res.ruleId === "string" ? res.ruleId.trim() : ""
      if (ruleId.length === 0) continue
      for (const loc of res.locations ?? []) {
        const artLoc = loc.physicalLocation?.artifactLocation
        const norm = normalizePath(artLoc?.uri, {
          ...(artLoc?.uriBaseId !== undefined ? { uriBaseId: artLoc.uriBaseId } : {}),
          ...(artLoc?.index !== undefined ? { index: artLoc.index } : {}),
          ...(run.artifacts ? { artifacts: run.artifacts } : {}),
        })
        if (!norm.ok) continue
        const startLine = loc.physicalLocation?.region?.startLine
        out.push(
          typeof startLine === "number"
            ? { path: norm.path, ruleId, line: startLine }
            : { path: norm.path, ruleId },
        )
      }
    }
  }
  return out
}

/** Index the receipt results by normalized path for O(1)-per-finding lookup. */
export function buildReceiptIndex(
  results: ReadonlyArray<ReceiptScanResult>,
): Map<string, ReceiptScanResult[]> {
  const index = new Map<string, ReceiptScanResult[]>()
  for (const r of results) {
    if (typeof r.path !== "string" || r.path.length === 0) continue
    const list = index.get(r.path)
    if (list) list.push(r)
    else index.set(r.path, [r])
  }
  return index
}

/**
 * Extract the rule-id segment from a SIG-108 evidenceId (`tool:rule-id:content-
 * hash:line`). Best-effort: the rule-id is segment[1]; semgrep rule ids use
 * dots (not colons) so this is stable for the common case. Returns null when
 * the shape isn't recognizable — the caller then treats the finding as not
 * rule-identifiable → INCONCLUSIVE (never a guess).
 */
export function ruleIdFromEvidenceId(evidenceId: string): string | null {
  const parts = evidenceId.split(":")
  if (parts.length < 2) return null
  const ruleId = parts[1]?.trim()
  return ruleId && ruleId.length > 0 ? ruleId : null
}

/**
 * Do the finding's cited rule-id and a receipt result's ruleId name the SAME
 * rule-class? Normalized (lowercase) equality OR either-contains-the-other (the
 * receipt SARIF may namespace the id, e.g. `semgrep.<id>` vs `<id>`). A
 * non-match → not the same check → does NOT confirm (the result is a different
 * rule firing nearby; confirming on it would be unsound).
 */
function ruleClassMatches(findingRuleId: string, sarifRuleId: string): boolean {
  const a = findingRuleId.trim().toLowerCase()
  const b = sarifRuleId.trim().toLowerCase()
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Is this finding receipt-join-eligible? Only a sev>=4 security finding that
 * carries a resolvable evidenceId (the SIG-108 scanner-corroboration id, not
 * the authz `NONE` sentinel) — i.e. the finding IS a deterministic rule's own
 * output, the only population where "the same rule re-runs on HEAD" is a sound
 * question. Everything else (logic / authz-NONE / no evidence) → NO-CHECK.
 */
export function isReceiptJoinEligible(
  finding: Pick<PrReviewFinding, "score" | "category" | "evidenceId">,
): boolean {
  if (typeof finding.score !== "number" || finding.score < 4) return false
  if (finding.category !== "security") return false
  const id = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""
  return id.length > 0 && id !== "NONE"
}

/**
 * Pure receipt-join verdict for ONE finding against the HEAD-scan index.
 * Mode-agnostic, never throws, no I/O. Emits only confirmed | inconclusive |
 * no-check (NEVER refuted — see the file header). The caller (ensemble) gates
 * the whole thing behind OPENCLAW_RECEIPTJOIN_MODE and only telemeters in PR1.
 */
export function verifyFindingAgainstReceipt(
  finding: Pick<PrReviewFinding, "path" | "line" | "headline" | "score" | "category" | "evidenceId">,
  receiptIndex: Map<string, ReceiptScanResult[]>,
): VerificationResult {
  if (!isReceiptJoinEligible(finding)) {
    return { verdict: "no-check", tokens: [] }
  }
  const findingRuleId = ruleIdFromEvidenceId(finding.evidenceId as string)
  if (findingRuleId === null) {
    // Eligible but the rule-id isn't extractable — can't ask the sound question.
    return { verdict: "inconclusive", tokens: [], check: receiptCheck("skipped", "evidenceId rule-id unparsable", "") }
  }

  const candidates = receiptIndex.get(finding.path) ?? []
  for (const r of candidates) {
    if (!ruleClassMatches(findingRuleId, r.ruleId)) continue
    // Path-only result (no line) → path+rule match confirms. Line-bearing →
    // require the finding's line within the window (merge/head drift absorbed).
    const lineOk =
      r.line === undefined ||
      (typeof finding.line === "number" && Math.abs(r.line - finding.line) <= LINE_WINDOW)
    if (lineOk) {
      return {
        verdict: "confirmed",
        tokens: [findingRuleId],
        check: receiptCheck("pass", `receipt-join --rule ${findingRuleId} --path ${finding.path} --line ${finding.line}`, `rule ${r.ruleId}${r.line !== undefined ? ` @${r.line}` : " (path-only)"}`),
      }
    }
  }

  // No same-rule result at this path/line on HEAD. Absence is OVER-DETERMINED →
  // INCONCLUSIVE, NEVER refuted (the candidate-refutable population PR2 counts).
  return {
    verdict: "inconclusive",
    tokens: [findingRuleId],
    check: receiptCheck("fail", `receipt-join --rule ${findingRuleId} --path ${finding.path} --line ${finding.line}`, "no same-rule result at path/line on HEAD"),
  }
}

function receiptCheck(
  status: "pass" | "fail" | "error" | "skipped",
  descriptor: string,
  outputSnippet: string,
): VerificationCheck {
  return { kind: "receipt-join", descriptor, status, outputSnippet }
}
