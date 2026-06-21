// SIG-318 / SIG-384: the PR-review finding/verdict vocabulary lifted from the
// `triage-pr-review` god-file so domain/feature code can reference it without
// importing it. The canonical consumer (`triage-pr-review`) re-exports every
// symbol, so existing importers are unchanged.

import type { FindingCategory } from "./finding-category"
import type { FindingMoreInfo } from "./finding-more-info"

/**
 * ARC-182: stack-origin tag attached to findings on Graphite-style
 * stacked PRs. Optional — absent on unstacked PRs. See
 * `src/lib/pr-stack.ts` for the detection logic.
 */
export type StackOrigin = "current-pr" | "downstack-context" | "upstack-followup"

export const STACK_ORIGINS: ReadonlySet<StackOrigin> = new Set(["current-pr", "downstack-context", "upstack-followup"])

export type ReviewFindingScope = "line" | "file" | "pr" | "comment"

export const REVIEW_FINDING_SCOPES: ReadonlySet<ReviewFindingScope> = new Set(["line", "file", "pr", "comment"])

/**
 * SIG Trust Ledger v0: per-finding "why you can trust this" metadata, attached
 * at submission time (runtime-only — never parsed from model JSON). The renderer
 * (trust-ledger-render.ts) maps `tier` to the VERIFIED / GROUNDED / MODEL pill.
 * Tier precedence (most→least proof): runner-confirmed (a scanner in the
 * customer's CI corroborated it) > reproduced-by-execution (SIG-477: Sigilix's
 * OWN execution sandbox re-ran the cited code and observed the predicted failure —
 * self-attested by a mechanical witness, still below an independent CI receipt) >
 * deterministic-confirmed (Sigilix's OWN deterministic AST engine independently
 * flagged the cited vuln-class at this line — self-attested, not CI-attested) >
 * deterministic-grounded (an AST/scanner fact backs it) > worker-token-confirmed
 * (the cited token checks out at the cited line) > grounded-model (cites real
 * evidence, passed the gates) > body-only-ungrounded. A receipt-confirmed
 * (runner-confirmed) finding must always outrank a self-attested one
 * (reproduced-by-execution / deterministic-confirmed).
 */
export type FindingTrustTier =
  | "runner-confirmed"
  | "reproduced-by-execution"
  | "deterministic-confirmed"
  | "deterministic-grounded"
  | "worker-token-confirmed"
  | "grounded-model"
  | "body-only-ungrounded"

export interface FindingTrust {
  tier: FindingTrustTier
  /** where the finding landed after all gates. */
  surface?: "inline" | "body"
  /** if body-routed, WHY (the gate that demoted it / outside-the-diff). */
  demoteReason?:
    | "inline-grounding"
    | "absence-grounding"
    | "security-grounding"
    | "security-usage"
    | "security-evidence"
    | "verification-refuted"
    | "outside-diff"
    | "do-race"
    | "tests-coverage"
    | "window-blindness"
    | "refutation-survival"
    // SIG-488 (recall #5): a sev>=4 finding the vague-prefix / uncited-testing
    // HARD-DROP heuristic would delete, demoted to a P2 note instead of dropped.
    | "vague-prefix"
    | "uncited-testing"
}

/**
 * SIG-112: runtime provenance record shown in the optional evidence
 * block. Built by the ensemble from validated synth provenance and
 * structured evidence fields; never parsed from model JSON.
 */
