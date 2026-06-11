// SIG-361 (PR 9) — the review-VERDICT domain (domain layer).
//
// PURE verdict policy reunited from BOTH god-files: review-event selection
// (legacy + rendered-surface + thresholded gate + shadow divergence), the
// deterministic gate-score blend + per-category evidence predicate, and the
// score→severity mappings. No env / network / storage. The only outward
// imports are shared/domain leaves (the finding type + the bot identity).
//
// Moved VERBATIM from triage-pr-review.ts (event/gate/severity cluster) and
// triage-pr-review-ensemble.ts (LOW_CONFIDENCE_COMMENT_THRESHOLD,
// resolveReviewEventOverride, severityTier); both files re-export / import-back
// so existing importers are unchanged. NOTE: `severityTier` (exact-equality
// boundaries) and `severityLabelForScore` (>= boundaries) are intentionally
// kept as separate verbatim mappings — unifying them is a follow-up that needs
// an integers-only proof of equivalence, out of scope for this zero-behavior
// move. `severityTier` was private in the ensemble; it becomes an exported
// domain function here (additive — not added to the ensemble's public surface).

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { SIGILIX_BOT_LOGIN } from "@/src/shared/domain/sigilix-identity"

/**
 * SIG-161 PR 4a: widened from the legacy two-state `"APPROVE" |
 * "REQUEST_CHANGES"` to three states by adding `"COMMENT"`.
 *
 * `"COMMENT"` is a real GitHub review event (POST /pulls/{n}/reviews
 * `event: "COMMENT"`) — posts inline comments without taking a
 * verdict. The legacy `chooseReviewEvent` never returns it; only the
 * new `chooseReviewEventWithGate` does, and only for findings whose
 * `gateScore` falls in the borderline band
 * `[FLOOR_SUPPRESS, chosenThreshold)`. See DESIGN.md §4.
 *
 * Exported (was previously file-local) because PR 4b's flag wrapper
 * + the renderer body builders need to switch on the widened union.
 */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
/**
 * A caller-supplied event override. Two safe directions only:
 *   - `"REQUEST_CHANGES"` — escalate (always wins; a real blocker must block).
 *   - `"COMMENT"` — DOWNGRADE an otherwise-`APPROVE` to a neutral comment
 *     (SIG-287: a degraded / low-confidence review must never post a confident
 *     clean APPROVE). It can only weaken APPROVE→COMMENT — it can NEVER weaken a
 *     `REQUEST_CHANGES` or hide a blocking finding (see `chooseRenderedEventWithOverride`).
 * `"APPROVE"` is intentionally NOT overridable — nothing may force a clean
 * approval over the rendered-findings gate.
 */
export type ReviewEventOverride = Exclude<ReviewEvent, "APPROVE">

export function chooseReviewEvent(
  findings: PrReviewFinding[],
  openItems: ReadonlyArray<AuthoredItem> = [],
): Exclude<ReviewEvent, "COMMENT"> {
  // Strict: any inline finding the model surfaces is a blocker. The
  // verdict is two-state (APPROVE | REQUEST_CHANGES) — score still
  // sorts/severity-tags the findings but doesn't decide the gate.
  // Closed loop comes from synchronize-driven re-reviews (PR #28):
  // user pushes fixes → arc re-reviews → empty findings → APPROVE.
  //
  // ARC-276: the APPROVE event is a real GitHub review-approval that
  // counts toward branch-protection's required-reviewer count on
  // repos that don't exclude bot reviewers. This is the
  // "rubber-stamp" trade-off documented in the README; the founder's
  // call is that always-vocal Sigilix beats silent skips even at the
  // cost of bot-approval-counts-as-reviewer.
  //
  // SIG-37: `openItems` is an optional list of open PR threads /
  // review comments / blocking items that a caller wants to factor
  // into the gate. Items NOT authored by `sigilix[bot]` (i.e.
  // CodeRabbit, Greptile, other bots, human reviewers) are filtered
  // out BEFORE the gate runs. Only Sigilix-authored open items count
  // — establishes the clean Sigilix-only signal needed for the
  // head-to-head measurement framework (SIG-200, separately tracked).
  //
  // Defaults to `[]` so existing call sites (which pass only the
  // synth verdict's own findings) are unaffected — those findings
  // are Sigilix-authored by construction.
  if (findings.length > 0) return "REQUEST_CHANGES"
  const sigilixOpenItems = filterToSigilixAuthored(openItems)
  return sigilixOpenItems.length === 0 ? "APPROVE" : "REQUEST_CHANGES"
}

