// SIG-109: logic-finding evidence gate.
//
// The logic analogue of SIG-108's `evaluateSecurityFinding` and
// SIG-111's `evaluateTestFinding`. A sev>=4 `logic`-sourced finding is
// KEPT when it is concretely anchored to the diff; only a vague,
// unanchored sev>=4 logic claim is rejected.
//
// FALSE-NEGATIVE SAFETY (the crux — biases HARD toward KEEP):
//   Logic bugs are LLM-found. Unlike security (scanner facts) or tests
//   (sibling/coverage evidence), MOST real logic findings have NO
//   deterministic backing — an off-by-one, a swapped argument, a broken
//   invariant, a wrong operator. A naive "every sev>=4 logic finding
//   must carry deterministic evidence" rule would drop exactly the
//   high-value LLM-only findings this lens exists to surface (the SIG-108
//   review caught real findings being dropped). So this gate uses a
//   broad evidence bar:
//     KEEP a sev>=4 logic finding when it has a concrete `path` that is
//     a CHANGED file AND ANY ONE of:
//       (a) a co-located deterministic AST-correctness hit (an
//           `ast/...` finding with roleHint logic at the same path,
//           within +/-a few lines) — auto-match, like SIG-108's
//           auto-enrich, OR
//       (b) a backticked token in the headline/body that appears in the
//           ADDED-line TEXT of `finding.path` (the concrete-changed-
//           token check), OR
//       (c) (when available) a backticked CHANGED SYMBOL — but PR A has
//           no symbol inventory, so we never hard-drop solely for a
//           missing symbol. Symbol-based retrieval is SIG-121.
//     REJECT only when sev>=4 logic AND (no changed-path anchor) AND
//     (no concrete code token on added lines) — a vague, unanchored
//     claim.
//
// SHADOW-FIRST: the actual drop is gated behind
//   `OPENCLAW_LOGIC_VALIDATOR_MODE` (shadow | enforce, default shadow)
//   at the call site. In shadow the verdict is only counted/telemetered
//   — NEVER dropped. This module is pure and mode-agnostic; the
//   orchestrator decides what to do with the verdict.

import type { PrReviewFinding } from "./triage-pr-review"
import type { AstFinding } from "./ast-rules/types"

/**
 * Validator mode. `shadow` (default): emit telemetry counting what
 * WOULD be dropped, but keep every finding. `enforce`: actually drop
 * rejected findings.
 */
export type LogicValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_LOGIC_VALIDATOR_MODE`. Anything other than the literal
 * "enforce" (case-insensitive, trimmed) resolves to "shadow" — the
 * cautious default for a false-negative-sensitive gate's staged
 * rollout. Mirrors `parseSecurityValidatorMode` / `parseTestsValidatorMode`.
 */
export function parseLogicValidatorMode(raw: string | undefined): LogicValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/**
 * Lines within which a co-located AST hit must sit relative to the
 * finding's line to corroborate it. Kept tight (a few lines) — an AST
 * hit far from the finding isn't the same issue. Mirrors SIG-108's
 * line-tolerance idea but smaller (AST hits are precise).
 */
export const AST_COLOCATION_TOLERANCE = 5

/**
 * Result of evaluating one in-scope logic finding. `keep:false` carries
 * a structured reason for telemetry; `keep:true` is bare.
 */
export type LogicFindingDecision =
  | { keep: true }
  | { keep: false; reason: LogicDropReason }

export type LogicDropReason =
  | "missing-path" // sev>=4 logic finding with no concrete path to anchor
  | "unanchored-logic-claim" // sev>=4 logic on a non-changed path OR no concrete code token on added lines

/**
 * Evidence inputs threaded by the orchestrator (PR-A-contained — NO
 * symbol retrieval). Both default to empty so the gate no-ops for
 * callers that haven't wired them through (back-compat / staged
 * rollout).
 */
/**
 * Build the per-file ADDED-line text map from a unified diff: collect
 * the `+` lines (excluding the `+++ ` file header), strip the single
 * leading `+`, and key by the new-side path. Mirrors the path-parsing
 * of `buildChangedLines` (the line-NUMBER analogue) but captures TEXT
 * for the concrete-changed-token check. Pure + diff-only — NO symbol
 * retrieval (that's SIG-121). Defensive against a non-string input
 * (returns an empty map).
 */
export function buildAddedLineTextByPath(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!diff || typeof diff !== "string") return out

  let currentPath: string | null = null
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null
      continue
    }
    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).trim()
      if (newPath === "/dev/null") {
        currentPath = null
      } else {
        currentPath = newPath.startsWith("b/") ? newPath.slice(2) : newPath
        if (!out.has(currentPath)) out.set(currentPath, [])
      }
      continue
    }
    if (raw.startsWith("--- ")) continue
    if (currentPath === null) continue
    // An added content line starts with a single `+` but is NOT the
    // `+++ ` header (already handled above). Strip the leading `+`.
    if (raw.startsWith("+")) {
      out.get(currentPath)!.push(raw.slice(1))
    }
  }
  return out
}

export interface LogicEvidence {
  /**
   * Per-file ADDED-line text from the unified diff (the `+` lines with
   * the leading `+` stripped). Used for the concrete-changed-token
   * check: a backticked token in the finding must appear here. A path
   * present here (even with no usable token) is the CHANGED-PATH anchor.
   */
  addedLineTextByPath: ReadonlyMap<string, readonly string[]>
  /**
   * Deterministic AST findings already computed by the runner, filtered
   * to `roleHint === "logic"`. A finding co-located with one of these is
   * corroborated (the auto-match path).
   */
  astLogicFindings: readonly AstFinding[]
}

/**
 * Extract the distinct backticked tokens from a finding's headline +
 * body. The logic prompt instructs the model to reference identifiers
 * in backticks, so a concrete finding names one. Tokens are trimmed and
 * empties dropped. A token may itself contain code punctuation
 * (`arr[i]`, `getUser(id)`); the membership check below uses substring
 * containment so a backticked expression still matches the added-line
 * text it was lifted from.
 */
function backtickedTokens(finding: PrReviewFinding): string[] {
  const text = `${finding.headline ?? ""} ${finding.body ?? ""}`
  const out: string[] = []
  // Match the shortest run between a pair of backticks (non-greedy),
  // no control chars needed. `[^`]` excludes the delimiter itself.
  const re = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = m[1]!.trim()
    if (tok.length > 0) out.push(tok)
  }
  return out
}