export interface EvidenceRecord {
  specialistsThatFlagged: string[]
  specialistsThatDeclined: string[]
  deterministicFactIds: string[]
  retrievalChunkIds: string[]
  relatedPriorPRs: string[]
  synthDecision: "kept" | "merged" | "rewritten" | "unknown"
  consensusScore: number
}

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  /**
   * SIG-202: where the finding belongs in GitHub's review surfaces.
   * Missing is treated as "line" for backwards compatibility.
   *
   *   - "line"    — exact changed line is the subject; render inline.
   *   - "file"    — file/module-level concern; render in review body.
   *   - "pr"      — PR-level/cross-file concern; render in review body.
   *   - "comment" — webhook/comment/review-event concern; body only.
   */
  scope?: ReviewFindingScope
  /**
   * SIG-392: internal runtime flag — when true, the engine deliberately set
   * `scope` and `normalizeFindingScopeForAnchorability` must NOT re-derive it.
   * Set on engine-MANUFACTURED cross-file findings (the coverage-stamp-collapse
   * survivor, which is `scope:"pr"` but inherits one kept stamp's path/line);
   * without this, the inline-first promotion would wrongly anchor a multi-file
   * aggregate to a single line. Never set from model output; never rendered.
   */
  scopeLocked?: boolean
  /**
   * SIG-463: explicit GitHub review SIDE for the inline anchor, overriding the
   * `deriveSide` default. Set ONLY to "LEFT" by `snapFindingLineToDeletedCode`
   * when a finding about REMOVED code is anchored to the deleted line — whose
   * old-file number can collide with the context line that shifted into it, so
   * `deriveSide` would (wrongly) prefer RIGHT. The renderer posts `side:"LEFT"`
   * (gated on `isPositionReviewable(...,"LEFT")`); a LEFT anchor is also exempt
   * from the SIG-285 added-line verification refute (it points at a deleted line,
   * which the added-line index can't check). Absent → side derived as before.
   */
  anchorSide?: "LEFT"
  score: number
  category: FindingCategory
  headline: string
  body: string
  /**
   * SIG-249: optional structured deep-dive sections for high-severity
   * findings. Parsed and rendered when present, but not required by the
   * recall gates until we have fill-rate evidence that enforcement is safe.
   */
  moreInfo?: FindingMoreInfo
  /** SIG Trust Ledger v0: runtime-only trust metadata (the renderer reads this);
   *  attached at submission time, never parsed from model output. */
  trust?: FindingTrust
  /** SIG-112: runtime-only provenance record for the optional evidence block. */
  evidence?: EvidenceRecord
  /**
   * SIG-217: runtime-only content fingerprint —
   * `sha256(category + path + bodySnippet(0,80))`, attached by the ensemble
   * before render. Emitted as a hidden `sigilix:fingerprint:` marker so a
   * later dismissal can record it and content-equivalent re-fires are
   * suppressed even when the model-emitted finding ID changes per push.
   * Never parsed from model output.
   */
  contentFingerprint?: string
  /**
   * SIG-317 step 6 Part B: runtime-only redacted code slice from the
   * deterministic AST detector that PROVED this finding (attached by the
   * AST-emit floor when it injects an unmatched emit). The renderer surfaces it
   * as a "Detected by static analysis" section so a deterministically-grounded
   * subtle finding reads as proven, not as an unsupported model guess. Already
   * redacted by the AST runner; never parsed from model output.
   */
  astEvidence?: string
  /**
   * Inlines-only / outside-diff (founder ask): runtime-only flag — the finding's
   * `path` is NOT one of the PR's changed files, so it's about code OUTSIDE this
   * PR's changes (the model raised it from graph/retrieval context). Set at
   * submission time from the reviewable changed-file set — INDEPENDENT of the
   * trust-ledger flag (Codex #333: the old `demoteReason: "outside-diff"` signal
   * was flag-dependent AND conflated "anchor failed on a CHANGED file" with
   * "genuinely not in the PR"). An out-of-PR-scope finding renders in the
   * non-inline findings dropdown (the out-of-PR-scope group) and NEVER blocks
   * the merge; a finding on a
   * changed file that merely failed to anchor is NOT out-of-PR-scope and still
   * blocks per severity. Never parsed from model output.
   */
  outOfPrScope?: boolean
  /**
   * Structured details: optional concrete example proving the finding. Intended
   * for minimal repro input/output, runtime exception text, parser
   * examples, or other compact evidence that is clearer in a fenced
   * block than prose. Raw text/code only — the renderer adds fences.
   */
  failureExample?: string
  /**
   * Structured details: optional non-committable fix shape. Used when an exact
   * contiguous GitHub suggestion is unsafe but a small snippet helps
   * the reviewer understand the intended direction. Raw code/text only
   * — `suggestedReplacement` remains the only one-click patch field.
   */
  fixExample?: string
  /**
   * Structured details: optional one-sentence explanation of why existing tests or
   * checks missed the issue. Only populated when the model has concrete
   * test/CI evidence; the renderer labels it explicitly.
   */
  testGap?: string
  /**
   * ARC-182: optional stack-origin tag. Emitted only when the input
   * prompt included a [STACK CONTEXT] block; absent for unstacked PRs.
   * Schema-bypass paths with an unknown value normalize to "current-pr".
   */
  stackOrigin?: StackOrigin
  /**
   * Renderer-only note for findings that had to move out of an inline
   * GitHub review comment because the original line no longer anchors
   * cleanly at the reviewed head.
   */
  anchorNote?: string
  /**
   * SIG-101: per-finding model confidence on a 1-5 scale (distinct from
   * `score`, which is severity). The synth specialist may emit a
   * per-finding confidence; when absent, callers default to the
   * verdict-level `confidence` field via `resolveFindingConfidence`
   * so every finding has a value downstream. `formatFindingComment`
   * preserves confidence in a hidden marker for tooling and wraps
   * low-confidence (≤2) bodies in a collapsed `<details>` block so
   * noisy findings de-emphasize.
   */
  confidence?: number
  /**
   * SIG-113: file paths the specialist inspected while forming the
   * finding. Populated by the tests specialist from the
   * [TESTING EVIDENCE] block's `inspectedTestFiles` list. Used by
   * `evaluateTestingFindingCitation` to drop "missing tests" findings
   * where the specialist never actually looked at any test file
   * (the PR #110 / PR #111 FP class).
   *
   * Absent on findings from specialists that don't yet emit this
   * field — back-compat with the staged rollout. Other roles may
   * adopt the same field for SIG-108 / SIG-109 / SIG-110.
   */
  inspectedTestFiles?: string[]
  /**
   * SIG-113: references into the role-scoped evidence block backing
   * the finding. Format is `<kind>:<value>` — e.g.
   *   "siblingMapping:src/lib/foo.ts->NONE"   (no test sibling exists)
   *   "inspectedTestFile:tests/foo.test.ts"   (specialist read this file)
   *   "secretScan:SCN-42"                     (security evidence ID)
   *   "depVuln:CVE-2025-1234"                 (security evidence ID)
   *
   * Used by the per-role validators (SIG-113 for testing,
   * SIG-108/109/110 for security/logic/perf) to require concrete
   * citations on high-severity or absence-claiming findings.
   */
  evidenceRefs?: string[]
  /**
   * SIG-108: CWE identifier backing a security finding (e.g. "CWE-89").
   * `validateSecurityFinding` requires it on score>=4 security findings
   * in scanner-covered buckets; absent findings are auto-enriched from a
   * matching deterministic fact when possible, else dropped. Absent on
   * non-security findings and on specialists not yet on the new prompt.
   */
  cweId?: string
  /**
   * SIG-108: verbatim copy of a deterministic security fact's id
   * ("tool:rule-id:hash:line"), or the literal "NONE" for access-control
   * findings no scanner can detect (paired with a body justification).
   * Cross-checked against the security fact manifest by
   * `validateSecurityFinding`.
   */
  evidenceId?: string
  /**
   * SIG-282: optional one-line verification rationale the security
   * specialist records when it adjudicates a scanner-backed finding
   * (analyst note). Audit/telemetry only — no gate depends on it.
   */
  independentAssessment?: string
  /**
   * SIG-110: complexity claim backing a performance finding — names the
   * changed loop/call and the input-growth source (e.g.
   * "O(n^2): rebuilds `acc` for each item in `rows`"). One of
   * `complexityEstimate` / `hotPathIdentifier` is required by
   * `evaluatePerfFinding` on score>=4 perf findings. Absent on
   * non-perf findings and on specialists not yet on the new prompt.
   */
  complexityEstimate?: string
  /**
   * SIG-110: a concrete changed route/handler/export token the perf
   * finding sits on (e.g. "GET /api/orders", "handleCheckout"). Anchors
   * a hot-path claim to a real token on a changed line; cross-checked by
   * `evaluatePerfFinding`.
   */
  hotPathIdentifier?: string
  /**
   * SIG-125: exact replacement lines for the finding's anchored range
   * `[startLine ?? line, line]` when the fix is a contiguous edit. Raw
   * code (no diff markers, no fence). Rendered by `formatFindingComment`
   * as a committable ```suggestion block (high-confidence + anchorable)
   * or a non-committable code snippet. Absent when no localized fix
   * applies (testing / architecture / multi-hunk).
   *
   * SIG-162 PR 5: when `kind === "delete"`, this field is REQUIRED but
   * must be the empty string `""` — signals deletion intent. The
   * renderer emits an empty ```suggestion block that GitHub treats as
   * a one-click deletion of the anchored range.
   */
  suggestedReplacement?: string
  /**
   * SIG-162 PR 5: shape of the proposed change. Drives renderer's
   * `suggestion` block contents:
   *   - `"delete"`  — emit an EMPTY suggestion block (one-click removal
   *                   of `[startLine ?? line, line]`). Requires
   *                   `suggestedReplacement === ""` to be set.
   *   - `"replace"` — emit a suggestion block with `suggestedReplacement`
   *                   as the new content. Same as the SIG-125 default.
   *   - `"insert"`  — reserved for future use (insertion at a single line).
   *   - `"describe"` — no suggestion block; the body is descriptive only.
   *
   * Absent → behaves like `"describe"` (back-compat with pre-PR5 model
   * output). Parser coerces inconsistent shapes:
   *   - `kind:"delete"` + non-empty `suggestedReplacement` → `kind:"replace"`
   *     (the replacement content is the actionable signal).
   *   - `kind:"delete"` + missing `suggestedReplacement` → drop `kind`
   *     (ambiguous intent — back-compat default).
   */
  kind?: "delete" | "replace" | "insert" | "describe"
  /**
   * SIG-161 PR 4a: deterministic gate score (0-1) driving the verdict
   * gate. NOT emitted by the LLM — computed post-parse by
   * `computeGateScore` from `confidence`, `score`, evidence-citation
   * presence, and specialist agreement (from `provenance.sourceSpecialists`).
   *
   * Absent on findings that haven't been scored yet (the rollout regime;
   * `chooseReviewEventWithGate` treats missing scores per `missingScorePolicy`).
   * Present on every finding that passes through PR 4b's ensemble post-
   * processing.
   *
   * Distinct from:
   *   - `confidence` (1-5, self-reported, drives renderer chrome)
   *   - `score` (1-5, severity)
   *
   * See DESIGN.md §3 for the naming rationale (`gateScore` over `calibratedScore`).
   */
  gateScore?: number
  /**
   * SIG-426: verbatim excerpt the model copied from the `[FAILED CI LOG]`, used
   * ONLY by the CI-failure-triage synth pass (`ci-triage-synth-run.ts`) to
   * corroborate the finding against the real log via `isLogGrounded`. Emitted by
   * the CI synth preamble (`CI_SYNTH_PREAMBLE`, ci-synth.ts) as a top-level
   * `logExcerpt` field; the standard PR-review specialists never emit it, so this
   * is undefined on every non-CI finding and the PR-review path is unaffected.
   * Parsed by `parsePrReviewResponse` (trim-only; never rendered).
   */
  logExcerpt?: string
  /**
   * SIG-104 PR-3: runtime-only "applied learning" attribution — set at the
   * deterministic soften gate (render-prep) when a `polarity:"suppress"` learning
   * narrowly matched this finding but a recall-safety carve-out KEPT it (it is a
   * P0/P1, or security/logic by provenance, or deterministically grounded). The
   * renderer surfaces a small `<sub>shaped by learned rule: …</sub>` provenance
   * line so the customer sees memory at work inline — our differentiator (neither
   * CodeRabbit nor Greptile attributes a learning per finding). `ruleText` is the
   * stored normalized rule (already secret-redacted at capture). Never parsed
   * from model output; gated behind the trust-ledger render flag.
   */
  shapedByLearning?: { ruleText: string }
}