export interface ChooseReviewEventForRenderedFindingsArgs {
  inlineFindings: readonly PrReviewFinding[]
  bodyOnlyFindings: readonly PrReviewFinding[]
  openItems?: ReadonlyArray<AuthoredItem>
}

/**
 * Verdict gate for the final rendered surface.
 *
 * Inline review comments are blocking because GitHub places them on
 * changed code. Body-only findings of low/medium severity (score < 4)
 * are surfaced as a non-blocking COMMENT — off-diff/global feedback
 * stays visible without pretending it is an inline fix.
 *
 * SIG-281 PR A: a body-only finding of score >= 4 (P0/P1) DOES escalate
 * to REQUEST_CHANGES. A real blocker can land body-only (no anchorable
 * inline location, or demoted by the PR B/C routing discipline), and a
 * markdown table row does not gate a merge — only the review event does.
 * A separate policy blocker can still override the event upward.
 */
export function chooseReviewEventForRenderedFindings(args: ChooseReviewEventForRenderedFindingsArgs): ReviewEvent {
  const sigilixOpenItems = filterToSigilixAuthored(args.openItems ?? [])
  if (sigilixOpenItems.length > 0) return "REQUEST_CHANGES"

  // Out-of-PR-scope findings (code OUTSIDE this PR's changes — `outOfPrScope`,
  // path not a changed file) are INFORMATIONAL: never block, never withhold
  // approval (CodeRabbit-parity; founder ask #334). When they are the ONLY
  // findings the PR is clean → APPROVE. Keys on `outOfPrScope` (path-not-changed),
  // NOT anchor-failure — a real blocker on a CHANGED file that merely failed to
  // anchor inline is in-scope and STILL blocks (closes the recall hole).
  const inScope = [...args.inlineFindings, ...args.bodyOnlyFindings].filter((f) => !f.outOfPrScope)
  if (inScope.length === 0) return "APPROVE"
  const nonTestingInScope = inScope.filter((f) => f.category !== "testing")
  if (nonTestingInScope.length === 0) return "COMMENT"

  // Founder verdict rule: Sigilix NEVER approves a PR that carries a real
  // finding, and ANY substantive finding — inline or body, any severity —
  // BLOCKS ("no competitor approves on a P2/P3"). The only non-blocking tier is
  // a truly trivial cosmetic nit (`isTrivialFinding`), which posts as a neutral
  // COMMENT. The SAME predicate routes the body renderer's blocking-vs-non-
  // blocking split, so the verdict and the presentation can never contradict.
  if (nonTestingInScope.some((f) => !isTrivialFinding(f))) return "REQUEST_CHANGES"
  return "COMMENT"
}

/**
 * A "truly trivial" cosmetic nit — a `style`/`docs` finding below P0/P1. The
 * single source of truth for the founder verdict rule: a trivial finding is
 * NON-BLOCKING (posts as a neutral COMMENT); EVERYTHING else is substantive and
 * BLOCKS (REQUEST_CHANGES). A P0/P1 (score >= 4) is NEVER trivial regardless of
 * category — the `score < 4` gate is the recall floor (SIG-281). This decides
 * the VERDICT only; where a finding RENDERS (Fix Plan for P0/P1, "Review Body
 * Findings" for sub-4) stays severity-based and orthogonal. Pure.
 */
export function isTrivialFinding(f: PrReviewFinding): boolean {
  return (f.category === "style" || f.category === "docs") && f.score < 4
}

export function chooseRenderedEventWithOverride(
  args: ChooseReviewEventForRenderedFindingsArgs,
  eventOverride?: ReviewEventOverride,
): ReviewEvent {
  // Escalation always wins — a real blocker must block.
  if (eventOverride === "REQUEST_CHANGES") return "REQUEST_CHANGES"
  const base = chooseReviewEventForRenderedFindings(args)
  // SIG-287: a `"COMMENT"` override DOWNGRADES an otherwise-clean APPROVE to a
  // neutral comment (degraded coverage / low confidence — "Sigilix looked but
  // this is not a full sign-off"). It can ONLY weaken APPROVE→COMMENT — never
  // weaken a REQUEST_CHANGES and never hide a rendered blocker: if `base` is
  // already REQUEST_CHANGES or COMMENT (findings present), it stands.
  if (eventOverride === "COMMENT" && base === "APPROVE") return "COMMENT"
  return base
}

