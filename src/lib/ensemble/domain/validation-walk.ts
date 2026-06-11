// SIG-318 (PR 8) / SIG-386 (PR2) — the per-finding WALK of validateForSubmission,
// decomposed via extract-method. Each finding (by INDEX — v3.1 catch, not by
// headline) runs the HARD-DROP gates, then (if it proceeds) the score-1 +
// DEMOTE-only gates, then is ROUTED to cleanFindings / unanchoredFindings. The
// loop + its `continue`s stay in `processFindings`; the gate runs return a
// discriminated union (the PR-12 exit-arm pattern). PR2 is a PURE refactor under
// the golden harness — counters, pushes, and the ORDERED telemetry-callback
// sequence are byte-identical to the pre-decomposition loop body.
//
// Leaf discipline (SIG-318): never VALUE-import the core (`./validation`); the
// shared phase-state types come type-only from `./validation-args`.

import type { PrReviewFinding, ReviewFindingScope } from "@/src/shared/domain/pr-review-finding"
import { deriveSide } from "@/src/shared/util/diff-positions"
import {
  backfillSecurityEvidenceFromSources,
  backfillIndependentAssessmentFromSources,
  buildFindingEvidenceRecord,
  normalizeFindingScopeForAnchorability,
  resolveLensRationale,
  findRangeAwareAnchor,
  findRepairableInlineAnchor,
} from "./validation-internals"
import { evaluateSecurityFinding, deriveSecurityBucket, AUTHZ_BUCKET } from "./gates/validate-security-finding"
import { findingClaimsIntraInstanceRace } from "./gates/validate-do-race-finding"
import { evaluateTestFinding } from "./gates/validate-test-finding"
import { evaluateLogicFinding } from "./gates/validate-logic-finding"
import { evaluateLogicRefutation } from "./gates/validate-logic-refutation"
import { evaluateRefutationSurvival } from "./gates/validate-refutation-survival"
import { evaluateLogicClaimRefutation } from "./gates/validate-logic-claim-refutation"
import { evaluatePerfFinding, perfFindingIsSelfOriginated } from "./gates/validate-perf-finding"
import { evaluateInlineGrounding } from "./gates/validate-inline-grounding"
import { evaluateAbsenceGrounding } from "./gates/validate-absence-grounding"
import { evaluateWindowBlindness } from "./gates/validate-window-blindness"
import { evaluateSecurityGrounding } from "./gates/validate-security-grounding"
import { evaluateSecurityUsage } from "./gates/validate-security-usage"
import { annotateFindingTrust } from "./gates/trust-ledger-thread"
import { dampTestingScoreForRatio, TEST_RATIO_DAMPER_THRESHOLD } from "./gates/test-ratio-damper"
import { lineInDurableObjectClass } from "@/src/features/ast-rules"
import {
  hasVaguePrefix,
  evaluateTestingFindingCitation,
  isSelfOriginatedSecurityFinding,
  sourceRolesInclude,
  firstSpecialistRoleFromSourceIds,
  type ResolvedValidationArgs,
  type ValidationContext,
  type ValidationState,
} from "./validation-args"
import type { SynthesizerProvenance } from "./validation"

/**
 * The result of running the HARD-DROP gate sequence on one finding. `kind:
 * "continue"` means the original loop would have `continue`d here (the finding
 * was dropped or demoted-to-body and pushed to `unanchoredFindings` already, all
 * via mutations on the shared `state`); `kind: "proceed"` carries the (possibly
 * cloned + score-damped + evidence-enriched) finding forward to the demote
 * gates. The PR-12 exit-arm pattern — the loop's `continue` stays in the
 * skeleton.
 */
type HardDropResult = { kind: "continue" } | { kind: "proceed"; finding: PrReviewFinding }

/**
 * SIG-386 (PR2) — the HARD-DROP gate sequence for ONE finding: hallucination
 * guard + security/independent-assessment/evidence backfills → scope
 * normalization → vague-prefix → testing-citation → tests-specificity (demote)
 * → test-ratio damper → DO-authz drop → DO-race demote → security evidence →
 * security refutation-survival → logic evidence/refutation/claim-refutation →
 * perf evidence/refutation. Mutates `state` (counters + unanchoredFindings) and
 * fires the telemetry callbacks in the SAME ORDER as the original loop.
 * Byte-identical to the original lines 1026–1446.
 */