/**
 * SIG-282: an analyst (LLM) false-positive dismissal of a deterministic
 * scanner candidate. `evidenceId` is a verbatim manifest id; `reason` is a
 * one-line code-grounded justification. Reconciled against the manifest by
 * `evaluateScanFactDismissal` (telemetry + safety rail).
 */
export interface ScanFactDismissal {
  evidenceId: string
  reason: string
}

/**
 * SIG-308: a correctness concern the LOGIC specialist spotted but REFUTED
 * against a concrete in-code mitigation (a guard/clamp/bound/early-return)
 * instead of emitting a finding — the logic analogue of `ScanFactDismissal`.
 * `mitigation` quotes the in-code token that defeats the concern. Self-
 * generated (no scanner manifest), so the orchestrator only telemeters these
 * for cleared-rate observability; the recall safety rail is the Phase 3
 * `evaluateLogicRefutation` backstop, not a manifest re-check.
 */
export interface ClearedLogicCandidate {
  path: string
  line: number
  hypothesis: string
  mitigation: string
}

export interface PrReviewVerdict {
  summary: string
  confidence: number
  confidenceReason: string
  findings: PrReviewFinding[]
  /**
   * SIG-282: scanner candidates the security specialist refuted as false
   * positives (security-only; absent/empty for other specialists).
   */
  dismissedScanFacts?: ScanFactDismissal[]
  /**
   * SIG-308: correctness concerns the logic specialist refuted against an
   * in-code mitigation (logic-only; absent/empty for other specialists).
   */
  clearedLogicCandidates?: ClearedLogicCandidate[]
}