// ─── SIG-161 PR 4a: thresholded gate ─────────────────────────────────
// Sits alongside the legacy `chooseReviewEvent`. The flag wrapper in
// PR 4b switches between them based on `OPENCLAW_GATE`. The legacy
// path is preserved unchanged for back-compat (every existing call
// site still uses it; nothing in PR 4a routes findings through the
// new path in production).
//
// See DESIGN.md §4 for the four-event table and §5 for the score
// blend.

/** Compile-time policy for a finding whose `gateScore` is absent. */
export type MissingScorePolicy =
  /** Treat missing as `1.0` — finding blocks like today. Rollout default. */
  | "block"
  /** Treat missing as a pipeline-invariant failure — throw. Post-calibration default. */
  | "throw"
  /** Treat missing as `0.0` — non-blocking; useful for offline replay / backfill. */
  | "permit"

export interface ChooseReviewEventWithGateArgs {
  findings: PrReviewFinding[]
  /** Calibrated cutoff. A finding with `gateScore >= threshold` blocks. */
  threshold: number
  /** Optional list of open PR threads — same SIG-37 semantics as legacy. */
  openItems?: ReadonlyArray<AuthoredItem>
  missingScorePolicy: MissingScorePolicy
}

/**
 * SIG-161 PR 4a — four-event verdict gate.
 *
 *   - any finding's `gateScore >= threshold`  → REQUEST_CHANGES
 *   - no blocking + any Sigilix-authored open → REQUEST_CHANGES
 *   - no blocking + any finding present       → COMMENT
 *   - no blocking + no findings + no items    → APPROVE
 *
 * `missingScorePolicy` controls handling of `gateScore === undefined`:
 *   - `"block"`: effective score = 1.0 (matches legacy + rollout).
 *   - `"throw"`: pipeline invariant — every finding MUST be scored
 *                by the time it reaches the gate. Production
 *                `enforce`-mode setting.
 *   - `"permit"`: effective score = 0.0 (offline replay / backfill).
 *
 * Pure — exported for tests. PR 4b's flag wrapper is the production
 * call site; PR 4a itself never reaches this function in prod (the
 * existing call sites continue to use legacy `chooseReviewEvent`).
 *
 * NOTE: this function does NOT apply the `FLOOR_SUPPRESS = 0.60`
 * suppression. That happens upstream in the ensemble's pre-emit
 * filter (alongside review-memory softening, withdrawal suppression,
 * structural-glue suppression). The gate sees only findings that
 * already survived suppression and decides which event to emit.
 */
export function chooseReviewEventWithGate(args: ChooseReviewEventWithGateArgs): ReviewEvent {
  const { findings, threshold, openItems = [], missingScorePolicy } = args

  const effectiveScore = (f: PrReviewFinding): number => {
    // Guard non-finite: `typeof NaN === "number"`, and `NaN >= threshold`
    // is always false, so a NaN gateScore would silently bypass the
    // blocking branch instead of routing through missingScorePolicy.
    // Treat NaN / +Infinity / -Infinity as "missing" and fall through.
    if (typeof f.gateScore === "number" && Number.isFinite(f.gateScore)) {
      return f.gateScore
    }
    if (missingScorePolicy === "block") return 1.0
    if (missingScorePolicy === "permit") return 0.0
    // throw
    throw new Error(
      `gateScore missing on finding ${f.path}:${f.line} (${f.headline.slice(0, 60)}); ` +
        `pipeline invariant — every finding reaching the gate must be scored. ` +
        `If this fires in prod, the ensemble's post-processing is bypassing computeGateScore.`,
    )
  }

  const blocking = findings.filter((f) => effectiveScore(f) >= threshold)
  if (blocking.length > 0) return "REQUEST_CHANGES"

  const sigilixOpenItems = filterToSigilixAuthored(openItems)
  if (sigilixOpenItems.length > 0) return "REQUEST_CHANGES"

  // No blocking finding, no open items — distinguish empty (APPROVE)
  // from "had findings, none blocking" (COMMENT, the new event).
  if (findings.length > 0) return "COMMENT"

  return "APPROVE"
}