function applyHardDropGates(
  rawFinding: PrReviewFinding,
  provenance: SynthesizerProvenance["findings"][number] | undefined,
  args: ResolvedValidationArgs,
  ctx: ValidationContext,
  state: ValidationState,
): HardDropResult {
  // `let` (not `const`): the SIG-108 auto-enrich path may swap `f` for
  // an enriched CLONE so it never mutates the raw synth finding that
  // telemetry.synthesizer.verdict aliases (CR-1 / CodeRabbit).
  let f = rawFinding

  // Hallucination guard. Defensive against malformed provenance
  // even though isValidProvenance pre-validated (belt + suspenders
  // per CR PR #35 — provenance might be partially valid).
  if (!provenance) {
    state.droppedForHallucination++
    return { kind: "continue" }
  }
  const sourceIds = Array.isArray(provenance.sourceFindingIds) ? provenance.sourceFindingIds : []
  if (sourceIds.length === 0) {
    state.droppedForHallucination++
    return { kind: "continue" }
  }
  if (!sourceIds.every((id) => ctx.validIds.has(id))) {
    state.droppedForHallucination++
    return { kind: "continue" }
  }

  // SIG-117: synth may preserve provenance but omit security
  // evidence fields copied from the original specialist findings.
  // Backfill missing `cweId`/`evidenceId` from the cited source
  // findings BEFORE any validation gates run. The clone keeps raw
  // synth telemetry intact and never overwrites fields the synth
  // already provided.
  f = backfillSecurityEvidenceFromSources(f, sourceIds, ctx.sourceEvidenceById)
  // SIG-308 (PR #290 review): restore independentAssessment dropped by
  // synthesis BEFORE the logic-refutation backstop reads it, so a logic
  // finding whose specialist justified survival isn't wrongly flagged.
  f = backfillIndependentAssessmentFromSources(f, sourceIds, ctx.sourceRationaleById)
  // Attach once after provenance/security backfills but before the demote-to-body
  // gates below. Dropped findings discard this clone; demoted findings keep the
  // same provenance block when rendered in the review body.
  f = {
    ...f,
    evidence: buildFindingEvidenceRecord({
      finding: f,
      provenance,
      specialistVerdicts: args.specialistVerdicts,
      sourceEvidenceById: ctx.sourceEvidenceById,
      validSourceIds: ctx.validIds,
    }),
  }

  // SIG-216: normalize scope BEFORE any scope-dependent gates fire.
  // LLM specialists sometimes emit `scope: "file"` for findings that
  // have a concrete `(path, line)` AND that line falls in a reviewable
  // hunk. The renderer routes any non-line scope into the Review Body
  // section, which loses the inline anchor. Force `scope: "line"` for
  // the anchorable shape so the renderer routes inline (PR #173
  // regression class). Telemeter the flip so we can measure how often
  // the LLM under-anchors; prompt tightening is a follow-up.
  {
    const fromScope: ReviewFindingScope | "undefined" = f.scope ?? "undefined"
    const normalized = normalizeFindingScopeForAnchorability(f, args.reviewable)
    if (normalized !== f) {
      console.log(
        JSON.stringify({
          event: "pr-review-scope-normalized-to-line",
          fromScope,
          path: f.path,
          line: f.line,
          category: f.category,
        }),
      )
      f = normalized
    }
  }

  // ARC-156: vague-prefix filter. Drop findings whose headline OR
  // body starts with one of the VAGUE_PREFIXES words (case-
  // sensitive, word-boundary). Runs BEFORE score-1 demotion so a
  // vague nit gets dropped outright rather than aggregated into
  // the advisory bucket. Runs AFTER hallucination guard so the
  // counter attribution is unambiguous (hallucinated findings
  // shouldn't have meaningful prefix content anyway).
  if (hasVaguePrefix(f)) {
    state.droppedForVaguePrefix++
    return { kind: "continue" }
  }

  // SIG-113: testing-evidence citation gate. Drops
  // `category: "testing"` findings that don't cite evidence —
  // suppresses the PR #110 / PR #111 hallucination class where
  // the specialist asserted "no tests exist" without inspecting
  // any test file. Runs BEFORE score-1 demotion so an unevidenced
  // nit also drops (no advisory bucket leak). Runs AFTER vague-
  // prefix + hallucination guards so the counter attribution
  // stays clean.
  const citationCheck = evaluateTestingFindingCitation(f, args.testingEvidence, args.coverageGaps)
  if (!citationCheck.keep) {
    state.droppedForUncitedTestingEvidence++
    args.onTestingFindingDropped?.(f, citationCheck.reason)
    return { kind: "continue" }
  }

  // SIG-111: tests-finding specificity gate. Runs IMMEDIATELY AFTER
  // the SIG-113 citation gate (disjoint question: SIG-113 asks "did
  // it cite something real?", this asks "is the cited finding
  // SPECIFIC enough to be a true positive?"). Applies ONLY to sev>=4
  // `category: "testing"` findings; everything else passes via the
  // pure helper's early returns. Shadow-first: in `shadow` mode the
  // verdict is counted + telemetered but the finding is NOT dropped;
  // only `enforce` actually drops. False-negative-sensitive — the
  // helper biases toward keep (deletion/rename exception preserved,
  // ambiguous shapes kept). The SIG-86 shadow aggregator instruments
  // the would-drop rate; the bake-off harness is NOT built here.
  {
    const testDecision = evaluateTestFinding(f, args.testingEvidence, args.coverageGaps)
    if (!testDecision.keep) {
      // SIG-111 / SIG-245: the tests specialist over-fires "X lacks
      // coverage" on glue covered by structural tests or with a vague,
      // non-actionable ask — the dominant labeled-FP class (21/31 in the
      // SIG-161 corpus). FN-safe: in `enforce` the finding is DEMOTED to the
      // body (still visible if the coverage gap is real) rather than dropped,
      // matching the SIG-108 / SIG-307 demote-not-drop discipline. In
      // `shadow` the would-demote is counted + telemetered but the finding is
      // kept inline. `dropped` in the telemetry callback means "actioned".
      const demoted = args.testsValidatorMode === "enforce"
      state.droppedForFailedTestValidation++
      args.onTestFindingDropped?.(f, { reason: testDecision.reason, dropped: demoted })
      if (demoted) {
        // SIG-245: cap below the score>=4 REQUEST_CHANGES floor so the
        // gate-flagged FP becomes a NON-blocking body note — visible if the
        // coverage gap is real, but the bot does NOT block a merge over a
        // coverage finding the gate itself judged low-confidence. (Differs
        // from the SIG-108 security demote, which keeps the score: a
        // weak-evidence security finding still warrants caution; a low-stakes
        // coverage over-fire does not. evaluateTestFinding only fires on
        // score>=4, so this always demotes a P0/P1 to a sub-blocker note.)
        // Clone before mutating: `f` aliases synthOutput.verdict.findings[i],
        // which is recorded to telemetry.synthesizer.verdict — capping the
        // score in place would corrupt the recorded synth score (CR #284).
        const demotedFinding: PrReviewFinding = { ...f, score: Math.min(f.score, 3) }
        if (args.trustLedgerEnabled)
          annotateFindingTrust(demotedFinding, { surface: "body", demoteReason: "tests-coverage" })
        state.unanchoredFindings.push(demotedFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding.
    }
  }

  // SIG-347 (AC #3): diff-test-ratio damper. On a visibly test-heavy PR
  // (the diff itself adds substantial tests, ratio > THRESHOLD), de-emphasize
  // a SURVIVING testing finding by one confidence point. Recall-safe: this
  // never drops — a real high-severity finding stays actionable (5→4), a
  // borderline P2 over-fire becomes a quiet P3 body note (4→3). Runs AFTER
  // the SIG-111 gate so it only touches findings the specificity check kept,
  // and clones (never mutates the synth-aliased finding the telemetry holds).
  if (f.category === "testing" && args.testToSourceRatio > TEST_RATIO_DAMPER_THRESHOLD) {
    const dampedScore = dampTestingScoreForRatio(f.score, args.testToSourceRatio)
    if (dampedScore !== f.score) {
      console.log(
        JSON.stringify({
          event: "pr-review-testing-finding-ratio-damped",
          path: f.path,
          line: f.line,
          fromScore: f.score,
          toScore: dampedScore,
          ratio: Number(args.testToSourceRatio.toFixed(3)),
        }),
      )
      f = { ...f, score: dampedScore }
    }
  }

  // SIG-141: DurableObject method-authz suppression. A DO method is only
  // invokable by the Worker holding the binding, so the binding IS the trust
  // boundary; per-tenant isolation is via the DO id, not per-method authz.
  // The security specialist over-fires "missing access check" on every new
  // DO method (false P1/P2). Suppress authz-bucket findings whose line lands
  // INSIDE a changed DurableObject class body — UNCONDITIONALLY (a
  // correctness drop, not a shadow-gated evidence policy), so it clears even
  // while the security validator runs in shadow. Scoped to the class span so
  // a real authz bug in a co-located top-level helper is still surfaced, and
  // to SECURITY-sourced findings (provenance, like the SIG-108 gate) so an
  // authz-CWE finding that actually came from logic/tests/perf is untouched.
  if (
    sourceRolesInclude(sourceIds, "security") &&
    lineInDurableObjectClass(args.doClassSpans.get(f.path.trim()), f.line) &&
    deriveSecurityBucket(f) === AUTHZ_BUCKET
  ) {
    state.droppedForFailedValidation++
    args.onSecurityFindingDropped?.(f, { reason: "do-method-authz-trust-boundary", dropped: true })
    return { kind: "continue" }
  }

  // SIG-307: DurableObject intra-instance race FP. A DO serializes EVERY
  // invocation of an instance (requests + alarms run one-at-a-time behind
  // input gates; `await` does not let another invocation of the same instance
  // interleave), so an intra-instance race/concurrency finding on a DO method
  // CANNOT be real — the SIG-141 shape for the concurrency category (observed:
  // a refuted "DO alarm scheduling race" on byte-identical-to-shipped code).
  // FN-safe: DEMOTED to the body (still visible) rather than dropped, because
  // the race-claim regex can't perfectly exclude a cross-await EXTERNAL-state
  // bug — those phrasings are carved out in the detector, and demote-not-drop
  // keeps any residual real finding visible. Logged on every fire so a false
  // demote is observable. Always-on (a correctness rule, like the authz drop).
  if (
    f.category !== "testing" &&
    f.category !== "docs" &&
    lineInDurableObjectClass(args.doClassSpans.get(f.path.trim()), f.line) &&
    findingClaimsIntraInstanceRace(f)
  ) {
    console.log(
      JSON.stringify({
        event: "do-race-finding-demoted",
        path: f.path,
        line: f.line,
        score: f.score,
        headline: (f.headline ?? "").slice(0, 100),
      }),
    )
    if (args.trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "do-race" })
    state.unanchoredFindings.push(f)
    return { kind: "continue" }
  }

  // SIG-108: security evidence gate. Applies ONLY to findings whose
  // derived role set includes `security` (from provenance, NOT from
  // `finding.category` alone — Codex #3: a merged security+logic
  // finding must still satisfy the evidence rule). A sev>=4 security
  // finding must carry a resolving evidenceId, be auto-enrichable
  // from a manifest fact at the same path/+-10 lines, or — for the
  // authz bucket — set evidenceId:"NONE" with a body justification.
  // Runs AFTER the testing gate (disjoint domains) and BEFORE score-1
  // demotion + line validation (Codex #3). Shadow-first: in `shadow`
  // mode the verdict is counted + telemetered but the finding is NOT
  // dropped; only `enforce` actually drops.
  if (args.securityManifest && sourceRolesInclude(sourceIds, "security")) {
    const decision = evaluateSecurityFinding(f, args.securityManifest)
    if (decision.keep) {
      // Auto-enrich: stamp the corroborating fact's evidenceId/cwe so
      // downstream consumers (markers, body rendering) see the
      // citation. CR-1 (CodeRabbit): clone rather than mutate — `f`
      // aliases the raw synth finding held by telemetry.synthesizer
      // .verdict; rewriting it would erase the distinction between
      // "model cited it" and "validator backfilled it" in the shadow
      // data. The enriched clone flows to the validated output; the
      // recorded synth verdict keeps the model's original.
      if (decision.enrich) {
        f = {
          ...f,
          evidenceId: decision.enrich.evidenceId,
          ...(decision.enrich.cweId && !f.cweId ? { cweId: decision.enrich.cweId } : {}),
        }
      }
    } else {
      // SIG-108 (demote-conversion, 2026-06-01): an unsupported sev>=4 security
      // finding is DEMOTED to the review body in `enforce` — NOT hard-dropped.
      // The Trust Ledger now gives it a home (the body) + an honest MODEL/GROUNDED
      // pill, so the guidance stays VISIBLE instead of vanishing (FN-cost >> FP-cost
      // for security). `shadow` keeps it inline (count only). The counter +
      // callback semantics are unchanged: `dropped` = the enforce action fired
      // (now a demote). Currently shadow in prod, so this is inert until the
      // enforce flip.
      const demoted = args.securityValidatorMode === "enforce"
      state.droppedForFailedValidation++
      args.onSecurityFindingDropped?.(f, { reason: decision.reason, dropped: demoted })
      if (demoted) {
        if (args.trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "security-evidence" })
        state.unanchoredFindings.push(f)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // SIG-325: refutation-survival backstop for SELF-ORIGINATED security
  // findings — the security analog of the SIG-308 logic gate. A sev>=4
  // security finding with no resolving manifest evidenceId (empty or "NONE")
  // is self-originated: no scanner proposed it, so the SIG-282 candidate-
  // verification path never engaged. It must articulate its mechanism
  // (source→sink→type) in `independentAssessment` or it reads as a CWE label
  // with a confabulated mechanism (the SSRF / path-traversal / prototype-
  // pollution hallucination class). Runs AFTER the SIG-108 evidence gate so an
  // auto-enriched evidenceId already marks a finding tool-backed (and thus
  // exempt). Same shadow-first + demote-to-body (not hard-drop) FN-safety as
  // the security evidence gate; `off` skips entirely.
  if (
    args.refutationSurvivalMode !== "off" &&
    sourceRolesInclude(sourceIds, "security") &&
    isSelfOriginatedSecurityFinding(f, args.securityManifest)
  ) {
    // CodeRabbit: judge against the SECURITY-lens rationale, NOT the
    // logic-scoped globally-backfilled field — a merged finding must not pass
    // the security gate on a logic rationale, and a synth-dropped security
    // rationale is restored from the security sources.
    const decision = evaluateRefutationSurvival({
      ...f,
      independentAssessment: resolveLensRationale(
        f.independentAssessment,
        sourceIds,
        ctx.sourceRationaleByIdSecurity,
        "security",
      ),
    })
    if (!decision.keep) {
      const demoted = args.refutationSurvivalMode === "enforce"
      state.droppedForFailedRefutationSurvival++
      args.onRefutationSurvivalFindingDropped?.(f, {
        reason: decision.reason,
        dropped: demoted,
        lens: "security",
      })
      if (demoted) {
        if (args.trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "refutation-survival" })
        state.unanchoredFindings.push(f)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // SIG-109: logic evidence gate. Applies ONLY to findings whose
  // derived role set includes `logic` (from the `logic-` sourceFindingId
  // prefix, NOT `finding.category` alone — mirrors the SIG-108 security
  // gate's provenance derivation). A sev>=4 logic finding must be
  // anchored to the diff: on a changed path AND backed by a co-located
  // AST hit OR a concrete backticked token on an added line; otherwise
  // it's an unanchored claim. Runs AFTER the SIG-108 security gate
  // (disjoint domains) and BEFORE score-1 demotion + line validation.
  // Shadow-first: in `shadow` mode the verdict is counted + telemetered
  // but the finding is NOT dropped; only `enforce` actually drops. This
  // gate is false-negative-sensitive (logic bugs are LLM-found with no
  // deterministic backing) so the pure helper biases hard toward keep.
  if (args.logicEvidence && sourceRolesInclude(sourceIds, "logic")) {
    const logicDecision = evaluateLogicFinding(f, args.logicEvidence)
    if (!logicDecision.keep) {
      const dropped = args.logicValidatorMode === "enforce"
      state.droppedForFailedLogicValidation++
      args.onLogicFindingDropped?.(f, { reason: logicDecision.reason, dropped })
      if (dropped) return { kind: "continue" }
      // shadow mode: fall through and keep the finding.
    }
  }

  // SIG-308: logic-refutation backstop. A sev>=4 logic-sourced finding that
  // never showed it survives refutation (no `independentAssessment`) is the
  // self-refuting-finding shape (PR #12 `sinceMs`). Phase 1's prompt is the
  // primary control (the model self-clears into `clearedLogicCandidates`);
  // this is the residual safety net. Same shadow-first semantics as the
  // SIG-109 gate — drops (continue) only in `enforce`; `off` skips entirely.
  if (args.logicRefutationMode !== "off" && sourceRolesInclude(sourceIds, "logic")) {
    const refutationDecision = evaluateLogicRefutation(f)
    if (!refutationDecision.keep) {
      const dropped = args.logicRefutationMode === "enforce"
      state.droppedForFailedLogicRefutation++
      args.onLogicRefutationFindingDropped?.(f, { reason: refutationDecision.reason, dropped })
      if (dropped) return { kind: "continue" }
      // shadow mode: fall through and keep the finding.
    }
  }

  // SIG-328/SIG-334: logic-claim refutation gate. Drops a sev>=4 logic
  // finding only when a supported claim shape is PROVABLY false against the
  // AST of the cited file. Fails OPEN on every ambiguity (the pure validator
  // re-checks category+sev), so it cannot suppress a real bug. Same
  // shadow-first semantics: only `enforce` drops.
  if (args.logicClaimRefutationMode !== "off" && sourceRolesInclude(sourceIds, "logic")) {
    const claimDecision = evaluateLogicClaimRefutation(f, {
      fullFileByPath: args.fullFileByPath,
      astCache: args.astCache,
    })
    if (!claimDecision.keep) {
      const dropped = args.logicClaimRefutationMode === "enforce"
      state.droppedForFailedLogicClaimRefutation++
      args.onLogicClaimRefutationFindingDropped?.(f, { reason: claimDecision.reason, dropped })
      if (dropped) return { kind: "continue" }
      // shadow mode: fall through and keep the finding.
    }
  }

  // SIG-110: perf-finding evidence gate. A sev>=4 performance-sourced
  // finding (derived from the `performance-` sourceFindingId prefix) must
  // be anchored to the diff: on a changed path AND backed by a co-located
  // AST perf hit OR a concrete token (from backticks / complexityEstimate
  // / hotPathIdentifier) on a changed line. Disjoint domain from the
  // logic/security gates. Shadow-first: only `enforce` drops.
  if (args.perfEvidence && sourceRolesInclude(sourceIds, "performance")) {
    const perfDecision = evaluatePerfFinding(f, args.perfEvidence)
    if (!perfDecision.keep) {
      const dropped = args.perfValidatorMode === "enforce"
      state.droppedForFailedPerfValidation++
      args.onPerfFindingDropped?.(f, { reason: perfDecision.reason, dropped })
      if (dropped) return { kind: "continue" }
      // shadow mode: fall through and keep the finding.
    }
  }

  // SIG-325: refutation-survival backstop for SELF-ORIGINATED perf findings.
  // A sev>=4 perf finding with no co-located AST perf hit (kept only via a
  // changed-token match) is the model's own assertion — no deterministic
  // analyzer flagged it. It must justify why the cost is real (the changed
  // hot path under load) in `independentAssessment` or it reads as a verdict
  // without backing (the PR #18 "recomputes HMAC — no caching" over-claim
  // class). Runs AFTER the SIG-110 evidence gate so an AST-backed perf finding
  // is already marked tool-backed (and thus exempt). Same shadow-first +
  // demote-to-body (not hard-drop) FN-safety; `off` skips entirely.
  if (
    args.refutationSurvivalMode !== "off" &&
    args.perfEvidence &&
    sourceRolesInclude(sourceIds, "performance") &&
    perfFindingIsSelfOriginated(f, args.perfEvidence)
  ) {
    // CodeRabbit: judge against the PERFORMANCE-lens rationale, NOT the
    // logic-scoped globally-backfilled field.
    const decision = evaluateRefutationSurvival({
      ...f,
      independentAssessment: resolveLensRationale(
        f.independentAssessment,
        sourceIds,
        ctx.sourceRationaleByIdPerf,
        "performance",
      ),
    })
    if (!decision.keep) {
      const demoted = args.refutationSurvivalMode === "enforce"
      state.droppedForFailedRefutationSurvival++
      args.onRefutationSurvivalFindingDropped?.(f, {
        reason: decision.reason,
        dropped: demoted,
        lens: "performance",
      })
      if (demoted) {
        if (args.trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "refutation-survival" })
        state.unanchoredFindings.push(f)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  return { kind: "proceed", finding: f }
}

/**
 * The result of running the SCORE-1 advisory demotion + the line-1 out-of-diff
 * routing + the range-aware anchor repair + the DEMOTE-only gates. `continue`
 * = the original loop would `continue` (the finding was bucketed into advisory
 * nits or demoted/dropped to body via `state`); `proceed` carries the repaired
 * `workingFinding` (+ whether the range was rewritten) to the final routing.
 */
type DemoteResult = { kind: "continue" } | { kind: "proceed"; workingFinding: PrReviewFinding; rewroteRange: boolean }

/**
 * SIG-386 (PR2) — score-1 advisory demotion → line-1 out-of-diff routing →
 * range-aware anchor repair → the 5 symmetric DEMOTE-only gates (inline-
 * grounding / absence / window-blindness / security-grounding / security-usage).
 * Mutates `state`; fires telemetry in the SAME ORDER as the original.
 * Byte-identical to the original lines 1448–1675.
 */
function applyDemoteGates(
  f: PrReviewFinding,
  sourceIds: readonly string[],
  args: ResolvedValidationArgs,
  ctx: ValidationContext,
  state: ValidationState,
): DemoteResult {
  // Score-1 advisory demotion
  if (f.score <= 1) {
    state.advisoryNits.push(f)
    state.provenanceDropped.push({
      specialist: firstSpecialistRoleFromSourceIds(sourceIds),
      sourceFindingId: sourceIds[0]!,
      headline: f.headline,
      reason: "score-1-advisory",
    })
    state.demotedScore1++
    return { kind: "continue" }
  }

  // SIG-141 + SIG-245 inline-first: a finding anchored to line 1 is often a
  // file-header over-fire (license/imports/opening comment) on a new-file PR.
  // BUT line 1 of a newly-ADDED file IS a real RIGHT diff anchor, so a genuine
  // line-1 finding (e.g. a hardcoded secret on the first line — observed on
  // the e2e repos) must still inline: inline-first means anchorable findings
  // go inline; the body is reserved for code outside the diff. So only
  // body-route a line-1 finding whose line 1 is NOT a reviewable anchor (a
  // header/import on an UNCHANGED file = genuinely outside this PR's diff).
  // When line 1 IS anchorable, fall through to the normal anchor path below,
  // which inlines it (a RIGHT line-1 anchor inlines verbatim; the
  // findRepairableInlineAnchor repair only applies when line 1 resolves
  // LEFT-only). A content over-fire is the grounding/evidence gates' job, not
  // a line-number heuristic's.
  if (f.line === 1 && !deriveSide(args.reviewable, f.path, 1)) {
    state.droppedForInvalidLine++
    if (args.trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "outside-diff" })
    state.unanchoredFindings.push(f)
    return { kind: "continue" }
  }

  // Line validity + side derivation.
  //
  // SIG-216 follow-up (Option A): a multi-line finding whose ENDPOINT
  // isn't in any RIGHT-side hunk may still be inline-anchorable if
  // the MIDDLE of the [startLine, line] range overlaps the diff. The
  // scope-normalizer already flipped scope:"line" for this case; the
  // half-measure was leaving f.line pointing at the original
  // unreviewable line so the downstream POST to GitHub would 422.
  // Rewrite both endpoints to the actually-anchorable subrange (last
  // RIGHT anchor becomes new `line`, first RIGHT anchor becomes new
  // `start_line`) so isCommentAnchorable passes and the inline POST
  // succeeds. PR #175 dogfood class.
  //
  // PR #176 CR follow-up: run the range-aware rewrite FIRST so that
  // `deriveSide` (and any subsequent validation) sees the rewritten
  // endpoints rather than the stale originals. A multi-line finding
  // whose original `startLine` is unanchorable would otherwise slip
  // through to a `start_line` 422 on the GitHub inline POST.
  const rangeAnchor = findRangeAwareAnchor(args.reviewable, f)
  let workingFinding: PrReviewFinding = f
  let rewroteRange = false
  if (rangeAnchor !== null) {
    // Drop the original `startLine` and re-apply only when the helper
    // returned a distinct top-of-underline anchor; otherwise the
    // stale original (outside the actually-anchorable subrange)
    // would fail `isCommentAnchorable` and the inline POST would
    // 422 on `start_line`.
    const { startLine: _originalStartLine, ...rest } = f
    void _originalStartLine
    workingFinding =
      rangeAnchor.startLine !== undefined
        ? { ...rest, line: rangeAnchor.line, startLine: rangeAnchor.startLine }
        : { ...rest, line: rangeAnchor.line }
    // Only count an actual rewrite (anchor differs from the original
    // endpoints) so the counter isn't inflated for findings whose
    // original anchor was already valid and matched by the helper.
    rewroteRange = workingFinding.line !== f.line || workingFinding.startLine !== f.startLine
  }

  // SIG-281 PR C (Rec 4): inline-grounding gate. A finding that reaches
  // here is a real inline candidate — it survived every hard-drop gate
  // (SIG-113/111/141/108/109/110), the score-1 advisory demotion, and
  // the range-aware anchor repair above. If it's a weakly-grounded
  // score 2-3 finding it is DEMOTED to the review body (content
  // preserved — NOT hard-dropped) so the inline surface stays
  // high-signal; score>=4 (believability floor) and score<=1 (already
  // routed to advisory above) are kept by the pure helper.
  //
  // PLACEMENT: AFTER the hard-drop gates (Codex P1 — never demote a
  // finding those gates would drop) AND AFTER anchor repair (CodeRabbit
  // Major — demote `workingFinding` so the body record + downstream
  // withdrawal matching use the REPAIRED anchor, not the raw line).
  // Shadow-first: only `enforce` demotes; `shadow` counts + telemeters
  // and keeps the finding inline.
  {
    const groundingDecision = evaluateInlineGrounding(workingFinding, {
      addedLineTextByLine: args.addedLineTextByLine,
    })
    if (!groundingDecision.keep) {
      const demoted = args.inlineGroundingValidatorMode === "enforce"
      state.droppedForFailedInlineGroundingValidation++
      args.onInlineGroundingFindingDropped?.(workingFinding, {
        reason: groundingDecision.reason,
        dropped: demoted,
      })
      if (demoted) {
        if (args.trustLedgerEnabled)
          annotateFindingTrust(workingFinding, {
            surface: "body",
            demoteReason: "inline-grounding",
          })
        state.unanchoredFindings.push(workingFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // SIG-290 v1: absence-grounding gate. An "absence-claim" finding
  // ("lacks tests", "no null check", "missing validation") is only
  // believable when the evidence that would confirm-or-refute the
  // absence was in the specialist's window. When it was PROVABLY not
  // (the sibling test was never inspected, or the cited path was
  // dropped from the diff) the bot was GUESSING — DEMOTE to the body
  // (content preserved, NOT hard-dropped). FP-safe: non-absence-claims,
  // excluded phrases, performance findings, and every UNKNOWN keep.
  //
  // PLACEMENT mirrors the inline-grounding block above (after the
  // hard-drop gates + anchor repair, so the demote routes `workingFinding`
  // with the repaired anchor). `off` skips the gate entirely; `shadow`
  // counts + telemeters and keeps the finding inline; only `enforce`
  // demotes. No score floor — a P0/P1 ungrounded absence-claim is the
  // worst case and is demoted too.
  if (args.absenceClaimValidatorMode !== "off") {
    const absenceDecision = evaluateAbsenceGrounding(workingFinding, {
      testingEvidence: args.testingEvidence,
      reviewablePaths: ctx.reviewablePaths,
      wasTruncated: args.wasTruncated,
      droppedPaths: args.droppedPaths,
    })
    if (!absenceDecision.keep) {
      const demoted = args.absenceClaimValidatorMode === "enforce"
      state.droppedForFailedAbsenceGroundingValidation++
      args.onAbsenceFindingDropped?.(workingFinding, {
        reason: absenceDecision.reason,
        dropped: demoted,
      })
      if (demoted) {
        if (args.trustLedgerEnabled)
          annotateFindingTrust(workingFinding, {
            surface: "body",
            demoteReason: "absence-grounding",
          })
        state.unanchoredFindings.push(workingFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // Cross-cutting over-fire Option B: window-blindness gate. A sev>=4 LOGIC
  // positive misread ("X can be undefined / returns NaN / is unbounded") is a
  // window-blindness FP when the guard on the SAME cited symbol is provably
  // present in the FULL file but OUTSIDE the diff window the model saw —
  // upstream of the flagged use, at a dominating indent, within the proximity
  // bound. DEMOTE to the body (content preserved, NOT hard-dropped). FP-safe:
  // non-logic, sub-4, non-misread, no full file, no out-of-window guard, and
  // every ambiguity keep. The deterministic backstop to PR #327's prompt fence.
  //
  // PLACEMENT mirrors the absence-grounding block above (after the hard-drop
  // gates + anchor repair, so the demote routes `workingFinding` with the
  // repaired anchor). `off` skips the gate; `shadow` counts + telemeters and
  // keeps inline; only `enforce` demotes.
  if (args.windowBlindnessValidatorMode !== "off") {
    const wbDecision = evaluateWindowBlindness(workingFinding, {
      fullFileByPath: args.fullFileByPath,
      windowLinesByPath: ctx.windowLinesByPath,
    })
    if (!wbDecision.keep) {
      const demoted = args.windowBlindnessValidatorMode === "enforce"
      state.droppedForFailedWindowBlindnessValidation++
      args.onWindowBlindnessFindingDropped?.(workingFinding, {
        reason: wbDecision.reason,
        matchedIdentifier: wbDecision.matchedIdentifier,
        guardLine: wbDecision.guardLine,
        dropped: demoted,
      })
      if (demoted) {
        if (args.trustLedgerEnabled)
          annotateFindingTrust(workingFinding, {
            surface: "body",
            demoteReason: "window-blindness",
          })
        state.unanchoredFindings.push(workingFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // SIG-293 v1: security-grounding gate (secrets-exposure). A
  // `secrets-exposure` (CWE-798) finding is only believable when the
  // cited code actually CONTAINS a credential token. One whose cited
  // line holds no credential (the #243 FP: a sev-3 finding that misread
  // `console.log(payload.length)` as a leak) is a hallucination — DEMOTE
  // to the body (content preserved, NOT hard-dropped). v1 gates ONLY
  // secrets-exposure (the single line-level-detectable category); a
  // corroborating scanner fact ALWAYS keeps. Scoped to SECURITY-sourced
  // findings (provenance, like the SIG-108 evidence gate) so a non-
  // security finding that merely carries CWE-798 is untouched.
  //
  // PLACEMENT mirrors the inline/absence blocks above (after the hard-
  // drop gates + anchor repair, so the demote routes `workingFinding`
  // with the repaired anchor). `off` skips the gate; `shadow` counts +
  // telemeters and keeps inline; only `enforce` demotes. No score floor —
  // a P0/P1 ungrounded secrets claim is the worst case and is demoted too.
  if (args.securityGroundingValidatorMode !== "off" && sourceRolesInclude(sourceIds, "security")) {
    const sgDecision = evaluateSecurityGrounding(workingFinding, {
      addedLineTextByLine: args.addedLineTextByLine,
      manifest: args.securityManifest,
    })
    if (!sgDecision.keep) {
      const demoted = args.securityGroundingValidatorMode === "enforce"
      state.droppedForFailedSecurityGroundingValidation++
      args.onSecurityGroundingFindingDropped?.(workingFinding, {
        reason: sgDecision.reason,
        dropped: demoted,
      })
      if (demoted) {
        if (args.trustLedgerEnabled)
          annotateFindingTrust(workingFinding, {
            surface: "body",
            demoteReason: "security-grounding",
          })
        state.unanchoredFindings.push(workingFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  // SIG-311 Layers A+B: security USAGE-vs-MENTION gate. Demote a sev>=4
  // injection/xss finding on a detector/validator/test/doc path whose cited
  // token is a mention, not a live sink (the PR #296 self-FP family). Same
  // off/shadow/enforce placement as the grounding gate above; DEMOTE-not-drop,
  // keep on any uncertainty (the gate fails closed inside evaluateSecurityUsage).
  if (args.securityUsageValidatorMode !== "off" && sourceRolesInclude(sourceIds, "security")) {
    const suDecision = evaluateSecurityUsage(workingFinding, {
      addedLineTextByLine: args.addedLineTextByLine,
    })
    if (!suDecision.keep) {
      const demoted = args.securityUsageValidatorMode === "enforce"
      state.droppedForFailedSecurityUsageValidation++
      args.onSecurityUsageFindingDropped?.(workingFinding, {
        reason: suDecision.reason,
        dropped: demoted,
      })
      if (demoted) {
        if (args.trustLedgerEnabled)
          annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "security-usage" })
        state.unanchoredFindings.push(workingFinding)
        return { kind: "continue" }
      }
      // shadow mode: fall through and keep the finding inline.
    }
  }

  return { kind: "proceed", workingFinding, rewroteRange }
}

/**
 * SIG-386 (PR2) — final side derivation + the last-ditch inline anchor repair +
 * push to `cleanFindings` (+ index-aligned provenance) OR `unanchoredFindings`.
 * Void: mutates `state`. Byte-identical to the original lines 1677–1703.
 */
function routeFinding(
  workingFinding: PrReviewFinding,
  rewroteRange: boolean,
  provenance: SynthesizerProvenance["findings"][number] | undefined,
  args: ResolvedValidationArgs,
  state: ValidationState,
): void {
  const side = deriveSide(args.reviewable, workingFinding.path, workingFinding.line)
  if (!side) {
    const repairedLine =
      workingFinding.startLine == null
        ? findRepairableInlineAnchor({
            finding: workingFinding,
            reviewable: args.reviewable,
            addedLineTextByLine: args.addedLineTextByLine,
          })
        : null
    if (repairedLine !== null) {
      state.cleanFindings.push({ ...workingFinding, line: repairedLine })
      if (provenance) state.cleanFindingProvenance.push(provenance)
      state.remappedInvalidLineToInline++
      return
    }
    state.droppedForInvalidLine++
    // Preserve for submit-fallback. Inline anchoring would fail here,
    // but the finding's *content* is still actionable when posted as
    // free-form markdown in the body of an anchorless review.
    if (args.trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "outside-diff" })
    state.unanchoredFindings.push(workingFinding)
    return
  }
  state.cleanFindings.push(workingFinding)
  if (rewroteRange) state.remappedInvalidLineToInline++
  // ARC-189: keep the per-clean-finding provenance aligned by index
  // for the ensemble caller's marker-emission step. `provenance` is
  // narrowed by the hallucination guard above (sourceIds.length >= 1
  // implies provenance was non-null).
  if (provenance) state.cleanFindingProvenance.push(provenance)
}

/**
 * SIG-386 (PR2) — the per-finding walk: for each finding (by INDEX — v3.1 catch,
 * not by headline) run the hard-drop gates, then (if it proceeds) the score-1 +
 * demote gates, then route it. Mutates `state` in the EXACT increment + push +
 * telemetry order of the original loop. Byte-identical to the original lines
 * 1018–1704.
 */
export function processFindings(args: ResolvedValidationArgs, ctx: ValidationContext, state: ValidationState): void {
  // Walk by INDEX (v3.1 catch — not by headline).
  for (let i = 0; i < args.synthOutput.verdict.findings.length; i++) {
    const rawFinding = args.synthOutput.verdict.findings[i]!
    const provenance = args.synthOutput.provenance.findings[i]

    const hardDrop = applyHardDropGates(rawFinding, provenance, args, ctx, state)
    if (hardDrop.kind === "continue") continue
    const f = hardDrop.finding

    // `provenance` is narrowed non-null here (applyHardDropGates returns
    // "continue" when it is missing), and its sourceFindingIds drove the
    // gate routing — re-derive the same `sourceIds` for the demote phase.
    const sourceIds = Array.isArray(provenance!.sourceFindingIds) ? provenance!.sourceFindingIds : []

    const demote = applyDemoteGates(f, sourceIds, args, ctx, state)
    if (demote.kind === "continue") continue

    routeFinding(demote.workingFinding, demote.rewroteRange, provenance, args, state)
  }
}