/**
 * ARC-281: specialist coverage signal injected into the review body
 * so customers can see which dimensions Sigilix actually ran. When
 * `dispatched ⊃ succeeded`, the body renders a degraded-coverage
 * notice listing the unavailable roles.
 *
 * `dispatched` is what the router asked for (subset of {logic,
 * security, performance, tests}); `succeeded` is what returned a
 * verdict. The renderer treats the role order verbatim — supply
 * them in the canonical order you want displayed.
 */
export interface CoverageRoles {
  readonly dispatched: readonly string[]
  readonly succeeded: readonly string[]
}

export function isDeletionSuggestion(finding: PrReviewFinding): boolean {
  const repl = finding.suggestedReplacement
  return finding.kind === "delete" && typeof repl === "string" && repl.length === 0
}

export function isReplacementSuggestion(finding: PrReviewFinding): boolean {
  const repl = finding.suggestedReplacement
  return (finding.kind === "replace" || finding.kind === undefined) && typeof repl === "string" && repl.length > 0
}

// SIG-281 PR C: exported so the inline-grounding gate
// (validate-inline-grounding.ts) can reuse the canonical "has a
// committable fix" predicate instead of re-deriving the
// suggestedReplacement / kind logic (avoids drift).
export function hasStructuredFix(finding: PrReviewFinding): boolean {
  return isDeletionSuggestion(finding) || isReplacementSuggestion(finding)
}