/**
 * Does the finding's `path` appear in the changed-file set? An empty
 * `addedLineTextByPath` (gate not wired / docs-only PR) yields false for
 * every path — but the caller scopes the gate so an empty evidence set
 * means "no evidence to gate on", handled in `evaluateLogicFinding`.
 */
function isChangedPath(path: string, evidence: LogicEvidence): boolean {
  return evidence.addedLineTextByPath.has(path)
}

/**
 * Concrete-changed-token check (evidence path (b)): does ANY backticked
 * token from the finding appear in the ADDED-line text of the finding's
 * path? Substring containment so a backticked expression (`arr[i]`,
 * `getUser(id).name`) matches the line it came from even when the model
 * quoted a fragment. A token must be at least 2 chars to count — a
 * single char (`x`, `+`) is too noisy to anchor on.
 */
function hasConcreteChangedToken(finding: PrReviewFinding, evidence: LogicEvidence): boolean {
  const lines = evidence.addedLineTextByPath.get(finding.path)
  if (!lines || lines.length === 0) return false
  const tokens = backtickedTokens(finding).filter((t) => t.length >= 2)
  if (tokens.length === 0) return false
  for (const tok of tokens) {
    for (const line of lines) {
      if (line.includes(tok)) return true
    }
  }
  return false
}

/**
 * Co-located AST hit check (evidence path (a)): is there an
 * `astLogicFindings` entry at the same path within
 * +/-AST_COLOCATION_TOLERANCE lines of the finding? Such a finding is
 * corroborated by a deterministic rule — auto-match, keep.
 */
function hasColocatedAstHit(finding: PrReviewFinding, evidence: LogicEvidence): boolean {
  for (const ast of evidence.astLogicFindings) {
    if (ast.path !== finding.path) continue
    // An AST finding may span multiple lines (line..endLine). Treat the
    // span — widened by the tolerance — as the match window so a finding
    // anchored anywhere in/near a multi-line node corroborates.
    const spanEnd = ast.endLine && ast.endLine >= ast.line ? ast.endLine : ast.line
    const start = ast.line - AST_COLOCATION_TOLERANCE
    const end = spanEnd + AST_COLOCATION_TOLERANCE
    if (finding.line >= start && finding.line <= end) return true
  }
  return false
}

/**
 * Pure decision for ONE logic-applicable finding. The caller has
 * already decided this finding's derived role set includes `logic` (via
 * the `logic-` sourceFindingId prefix, like the security gate's
 * `security-` check) AND that `score >= 4`; everything outside that
 * scope keeps before this is even called. Mode-agnostic — the
 * orchestrator gates the drop behind shadow/enforce.
 *
 * Contract (FP-safe; bias toward KEEP):
 *   - score < 4 logic findings always pass (the evidence bar is sev>=4
 *     only; lower-severity notes don't need an anchor). Checked here too
 *     so the helper is self-contained.
 *   - missing/empty `path` → `missing-path` (can't anchor anything).
 *   - path is NOT a changed file → `unanchored-logic-claim` (a logic
 *     bug must live on a line this PR touched).
 *   - changed path AND (co-located AST hit OR concrete changed token) →
 *     KEEP.
 *   - changed path but NEITHER anchor → `unanchored-logic-claim` (a
 *     vague claim on a changed file that quotes no code and has no
 *     deterministic backing).
 */
export function evaluateLogicFinding(
  finding: PrReviewFinding,
  evidence: LogicEvidence,
): LogicFindingDecision {
  // Evidence requirement is severity-gated: only sev>=4 logic findings
  // must be anchored. Lower-severity notes pass untouched.
  if (finding.score < 4) return { keep: true }

  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) {
    return { keep: false, reason: "missing-path" }
  }

  // No evidence wired at all (empty added-line map AND no AST findings):
  // there's nothing to cross-check against, so keep (back-compat for the
  // staged rollout / a caller that hasn't threaded the diff). An empty
  // map means we can't even tell whether the path changed, so dropping
  // would be an unjustified false negative.
  if (evidence.addedLineTextByPath.size === 0 && evidence.astLogicFindings.length === 0) {
    return { keep: true }
  }

  // The finding must live on a file this PR changed. A logic bug on an
  // unchanged path is out of scope (belongs on a separate ticket) and is
  // a clear FP shape for an LLM-anchored claim.
  if (!isChangedPath(path, evidence)) {
    return { keep: false, reason: "unanchored-logic-claim" }
  }

  // Changed path. Keep on ANY anchor: a co-located deterministic AST hit
  // OR a concrete backticked token that appears on an added line.
  if (hasColocatedAstHit(finding, evidence)) return { keep: true }
  if (hasConcreteChangedToken(finding, evidence)) return { keep: true }

  // Changed path but no concrete anchor — a vague claim quoting no code
  // and unbacked by any AST rule. This is the one reject shape.
  return { keep: false, reason: "unanchored-logic-claim" }
}