/**
 * SIG-161 PR 4a — provenance subset relevant to gate scoring.
 *
 * The full `provenance` shape lives on the synth verdict (see
 * `synth-verdict.ts`) but `computeGateScore` only needs the
 * specialist-agreement count per finding. Decoupled so the function
 * stays pure + snapshot-testable.
 */
export interface GateScoreProvenance {
  /**
   * Specialists whose findings merged into this synth finding.
   * Length ≥ 1 (single-source findings are admissible per the
   * synthesizer prompt). More specialists = stronger agreement.
   */
  sourceSpecialists: ReadonlyArray<string>
}

/**
 * SIG-161 PR 4a — does this finding carry the evidence its category
 * requires? Used as a 0/1 boost input to `computeGateScore`.
 *
 *   - `security` + score>=4 → cweId AND evidenceId  (SIG-108 contract)
 *   - `performance` + score>=4 → complexityEstimate OR hotPathIdentifier
 *   - `testing` (all severities) → inspectedTestFiles OR evidenceRefs
 *   - any other category → true (no per-category requirement today)
 *
 * Mirrors the per-category validators that drop findings without
 * evidence; the score-blend boost is a soft echo of the hard validator
 * gate — findings WITH evidence get +0.10 even before the validator
 * applies, findings WITHOUT evidence (and below their validator
 * threshold) don't get the boost. Pure — exported for tests.
 */
export function hasRequiredEvidence(f: PrReviewFinding): boolean {
  if (f.category === "security") {
    if (f.score < 4) return true
    return (
      typeof f.cweId === "string" && f.cweId.length > 0 && typeof f.evidenceId === "string" && f.evidenceId.length > 0
    )
  }
  if (f.category === "performance") {
    if (f.score < 4) return true
    return (
      (typeof f.complexityEstimate === "string" && f.complexityEstimate.length > 0) ||
      (typeof f.hotPathIdentifier === "string" && f.hotPathIdentifier.length > 0)
    )
  }
  if (f.category === "testing") {
    return (
      (Array.isArray(f.inspectedTestFiles) && f.inspectedTestFiles.length > 0) ||
      (Array.isArray(f.evidenceRefs) && f.evidenceRefs.length > 0)
    )
  }
  // logic / error-handling / complexity / style / syntax / docs — no
  // per-category requirement in v1. The category-specific validators
  // (SIG-109 logic) handle their own admissibility.
  return true
}

/**
 * SIG-161 PR 4a — deterministic gate-score blend.
 *
 * `gateScore = clamp01(rescale(confidence) + evidence + agreement + severity)`
 *
 *   rescale: 1→0.10, 2→0.30, 3→0.50, 4→0.75, 5→0.90
 *     (conservative at the high end — overconfident "5/5" claims
 *      don't collapse to 1.0)
 *   evidence: +0.10 if `hasRequiredEvidence(f)`, else 0
 *   agreement: +0.05 per specialist beyond the first, capped at +0.10
 *   severity: score 1→-0.10, 2→-0.05, 3→0, 4→+0.05, 5→+0.10
 *
 * Hand-tuned coefficients in v1; PR 4c replaces this with a logistic-
 * regression fit on the labeled dataset (see DESIGN.md §8c). The
 * hand-blend stays in the codebase as the fallback when the calibrated
 * model artifact is unavailable (KV miss).
 *
 * Properties:
 *   - WEAKLY monotone in each input (clamp at 1.0 + 0.0 saturates).
 *   - Bounded in [0, 1].
 *   - Pure — exported for tests.
 *
 * NOT called by the renderer or any production code path in PR 4a.
 * PR 4b's ensemble post-processing calls this on each finding before
 * emit; PR 4c flips the flag so the score actually drives the gate.
 */
export function computeGateScore(f: PrReviewFinding, p: GateScoreProvenance): number {
  // Rescale self-reported 1-5 confidence to 0-1, conservative on the
  // high end. Missing self-report defaults to 3 (neutral) to mirror
  // `resolveFindingConfidence`'s "as confident as the verdict" fallback.
  const confRaw = typeof f.confidence === "number" ? f.confidence : 3
  const confBucket = Math.max(1, Math.min(5, Math.round(confRaw))) as 1 | 2 | 3 | 4 | 5
  const confMap = { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.75, 5: 0.9 } as const
  const conf = confMap[confBucket]

  const evidence = hasRequiredEvidence(f) ? 0.1 : 0

  // Cap agreement at +0.10 (two extra specialists). Beyond that, more
  // agreement doesn't add precision — diminishing returns + risk of
  // false-consensus boosts on category-overlap noise.
  const extraSpecs = Math.max(0, p.sourceSpecialists.length - 1)
  const agreement = Math.min(0.1, 0.05 * extraSpecs)

  const sevBucket = Math.max(1, Math.min(5, Math.round(f.score))) as 1 | 2 | 3 | 4 | 5
  const sevMap = { 1: -0.1, 2: -0.05, 3: 0, 4: 0.05, 5: 0.1 } as const
  const severity = sevMap[sevBucket]

  return Math.max(0, Math.min(1, conf + evidence + agreement + severity))
}

