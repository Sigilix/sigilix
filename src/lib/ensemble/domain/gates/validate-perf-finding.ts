// SIG-110: performance-finding evidence gate.
//
// The perf analogue of SIG-108's `evaluateSecurityFinding`, SIG-111's
// `evaluateTestFinding`, and SIG-109's `evaluateLogicFinding`. A sev>=4
// `performance`-sourced finding is KEPT when it is concretely anchored to
// the diff; only a vague, unanchored sev>=4 perf claim is rejected.
//
// FALSE-NEGATIVE SAFETY (biases toward KEEP, like the logic gate): many
// real perf findings are LLM-found (a quadratic loop, a blocking call on a
// hot path) with no deterministic backing. So the bar is broad:
//   KEEP a sev>=4 perf finding when it has a concrete `path` that is a
//   CHANGED file AND ANY ONE of:
//     (a) a co-located deterministic AST perf hit (an `ast/...` finding
//         with roleHint performance at the same path, within a few lines),
//     (b) an anchor token that appears in the ADDED/REMOVED-line TEXT of
//         `finding.path`. Anchor tokens are drawn from backticked spans in
//         the headline/body AND from the structured `complexityEstimate`
//         field, PLUS identifier-ish tokens parsed from `hotPathIdentifier`.
//         This is the key FP-safety fix from the Codex + deepseek-v4-pro
//         review: a `complexityEstimate` / `hotPathIdentifier` is only
//         credited when it NAMES real changed code — free-text boilerplate
//         ("O(n^2) somewhere") anchors nothing and does not pass.
//   REJECT only when sev>=4 perf AND (no changed-path anchor) AND (no
//   anchoring token on a changed line) AND (no co-located AST perf hit).
//
// SHADOW-FIRST: the actual drop is gated behind
//   `OPENCLAW_PERF_VALIDATOR_MODE` (shadow | enforce, default shadow) at
//   the call site. In shadow the verdict is only counted/telemetered —
//   NEVER dropped. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "@/shared/domain/pr-review-finding"
import type { AstFinding } from "@/features/ast-rules"
import { buildChangedLineTextByPath } from "./validate-logic-finding"

export { buildChangedLineTextByPath }

/**
 * Validator mode. `shadow` (default): telemeter what WOULD be dropped but
 * keep every finding. `enforce`: actually drop rejected findings.
 */