// ─── SIG-161 PR 4b — shadow-mode divergence helper ────────────────────
// Pulled out of the inline ensemble call site (per Sigilix self-review
// on PR #146 — the inline 95-LOC block was untestable; the helper is
// pure + unit-coverable).

/**
 * Inputs to `computeShadowGateDivergence`. Decoupled from the
 * ensemble's `Env` / `console.log` / provenance shape so the helper
 * stays pure.
 */
export interface ShadowDivergenceInputs {
  /** Findings that will render inline (anchored). Parallel to `provenance`. */
  renderable: PrReviewFinding[]
  /** Findings that fell out of inline anchoring; no parallel provenance. */
  unanchored: PrReviewFinding[]
  /**
   * Per-renderable-finding provenance. Each entry maps to the same
   * index in `renderable`; `undefined` entries signal "no source
   * specialists information" (treated as zero agreement signal).
   */
  provenance: ReadonlyArray<{ sourceSpecialists?: ReadonlyArray<string> } | undefined>
  /** Calibrated threshold (from KV at the call site). */
  threshold: number
  /** Verdict the legacy `chooseReviewEvent` already computed. */
  legacyEvent: Exclude<ReviewEvent, "COMMENT">
}

/**
 * Result of running the shadow-mode gate. `divergence` is populated
 * only when the gate verdict differs from `legacyEvent`; otherwise
 * null (the caller writes no log).
 */
export interface ShadowDivergenceResult {
  gateEvent: ReviewEvent
  divergence: {
    threshold: number
    legacyEvent: ReviewEvent
    gateEvent: ReviewEvent
    findingCount: number
    blockingFindingCount: number
    scoreSummary: string
  } | null
}

/**
 * SIG-161 PR 4b — compute the gate's shadow-mode verdict + the
 * divergence-log payload (when it disagrees with the legacy verdict).
 *
 * Pure — no env / KV / console access. The ensemble call site reads
 * the env + threshold + provenance, calls this, and writes the log if
 * `result.divergence !== null`.
 *
 * Behavior:
 *   - Each finding's `gateScore` is preserved when already a finite
 *     number; otherwise computed via `computeGateScore` with the
 *     parallel provenance (or empty `sourceSpecialists` for unanchored
 *     findings, which lack a provenance row).
 *   - The verdict is taken from `chooseReviewEventWithGate` with
 *     `missingScorePolicy: "block"` — non-finite or missing scores
 *     contribute as 1.0 (= blocking), matching the rollout regime.
 *   - When the gate's verdict disagrees with the legacy verdict, the
 *     divergence payload's `blockingFindingCount` aligns with the
 *     `"block"` policy: non-finite scores count as blocking even
 *     though `score >= threshold` is false on NaN.
 *
 * Exported for tests. Production caller is `handlePrReviewEnsemble`
 * (single call site as of PR 4b).
 */