export type PerfValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_PERF_VALIDATOR_MODE`. Anything other than the literal
 * "enforce" (case-insensitive, trimmed) resolves to "shadow" — the
 * cautious default. Mirrors the other specialists' mode parsers.
 */
export function parsePerfValidatorMode(raw: string | undefined): PerfValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/** Co-location tolerance for an AST perf hit relative to the finding line. */
export const AST_COLOCATION_TOLERANCE = 5

export type PerfFindingDecision =
  | { keep: true }
  | { keep: false; reason: PerfDropReason }

export type PerfDropReason =
  | "missing-path" // sev>=4 perf finding with no concrete path to anchor
  | "path-not-changed" // sev>=4 perf on a path the PR didn't touch
  | "unanchored-perf-claim" // sev>=4 perf on a CHANGED path but naming no concrete changed token + no co-located AST perf hit

export interface PerfEvidence {
  /** Per-file CHANGED-line text from the unified diff (added + removed,
   *  leading sign stripped). A path present here is the changed-path anchor. */
  changedLineTextByPath: ReadonlyMap<string, readonly string[]>
  /** Deterministic AST findings filtered to `roleHint === "performance"`. */
  astPerfFindings: readonly AstFinding[]
}

/** Backticked spans from headline + body + complexityEstimate. */
function backtickedTokens(finding: PrReviewFinding): string[] {
  const text = `${finding.headline ?? ""} ${finding.body ?? ""} ${finding.complexityEstimate ?? ""}`
  const out: string[] = []
  const re = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = m[1]!.trim()
    if (tok.length > 0) out.push(tok)
  }
  return out
}

/** Identifier-ish tokens parsed out of a free-form hotPathIdentifier such
 *  as "GET /api/orders" or "handleCheckout" — split on non-identifier
 *  chars, keep tokens >=3 chars containing a letter. HTTP-verb words are
 *  dropped (too generic to anchor on). */
const HOT_PATH_STOPWORDS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "api", "the", "and",
])
function hotPathTokens(finding: PrReviewFinding): string[] {
  const raw = finding.hotPathIdentifier
  if (typeof raw !== "string" || raw.trim().length === 0) return []
  return raw
    .split(/[^A-Za-z0-9_$]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && /[A-Za-z_$]/.test(t) && !HOT_PATH_STOPWORDS.has(t.toLowerCase()))
}

function isChangedPath(path: string, evidence: PerfEvidence): boolean {
  return evidence.changedLineTextByPath.has(path)
}

/** Does ANY anchor token (backticks + complexityEstimate + hotPathIdentifier)
 *  appear in the changed-line text of the finding's path? `path` is the
 *  normalized (trimmed) path so a padded `finding.path` can't pass the
 *  changed-path gate and then miss here (CodeRabbit). */
function hasConcreteChangedToken(finding: PrReviewFinding, evidence: PerfEvidence, path: string): boolean {
  const lines = evidence.changedLineTextByPath.get(path)
  if (!lines || lines.length === 0) return false
  const tokens = [
    // >=3 chars (Codex/code-reviewer): a 2-char backtick token (`db`, `id`,
    // `fs`) appears on almost any changed line and would let a vague claim
    // anchor trivially. Match the >=3 floor `hotPathTokens` already uses.
    ...backtickedTokens(finding).filter((t) => t.length >= 3 && /[A-Za-z_$]/.test(t)),
    ...hotPathTokens(finding),
  ]
  if (tokens.length === 0) return false
  for (const tok of tokens) {
    for (const line of lines) {
      if (line.includes(tok)) return true
    }
  }
  return false
}

/** Co-located AST perf hit within +/-AST_COLOCATION_TOLERANCE lines. `path`
 *  is the normalized (trimmed) finding path. */
function hasColocatedAstHit(finding: PrReviewFinding, evidence: PerfEvidence, path: string): boolean {
  for (const ast of evidence.astPerfFindings) {
    if (ast.path !== path) continue
    const spanEnd = ast.endLine && ast.endLine >= ast.line ? ast.endLine : ast.line
    const start = ast.line - AST_COLOCATION_TOLERANCE
    const end = spanEnd + AST_COLOCATION_TOLERANCE
    if (finding.line >= start && finding.line <= end) return true
  }
  return false
}

/**
 * SIG-325: a perf finding is SELF-ORIGINATED when NO deterministic AST perf hit
 * corroborates it — the model asserted the regression and it is at most anchored
 * to a changed token, not flagged by the analyzer. The refutation-survival gate
 * uses this to require a survival rationale on a sev>=4 token-only / no-backing
 * perf claim. A co-located AST hit makes the finding tool-backed (the SIG-110
 * evidence gate covers that case), so it is NOT self-originated. A finding with
 * no usable `path` has nothing to corroborate against → self-originated.
 */
export function perfFindingIsSelfOriginated(finding: PrReviewFinding, evidence: PerfEvidence): boolean {
  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return true
  return !hasColocatedAstHit(finding, evidence, path)
}

/**
 * Pure decision for ONE perf-applicable finding. The caller has already
 * decided this finding's derived role set includes `performance` (via the
 * `performance-` sourceFindingId prefix) AND that `score >= 4`. Mode-agnostic.
 *
 * Contract (FP-safe; bias toward KEEP):
 *   - score < 4 → keep (the evidence bar is sev>=4 only).
 *   - missing/empty `path` → `missing-path`.
 *   - no evidence wired at all → keep (back-compat / staged rollout).
 *   - no changed-line text wired → keep (can't evaluate path-change).
 *   - path not changed → `path-not-changed` (enforced BEFORE AST
 *     corroboration so an AST hit can't retain an unchanged-path finding).
 *   - changed path AND (co-located AST hit OR anchor token) → keep.
 *   - changed path but neither → `unanchored-perf-claim`.
 */
export function evaluatePerfFinding(
  finding: PrReviewFinding,
  evidence: PerfEvidence,
): PerfFindingDecision {
  if (finding.score < 4) return { keep: true }

  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return { keep: false, reason: "missing-path" }

  // No changed-line text wired (back-compat / AST-only caller): we can't
  // evaluate path-change, so keep. AST perf findings are produced only on
  // changed lines by the runner, so this cannot smuggle in an unchanged-path
  // finding in the production pipeline.
  if (evidence.changedLineTextByPath.size === 0) return { keep: true }

  // Changed-line text present → enforce the changed-path gate BEFORE crediting
  // AST corroboration (CodeRabbit), so a co-located AST hit can never retain a
  // finding whose path the PR didn't touch.
  if (!isChangedPath(path, evidence)) {
    return { keep: false, reason: "path-not-changed" }
  }

  if (hasColocatedAstHit(finding, evidence, path)) return { keep: true }

  if (hasConcreteChangedToken(finding, evidence, path)) return { keep: true }

  return { keep: false, reason: "unanchored-perf-claim" }
}

// BT1 (pr/07): the only P0/P1 false positive — the perf specialist rated a
// CONSTANT version probe `execSync("/usr/bin/usage-report --version")` as
// Critical "blocking the event loop." A one-shot, constant-command version/help
// probe is never a Critical per-request blocker, and the perf evidence gate
// can't catch it (it validates anchoring, not severity — and the call DOES
// anchor to a real changed line). This is a deterministic SEVERITY clamp,
// applied unconditionally (mode-agnostic, like clampAstEmitScores).
const SYNC_EXEC_CALL_RE = /\b(?:execSync|execFileSync|spawnSync)\s*\(/
// A version/help probe inside a CONSTANT (non-interpolated — no `$`) string
// literal. The `[^"'`$]*` stops at any `${…}`, so an interpolated/heavy command
// (the real cmd-injection at report.ts:17) is NOT matched.
const TRIVIAL_PROBE_RE = /["'`][^"'`$]*(?:--version\b|--help\b|(?:^|\s)-v\b|(?:^|\s)-V\b)/

function normalizeFindingPath(rawPath: unknown): string {
  return typeof rawPath === "string" ? rawPath.trim() : ""
}

function addedLinesForFindingPath(
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
  rawPath: unknown,
): ReadonlyMap<number, string> | undefined {
  const path = normalizeFindingPath(rawPath)
  if (path.length === 0) return undefined
  return addedLineTextByLine.get(path)
    ?? (typeof rawPath === "string" && path !== rawPath ? addedLineTextByLine.get(rawPath) : undefined)
}

/**
 * Clamp, IN PLACE, the score of any sev>=4 (P0/P1) PERFORMANCE finding whose
 * cited line (± 2 lines) is a synchronous child-process call to a CONSTANT
 * version/help probe — capping it to score 2 (P3/Low, well below the P0/P1 bar
 * this fix targets). ONLY sev>=4 is clamped: a score-3 (P2) note is already
 * below the believability bar and is left untouched (CodeRabbit #298). FP-safe
 * + tightly scoped: a real per-request blocking call (interpolated/heavy
 * command, or a `readFileSync` template read) has no probe flag in a constant
 * literal, so it is untouched. Returns the count clamped. Pure apart from the
 * in-place mutation; exported for test.
 */
export function clampTrivialSyncIoSeverity(
  findings: Array<{ path: string; line: number; category: string; score: number }>,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
): number {
  if (!addedLineTextByLine) return 0
  let clamped = 0
  for (const f of findings) {
    if (f.category !== "performance" || f.score < 4) continue
    const lines = addedLinesForFindingPath(addedLineTextByLine, f.path)
    if (!lines) continue
    let isTrivialProbe = false
    for (let l = f.line - 2; l <= f.line + 2; l++) {
      const t = lines.get(l)
      if (t && SYNC_EXEC_CALL_RE.test(t) && TRIVIAL_PROBE_RE.test(t)) {
        isTrivialProbe = true
        break
      }
    }
    if (isTrivialProbe) {
      f.score = 2
      clamped++
    }
  }
  return clamped
}

// SIG-342: the performance K=12 ruler showed the model repeatedly rated
// intentionally serial live-model eval loops as P1. These harnesses are
// serial for stable K-repeat metrics and provider politeness; parallelizing
// them changes the measurement and can trip provider limits. This is a
// severity ceiling, not a drop: a reviewer may still see a P2 note, but it
// cannot block as a production perf regression.
const LIVE_EVAL_TEST_PATH_RE = /(?:^|\/)tests\/[^/]+\.live\.test\.tsx?$/
const LIVE_EVAL_INTENT_RE = /\b(?:sequential\s+by\s+design|stable\s+(?:benchmark|eval|evaluation|metrics|order)|avoid\s+provider\s+bursts?|provider\s+(?:politeness|rate\s+limit)|rate\s+limits?)\b/i
const LIVE_EVAL_MARKER_RE = /\b(?:runCase|repeats?|cases|apiKey|OLLAMA_API_KEY|live[-\s]?model|benchmark|eval)\b/i
const SERIAL_WORD_RE = /\b(?:serial|sequential)\b/i
const EVAL_LOOP_WORD_RE = /\b(?:runCase|cases?|eval(?:uation)?|benchmark|harness|loop|parallel|Promise\.all)\b/i

interface MutablePerfFindingForClamp {
  path: string
  line: number
  category: string
  score: number
  headline?: string
  body?: string
  complexityEstimate?: string
  hotPathIdentifier?: string
}

function nearbyAddedLines(
  lines: ReadonlyMap<number, string>,
  line: number,
  radius: number,
): string {
  const out: string[] = []
  for (let l = line - radius; l <= line + radius; l++) {
    const text = lines.get(l)
    if (text) out.push(text)
  }
  return out.join("\n")
}

function findingTextForClamp(f: MutablePerfFindingForClamp): string {
  return [
    f.headline,
    f.body,
    f.complexityEstimate,
    f.hotPathIdentifier,
  ].filter((x): x is string => typeof x === "string" && x.length > 0).join("\n")
}

function isSerialEvalLoopClaim(text: string): boolean {
  return SERIAL_WORD_RE.test(text) && EVAL_LOOP_WORD_RE.test(text)
}

/**
 * Cap sev>=4 performance findings on explicit serial live-eval test harnesses
 * to score 3. The proof is deliberately conjunctive:
 *   - path is `tests/*.live.test.ts[x]`;
 *   - the finding itself claims a serial/eval/loop parallelization issue;
 *   - added file text or the finding names live-eval markers (`runCase`, `repeats`, `apiKey`, ...);
 *   - added file text or the finding includes visible intent for serial execution / provider limits;
 *   - the finding is anchored near an added `await`.
 *
 * Production files and tests without the explicit serial-eval intent are not
 * touched, so a real N+1 or retry storm with a "sequential by design" comment
 * keeps its original severity.
 */
export function clampIntentionalLiveEvalSerialLoopSeverity(
  findings: MutablePerfFindingForClamp[],
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
): number {
  if (!addedLineTextByLine) return 0
  let clamped = 0
  const fileTextByLines = new WeakMap<ReadonlyMap<number, string>, string>()
  for (const f of findings) {
    if (f.category !== "performance" || f.score < 4) continue
    const path = normalizeFindingPath(f.path)
    if (!LIVE_EVAL_TEST_PATH_RE.test(path)) continue
    const lines = addedLinesForFindingPath(addedLineTextByLine, f.path)
    if (!lines) continue
    const findingText = findingTextForClamp(f)
    if (!isSerialEvalLoopClaim(findingText)) continue
    let fileText = fileTextByLines.get(lines)
    if (fileText === undefined) {
      fileText = [...lines.values()].join("\n")
      fileTextByLines.set(lines, fileText)
    }
    const combinedText = `${fileText}\n${findingText}`
    if (!LIVE_EVAL_MARKER_RE.test(combinedText) || !LIVE_EVAL_INTENT_RE.test(combinedText)) continue
    const nearby = nearbyAddedLines(lines, f.line, 5)
    if (!/\bawait\b/.test(nearby)) continue
    f.score = 3
    clamped++
  }
  return clamped
}