export function computeShadowGateDivergence(args: ShadowDivergenceInputs): ShadowDivergenceResult {
  const { renderable, unanchored, provenance, threshold, legacyEvent } = args

  const fillScore = (f: PrReviewFinding, specialists: ReadonlyArray<string>): PrReviewFinding => ({
    ...f,
    gateScore:
      typeof f.gateScore === "number" && Number.isFinite(f.gateScore)
        ? f.gateScore
        : computeGateScore(f, { sourceSpecialists: specialists }),
  })

  const scoredRenderable = renderable.map((f, i) => fillScore(f, provenance[i]?.sourceSpecialists ?? []))
  const scoredUnanchored = unanchored.map((f) => fillScore(f, []))
  const allScored = [...scoredRenderable, ...scoredUnanchored]

  const gateEvent = chooseReviewEventWithGate({
    findings: allScored,
    threshold,
    missingScorePolicy: "block",
  })

  if (gateEvent === legacyEvent) {
    return { gateEvent, divergence: null }
  }

  // `"block"` policy treats non-finite gateScore as effective 1.0
  // (blocking). Align the telemetry counter so it doesn't under-report
  // in the (rare today, common during PR 4b shadow) case where a
  // finding sneaks through with no scored value.
  const isBlocking = (f: PrReviewFinding): boolean => {
    if (typeof f.gateScore !== "number" || !Number.isFinite(f.gateScore)) {
      return true
    }
    return f.gateScore >= threshold
  }

  return {
    gateEvent,
    divergence: {
      threshold,
      legacyEvent,
      gateEvent,
      findingCount: allScored.length,
      blockingFindingCount: allScored.filter(isBlocking).length,
      scoreSummary: allScored.map((f) => f.gateScore?.toFixed(2)).join(","),
    },
  }
}

/**
 * SIG-37 — minimal shape for items that carry a GitHub-style author
 * login. Wide enough to cover review comments, review threads' root
 * comments, and PR-review records (`listPullRequestReviews` rows) —
 * every shape Sigilix might want to gate on in the future. `user`
 * may be `null` (GitHub returns `null` for deleted authors); a
 * missing `user` deterministically falls out of the Sigilix-only
 * filter, never the other way.
 */
export interface AuthoredItem {
  user: { login: string | null } | null
}

/**
 * SIG-37 — filter any list of authored items down to those Sigilix
 * itself authored. The canonical predicate for the approval-gate
 * decision; any new call site that lists open items should run them
 * through this before checking `length === 0` for an APPROVE intent.
 *
 * Pure — `user.login === SIGILIX_BOT_LOGIN`. Items with a missing /
 * null user object, or a non-matching login, are dropped. The match
 * is case-sensitive because GitHub's bot logins always lowercase the
 * slug (`sigilix[bot]` is the exact App-emitted form).
 *
 * Exported so non-`chooseReviewEvent` callers (e.g. observability
 * code that wants to count "Sigilix-authored unresolved threads vs
 * other-actor threads" separately) reuse the same predicate.
 */
export function filterToSigilixAuthored<T extends AuthoredItem>(items: ReadonlyArray<T>): T[] {
  return items.filter((item) => item.user?.login === SIGILIX_BOT_LOGIN)
}

export function severityLabelForScore(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score >= 5) return "P0"
  if (score >= 4) return "P1"
  if (score >= 3) return "P2"
  return "P3"
}

// SIG-287: synth confidence (1-5) at or below this downgrades an otherwise-
// clean APPROVE to a neutral COMMENT — a low-confidence review must not read as
// a confident sign-off. Degraded coverage (a missing specialist) ALSO triggers
// the downgrade independently of this. Tunable knob; 2 = "low".
export const LOW_CONFIDENCE_COMMENT_THRESHOLD = 2

/**
 * Resolve the review-event override (pure, exported for test). A real
 * approval-readiness blocker escalates to REQUEST_CHANGES. Otherwise an
 * INCOMPLETE review — SIG-287 degraded coverage / low confidence, OR SIG-245
 * files dropped from review (diff-budget spill / too-large) — downgrades an
 * otherwise-clean APPROVE to a neutral COMMENT ("Sigilix looked, but this is
 * not a full sign-off"), so the body's caveat/notice actually renders instead
 * of being discarded by the marker-only APPROVE body. A clean, complete review
 * returns undefined (no override → APPROVE/REQUEST_CHANGES derived from findings).
 */
export function resolveReviewEventOverride(args: {
  hasApprovalBlocker: boolean
  reviewIncomplete: boolean
  filesDroppedCount: number
}): ReviewEventOverride | undefined {
  if (args.hasApprovalBlocker) return "REQUEST_CHANGES"
  if (args.reviewIncomplete || args.filesDroppedCount > 0) return "COMMENT"
  return undefined
}

/**
 * SIG-216: bucket a finding's score (1-5) into the same P0/P1/P2/P3
 * severity tiers the review body uses (`severityBadgeImg` in
 * `triage-pr-review.ts`) so the overview prompt and the review body
 * speak the same language. Pure.
 */
export function severityTier(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score >= 5) return "P0"
  if (score === 4) return "P1"
  if (score === 3) return "P2"
  return "P3"
}
