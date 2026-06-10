// SIG-318 (PR 12e) — the VERIFY-AND-BUILD phase of the PR-review orchestrator
// (app layer). Carved verbatim from `handlePrReviewEnsemble`, between merge-guard
// #2 (which stays in the orchestrator) and the inline-overview section (12f): the
// detached gate-shadow IIFE (SIG-161 shadow telemetry, fire-and-forget — NOT
// awaited), the SIG-285 verification / refuted-demote (the only enforce-path
// mutation) + the v2 receipt-join + the Trust Ledger v0 baseline annotation +
// the evidence/scope telemetry, then the submission build itself (the affordance
// preparation via the relocated cluster, `buildReviewSubmissionWithMetadata` with
// the `captureGolden(env, "render", …)` seam moving inside untouched, and the
// `applyOutputSurfaceToSubmission` surface strip).
//
// The moved statements are byte-identical with NO reordering; only the function
// wrapper + the explicit arg/result plumbing is new. ZERO behavior change.
//
// THE INDEX-ALIGNMENT INVARIANT: the refuted-demote mutates `submissionVerdict.findings`,
// `findingMarkers`, and `renderableUnanchoredForSubmission` in lockstep so the
// marker<->finding alignment the builder indexes by (SIG-127) survives. The first
// two are reassigned (a plain reassignment of a local binding is NOT visible to the
// caller by reference), so all three are passed in AND returned explicitly.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home
// (the verdict/gates domains, the verification leaves, the lib leaves). SIG-365
// (PR 13): the render builders (`buildReviewSubmissionWithMetadata`,
// `buildBodyOnlyCheckAnnotations`, `previewReviewSubmissionEvent`,
// `getProposedChangeScopeMismatch`) now import from their canonical
// `../render/{submission,finding-format}` home (the render layer), no longer the
// god-file shim — the formerly-documented laterals are gone;
// `evidencePieceCountForTelemetry` comes from the validation domain. The
// affordance preparation (`prepareSubmissionAffordance`) comes from the relocated
// `./affordances` app module. It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewVerdict, PrReviewFinding, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import type { PullRequestMeta } from "@/src/shared/types/github"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import { getProposedChangeScopeMismatch } from "@/src/lib/ensemble/render/finding-format"
import { buildBodyOnlyCheckAnnotations } from "@/src/lib/ensemble/render/finding-comment"
import {
  buildReviewSubmissionWithMetadata,
  previewReviewSubmissionEvent,
} from "@/src/lib/ensemble/render/submission"
import type { DeltaBadgeCounts } from "@/src/lib/ensemble/render/review-body"
import { evidencePieceCountForTelemetry } from "@/src/lib/ensemble/domain/validation"
import { readGateMode, readGateThreshold } from "@/src/lib/gate-config"
import { computeShadowGateDivergence } from "@/src/lib/ensemble/domain/verdict"
import { applyOutputSurfaceToSubmission } from "@/src/lib/pr-review-check-run"
import { captureGolden } from "@/src/lib/ensemble-golden-capture"
import {
  verifyFinding,
  findingKey,
  selectRefutedInlineDemotions,
  applyRefutedDemotion,
  planReanchor,
} from "@/src/lib/verification/verify-finding"
import {
  verifyFindingAgainstReceipt,
  type ReceiptScanResult,
} from "@/src/lib/verification/verify-finding-receipt"
import { recordVerificationMetricsBounded } from "@/src/lib/verification-metrics-client"
import { RECEIPTJOIN_CATEGORY, TRUSTLEDGER_CATEGORY, type RecordVerificationArgs } from "@/src/do/verification-metrics"
import { annotateFindingTrust } from "@/src/lib/ensemble/domain/gates/trust-ledger-thread"
import { assessApprovalReadiness } from "@/src/lib/approval-readiness"
import { chooseReviewEvent, resolveReviewEventOverride, type ReviewEvent } from "@/src/lib/ensemble/domain/verdict"
import { parseDiffToReviewablePositions } from "@/src/lib/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules"
import { readVerificationMode } from "@/src/lib/verification/mode"
import type { ReceiptJoinMode } from "@/src/lib/verification/verify-finding-receipt"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { StackContext } from "@/src/lib/pr-stack"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import {
  prepareSubmissionAffordance,
  type SubmissionAffordance,
} from "./affordances"

type ReviewableMap = ReturnType<typeof parseDiffToReviewablePositions>
type AddedLineTextByLine = ReturnType<typeof buildAddedLineTextByLine>
type SynthesizerProvenanceFindings = SynthesizerProvenance["findings"]
/**
 * The filtered (keepIndex-projected) parallel provenance view from render-prep —
 * `(entry | undefined)[]` under `noUncheckedIndexedAccess` (the shadow-divergence
 * snapshot reads it tolerating the optional element).
 */
type FilteredProvenance = Array<SynthesizerProvenanceFindings[number] | undefined>

export interface VerifyAndBuildArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  /** The dispatcher's mutable validation-rejection sink (the refuted/re-anchor gates push to it). */
  validationSink: ValidationRejectionEvent[] | undefined
  meta: PullRequestMeta
  reviewable: ReviewableMap
  addedLineTextByLine: AddedLineTextByLine
  stack: StackContext
  coverage: CoverageRoles
  deltaCounts: DeltaBadgeCounts | null
  filesDroppedFromReview: string[]
  /** The render-event resolution from render-prep (read by the gate-shadow + approval-readiness telemetry). */
  approvalReadiness: ReturnType<typeof assessApprovalReadiness>
  effectiveEvent: ReturnType<typeof assessApprovalReadiness>["event"]
  intendedEvent: ReturnType<typeof chooseReviewEvent>
  reviewEventOverride: ReturnType<typeof resolveReviewEventOverride>
  /** Verification / receipt-join / trust-ledger inputs. */
  verificationMode: ReturnType<typeof readVerificationMode>
  receiptScanIndex: Map<string, ReceiptScanResult[]> | null
  receiptJoinMode: ReceiptJoinMode
  trustLedgerMode: EnsembleConfig["flags"]["trustLedgerMode"]
  showEvidence: boolean
  /** The withdrawal-filtered, consensus-ranked parallel views from render-prep (gate-shadow snapshot). */
  filteredConsensusByIndex: number[]
  filteredConsensusProvenance: FilteredProvenance
  /** Diagnostic trace context for the render golden-capture seam (NOT asserted by the parity test). */
  degradedCoverage: { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } | null
  reviewIncomplete: boolean
  synthConfidence: number
  tokenUsageByModel: TokenUsageByModel
  /**
   * Mutated in lockstep by the refuted-demote (passed in AND returned): the verdict's
   * findings + the parallel marker array are reassigned; the unanchored set is pushed to.
   */
  submissionVerdict: PrReviewVerdict
  renderableUnanchoredForSubmission: PrReviewFinding[]
  findingMarkers: Array<string | null>
}

export interface VerifyAndBuildResult {
  submissionVerdict: PrReviewVerdict
  renderableUnanchoredForSubmission: PrReviewFinding[]
  findingMarkers: Array<string | null>
  primaryEvent: ReturnType<typeof previewReviewSubmissionEvent>
  primaryAffordance: SubmissionAffordance
  prepareFallbackAffordance: (event: ReviewEvent) => Promise<SubmissionAffordance>
  submissionBuild: ReturnType<typeof buildReviewSubmissionWithMetadata>
  submission: ReturnType<typeof buildReviewSubmissionWithMetadata>["submission"]
  bodyOnlyAnnotations: ReturnType<typeof buildReviewSubmissionWithMetadata>["bodyOnlyAnnotations"]
  allFindingAnnotations: CheckRunAnnotation[]
  checkAnnotationMeta: (annotations: CheckRunAnnotation[]) => { checkAnnotations: CheckRunAnnotation[] } | Record<string, never>
  reviewOutputSurface: EnsembleConfig["flags"]["reviewOutputSurface"]
}

export async function verifyAndBuildSubmission(a: VerifyAndBuildArgs): Promise<VerifyAndBuildResult> {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
    ensembleConfig,
    validationSink,
    meta,
    reviewable,
    addedLineTextByLine,
    stack,
    coverage,
    deltaCounts,
    filesDroppedFromReview,
    approvalReadiness,
    effectiveEvent,
    intendedEvent,
    reviewEventOverride,
    verificationMode,
    receiptScanIndex,
    receiptJoinMode,
    trustLedgerMode,
    showEvidence,
    filteredConsensusByIndex,
    filteredConsensusProvenance,
    degradedCoverage,
    reviewIncomplete,
    synthConfidence,
    tokenUsageByModel,
    submissionVerdict,
    renderableUnanchoredForSubmission,
  } = a
  // `findingMarkers` is reassigned by the refuted-demote, so it is a local `let`
  // (mirrors the orchestrator's `let findingMarkers` at the merge-guard boundary)
  // and is returned explicitly below.
  let findingMarkers = a.findingMarkers
    // SIG-101/SIG-205: approval-readiness blockers can still force a
    // REQUEST_CHANGES review even though they render in the body. The
    // review counter itself is bumped later, after the renderer chooses
    // the final event from the rendered surface, so body-only findings
    // BELOW the blocker floor (score < 4) do not advance the
    // request-changes sequence. SIG-281 PR A: a body-only finding of
    // score >= 4 now DOES escalate the rendered event to REQUEST_CHANGES
    // (the believability floor) and therefore advances the sequence,
    // even without an approval-readiness blocker.
    if (approvalReadiness.blockers.length > 0) {
      console.warn(JSON.stringify({
        event: "pr-review-approval-readiness-blocked",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        legacy_event: intendedEvent,
        effective_event: effectiveEvent,
        blockers: approvalReadiness.blockers.slice(0, 5).map((b) => ({
          sourceFindingId: b.sourceFindingId,
          role: b.role,
          path: b.path,
          line: b.line,
          score: b.score,
          confidence: b.confidence,
          headline: b.headline,
        })),
      }))
    }

    // SIG-161 PR 4b — shadow-mode telemetry. Off the critical path:
    // the KV read + divergence compute + log write are dispatched as
    // a detached promise so a slow KV cold-read or anything else CANNOT
    // delay the customer-visible verdict submission below.
    //
    // CodeRabbit catch (PR #146 fix-up #2): the prior version `await`ed
    // `readGateThreshold` inline, which added a KV read latency budget
    // to every production review even though shadow is observation-
    // only. Fire-and-forget here is acceptable because the work is
    // small (single KV read + ~1ms compute + single console.log) and
    // CF Workers' microtask queue drains before the isolate is killed.
    // If shadow ever grows expensive enough to warrant `ctx.waitUntil`,
    // plumb the ExecutionContext through `EnsembleHandlerArgs`.
    //
    // The pure-helper `computeShadowGateDivergence` lives in
    // triage-pr-review.ts (unit-tested there); this call site just
    // does the I/O — read env, read KV threshold, write the log.
    // Wrapped in try/catch so a KV outage / compute failure CANNOT
    // surface as an unhandled rejection.
    const gateMode = readGateMode(env)
    if (gateMode !== "off") {
      // Snapshot the inputs at the (sync) call site so the detached
      // task doesn't race with later mutation of `renderableVerdict`.
      const snapshotRenderable: PrReviewFinding[] = [...submissionVerdict.findings]
      const snapshotUnanchored: PrReviewFinding[] = [...renderableUnanchoredForSubmission]
      const snapshotProvenance = [...filteredConsensusProvenance]
      const snapshotLegacy = effectiveEvent
      void (async () => {
        try {
          const threshold = await readGateThreshold(env)
          const result = computeShadowGateDivergence({
            renderable: snapshotRenderable,
            unanchored: snapshotUnanchored,
            provenance: snapshotProvenance,
            threshold,
            legacyEvent: snapshotLegacy,
          })
          if (result.divergence) {
            console.log(
              JSON.stringify({
                event: "pr-review-gate-shadow-divergence",
                owner,
                repo,
                prNumber,
                headSha: headSha.slice(0, 7),
                mode: gateMode,
                ...result.divergence,
              }),
            )
          }
        } catch (err) {
          console.log(
            JSON.stringify({
              event: "pr-review-gate-shadow-error",
              owner,
              repo,
              prNumber,
              headSha: headSha.slice(0, 7),
              mode: gateMode,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })()
    }

    // SIG-285 PR 1 (shadow): verification-by-execution, observe-only. For the
    // findings we're about to submit, re-check that the code token each score>=4
    // logic/security finding CITES actually appears at the line it points to
    // (worker-native, line-anchored — no subprocess, no new perms). Emit the
    // verdict (confirmed/refuted/inconclusive/no-check) keyed for a SIG-114
    // outcome join (the refutable-FP fraction). SIG-285 PR 4: in `enforce`, a
    // REFUTED score>=4 logic/security finding that is currently INLINE is a
    // mis-anchored citation — DEMOTE it to the PR body (never drop; FN-cost >>
    // FP-cost). The demote moves a mis-anchored INLINE comment to a body row; it
    // does NOT unblock the merge (a score>=4 body finding still forces
    // REQUEST_CHANGES via the SIG-281 body-only floor) — it changes the surface,
    // not the gate. `shadow` observes-only (counts the would-demote). Off = no
    // work. The move runs BEFORE buildReviewSubmissionWithMetadata so the event +
    // marker alignment recompute over the post-demote split.
    if (verificationMode !== "off") {
      // Cover EVERY submitted score>=4 logic/security finding — inline AND the
      // body-only (unanchored) ones — so the refutable-FP measurement isn't
      // biased by which surface a finding landed on (CR).
      const submittedFindings = [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ]
      const verificationItems: RecordVerificationArgs[] = []
      for (const finding of submittedFindings) {
        if (finding.score < 4) continue
        if (finding.category !== "logic" && finding.category !== "security") continue
        const result = verifyFinding(finding, addedLineTextByLine)
        console.log(JSON.stringify({
          event: "verification-shadow",
          gate: "verification",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding),
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
          verdict: result.verdict,
          tokenCount: result.tokens.length,
          ...(result.check ? { checkKind: result.check.kind, checkStatus: result.check.status } : {}),
        }))
        verificationItems.push({ verdict: result.verdict, category: finding.category })
        // Trust Ledger: a CONFIRMED worker-token re-check (the cited token is
        // present at the cited line) is a proof signal. Annotate in place — the
        // finding object's identity is reused by selectRefutedInlineDemotions +
        // the marker index below, so we must not swap it for a clone. Gated on the
        // flag so `off` is a true no-op (no trust mutation at all).
        if (trustLedgerMode !== "off" && result.verdict === "confirmed") {
          annotateFindingTrust(finding, { signals: ["worker-token-confirmed"] })
        }
      }
      // SIG-285 PR 2: persist the review's verdict distribution to
      // VerificationMetricsDO (one batched RPC). Best-effort + bounded so a
      // stalled DO can't eat orchestrator time, and a failure NEVER breaks the
      // review (telemetry only). Read via GET /metrics/verification.
      await recordVerificationMetricsBounded(
        env, verificationItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
      // SIG-285 PR 4: the demote subset = the REFUTED inline findings (pure,
      // unit-tested helper). Record the demote decision per finding on the shared
      // validation corpus (gate `verification-refuted`, readable at
      // /metrics/validation alongside the grounding gates) — `dropped` = actually
      // demoted (enforce) vs would-demote (shadow), matching the gates' semantics.
      const refutedInline = selectRefutedInlineDemotions(submissionVerdict.findings, addedLineTextByLine)
      const demoting = verificationMode === "enforce"
      for (const finding of refutedInline) {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "verification-refuted",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: "refuted-citation",
          dropped: demoting,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        validationSink?.push({ kind: "gate-rejection", gate: "verification-refuted", reason: "refuted-citation", dropped: demoting })
        // SIG-285 (inline-first, SHADOW measurement only — NO mutation in this
        // PR): for each refuted finding, would it RE-ANCHOR to the correct added
        // line (the inline-first fix) or only body-demote? Measures the
        // would-reanchor rate (reanchor | ambiguous | no-match) at
        // /metrics/validation (gate `verification-reanchor`) BEFORE the PR that
        // actually mutates the line (which must run before marker generation).
        const reanchor = planReanchor(finding, addedLineTextByLine)
        console.log(JSON.stringify({
          event: "verification-reanchor-shadow",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding), // parity with verification-shadow for the SIG-114 join
          path: finding.path,
          fromLine: finding.line,
          decision: reanchor.kind,
          ...(reanchor.kind === "reanchor" ? { toLine: reanchor.toLine } : {}),
          ...(reanchor.kind === "ambiguous" ? { candidateLines: reanchor.candidateLines } : {}),
        }))
        validationSink?.push({ kind: "gate-rejection", gate: "verification-reanchor", reason: reanchor.kind, dropped: false })
      }
      // Enforce only: move the refuted findings from the inline set to the
      // body-only set BEFORE buildReviewSubmissionWithMetadata. The builder
      // re-derives the review event from the post-demote inline/body split, so a
      // demoted finding stops being an inline comment — but it is NOT unblocked:
      // it is still score>=4, and the SIG-281 body-only floor keeps a score>=4
      // body finding at REQUEST_CHANGES. The demote changes the SURFACE (a
      // mis-anchored inline thread becomes a body row), not the gate. Never
      // hard-drops; stays fully visible. `applyRefutedDemotion` filters
      // findingMarkers in lockstep so the marker<->finding alignment the builder
      // indexes by (SIG-127) survives. Inline findings were already
      // withdrawal-filtered, so the move can't re-introduce a dismissed finding.
      if (demoting && refutedInline.length > 0) {
        const { keptFindings, keptMarkers, demoted } = applyRefutedDemotion(
          submissionVerdict.findings,
          findingMarkers,
          new Set<PrReviewFinding>(refutedInline),
        )
        submissionVerdict.findings = keptFindings
        findingMarkers = keptMarkers
        // Trust Ledger: these refuted findings are now body-routed because their
        // inline citation was mis-anchored. Mark the surface + reason (the tier
        // stays whatever stronger proof it carries — resolveTier never lowers it).
        if (trustLedgerMode !== "off") {
          for (const d of demoted) {
            annotateFindingTrust(d, { surface: "body", demoteReason: "verification-refuted" })
          }
        }
        renderableUnanchoredForSubmission.push(...demoted)
      }
    }

    // SIG-285 v2 PR1 (receipt-join, no-perm, shadow): when a VERIFIED runner
    // receipt is present (receiptScanIndex built above), re-check each submitted
    // score>=4 SECURITY finding with a resolvable evidenceId against HEAD's OWN
    // scan — CONFIRMED if the same rule still fires at the cited path/line,
    // INCONCLUSIVE otherwise (NEVER refuted; absence is over-determined). PR1 is
    // TELEMETRY ONLY (event:verification-receiptjoin keyed findingKey for the
    // SIG-114 join); it measures the refutable-eligible fraction that decides
    // whether the demote path (PR4/5) is worth building vs receipts-as-trust.
    // Independent of OPENCLAW_VERIFICATION_MODE; gated by the index being built.
    if (receiptScanIndex !== null) {
      const rjMode = receiptJoinMode
      // SIG-285 v2 PR2: persist the verdict distribution to VerificationMetricsDO
      // under RECEIPTJOIN_CATEGORY (a separate corpus from worker-token) so the
      // refutable-eligible fraction is readable at GET /metrics/verification —
      // the load-bearing measurement, not just live `wrangler tail`.
      const receiptJoinItems: RecordVerificationArgs[] = []
      for (const finding of [...submissionVerdict.findings, ...renderableUnanchoredForSubmission]) {
        if (finding.score < 4 || finding.category !== "security") continue
        const result = verifyFindingAgainstReceipt(finding, receiptScanIndex)
        if (result.verdict === "no-check") continue
        console.log(JSON.stringify({
          event: "verification-receiptjoin",
          mode: rjMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding),
          path: finding.path,
          line: finding.line,
          score: finding.score,
          verdict: result.verdict,
          ...(result.check ? { checkStatus: result.check.status } : {}),
        }))
        receiptJoinItems.push({ verdict: result.verdict, category: RECEIPTJOIN_CATEGORY })
        // Trust Ledger: a CONFIRMED receipt join (the same rule still fires in the
        // VERIFIED runner receipt's HEAD scan) is the STRONGEST proof tier. In place
        // (identity already preserved by this point — post-demote). Flag-gated.
        if (trustLedgerMode !== "off" && result.verdict === "confirmed") {
          annotateFindingTrust(finding, { signals: ["runner-confirmed"] })
        }
      }
      // Best-effort + bounded (same as the worker-token block) — a stalled DO or
      // a record failure NEVER breaks the review (measurement only).
      await recordVerificationMetricsBounded(
        env, receiptJoinItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
    }

    // SIG Trust Ledger v0: give every final visible
    // finding a BASELINE trust tier (the strong proof signals — worker-token-confirmed,
    // runner-confirmed — were already set in place above), then record the per-tier
    // distribution. The baseline is surface-aware + honest-conservative:
    //   - INLINE findings passed validation AND anchored, so they have grounding →
    //     grounded-model (or deterministic-grounded with a real manifest evidenceId,
    //     the SIG-108 security-evidence path).
    //   - BODY findings claim NO grounding by default → body-only-ungrounded (the
    //     MODEL pill), lifted only by a real evidenceId or a proof signal above. We
    //     under-claim rather than over-claim believability for body-routed findings.
    // resolveTier keeps the stronger tier, so a baseline never lowers a proven
    // finding. Distribution persists to VerificationMetricsDO under TRUSTLEDGER_CATEGORY
    // (a SEPARATE corpus, read at GET /metrics/verification). Whole block is flag-gated,
    // so `off` (default) is a true no-op; `on` lets the renderer surface these
    // tiers as the Trust Summary and per-finding pills.
    if (trustLedgerMode !== "off") {
      const hasManifestEvidence = (finding: PrReviewFinding): boolean => {
        const ev = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""
        return ev.length > 0 && ev !== "NONE"
      }
      for (const finding of submissionVerdict.findings) {
        annotateFindingTrust(finding, {
          signals: [hasManifestEvidence(finding) ? "deterministic-grounded" : "grounded-model"],
          surface: "inline",
        })
      }
      for (const finding of renderableUnanchoredForSubmission) {
        annotateFindingTrust(finding, {
          signals: [hasManifestEvidence(finding) ? "deterministic-grounded" : "body-only-ungrounded"],
          surface: "body",
        })
      }
      const trustItems: RecordVerificationArgs[] = [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ].map((finding) => ({
        verdict: finding.trust?.tier ?? "body-only-ungrounded",
        category: TRUSTLEDGER_CATEGORY,
      }))
      // Best-effort + bounded (same as the verification blocks) — a stalled DO or a
      // record failure NEVER breaks the review (measurement only).
      await recordVerificationMetricsBounded(
        env, trustItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
    }

    if (showEvidence) {
      for (const [index, finding] of [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ].entries()) {
        const record = finding.evidence
        const evidencePieces = evidencePieceCountForTelemetry(record)
        console.log(JSON.stringify({
          event: "pr-review-evidence-emitted",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          index,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
          visible: true,
          specialists_flagged: record?.specialistsThatFlagged.length ?? 0,
          specialists_declined: record?.specialistsThatDeclined.length ?? 0,
          deterministic_fact_ids: record?.deterministicFactIds.length ?? 0,
          retrieval_chunk_ids: record?.retrievalChunkIds.length ?? 0,
          related_prior_prs: record?.relatedPriorPRs.length ?? 0,
          consensus_score: record?.consensusScore ?? 0,
          synth_decision: record?.synthDecision ?? null,
          structured_evidence_empty: evidencePieces === 0,
        }))
      }
    }

    for (const finding of submissionVerdict.findings) {
      const mismatch = getProposedChangeScopeMismatch(finding)
      if (mismatch === null) continue
      console.log(JSON.stringify({
        event: "pr-review-finding-anchor-scope-mismatch",
        gate: "rendering",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        reason: "replacement_anchor_scope_mismatch",
        dropped: false,
        path: finding.path,
        line: finding.line,
        startLine: finding.startLine ?? null,
        score: finding.score,
        category: finding.category,
        anchorLines: mismatch.anchorLines,
        replacementLines: mismatch.replacementLines,
        replacementToAnchorRatio: Number(mismatch.replacementToAnchorRatio.toFixed(3)),
      }))
    }

    const primaryEvent = previewReviewSubmissionEvent({
      verdict: submissionVerdict,
      headSha,
      unanchored: renderableUnanchoredForSubmission,
      reviewable,
      addedLineTextByLine,
      ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
    })
    const primaryAffordance = await prepareSubmissionAffordance({
      env, owner, repo, prNumber, event: primaryEvent,
    })
    const prepareFallbackAffordance = async (event: ReviewEvent): Promise<SubmissionAffordance> =>
      event === primaryEvent
        ? primaryAffordance
        : prepareSubmissionAffordance({ env, owner, repo, prNumber, event })

    // SIG-318 (PR 0b): bind the render args so the golden-capture hook below
    // records the EXACT object passed to buildReviewSubmissionWithMetadata (no
    // behavior change — same object, same call). No-op unless
    // OPENCLAW_GOLDEN_CAPTURE === "on".
    const submissionBuildArgs = {
      verdict: submissionVerdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
      // SIG Trust Ledger v0: render the trust layer (Trust Summary + per-finding
      // VERIFIED/GROUNDED/MODEL pills) only in `on` mode. off/shadow → byte-identical
      // body. (The Summary's `suppressed` count is a PR3b follow-up.)
      trustLedger: trustLedgerMode === "on",
      showEvidence,
      unanchored: renderableUnanchoredForSubmission,
      findingMarkers,
      ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
      // ARC-182 (code-review C1): thread stack so the renderer can
      // append the `_(Stacked on #N)_` parenthetical to the summary
      // (post-ARC-281 — used to be a multi-line "### Stack context"
      // block). Without this the parenthetical only appears on the
      // single-model path, which is now dead.
      ...(stack.isStacked ? { stack } : {}),
      // ARC-281: thread specialist coverage + delta counts through
      // to the new renderer.
      coverage,
      // SIG-245: files dropped from review (diff-budget spill into a later
      // batch, or individually too large) → a visible "files not reviewed"
      // notice in the body so a silently-dropped file is never invisible. The
      // review is also downgraded APPROVE→COMMENT above so this notice renders
      // even when batch[0] was clean (it would be discarded by the marker-only
      // APPROVE body otherwise).
      notReviewedFiles: filesDroppedFromReview,
      delta: deltaCounts,
      ...(primaryAffordance.reviewCounter !== undefined
        ? { reviewCounter: primaryAffordance.reviewCounter }
        : {}),
      ...(primaryAffordance.retriggerUrl !== undefined
        ? { retriggerUrl: primaryAffordance.retriggerUrl }
        : {}),
      // SIG-125: thread the diff's reviewable-position map so
      // `formatFindingComment` can render committable ```suggestion
      // blocks when a finding cleanly anchors (RIGHT + contiguous).
      reviewable,
      // SIG-127: per-file new-side-line → text map so findings the
      // model anchored to a non-substantive structural line (a bare
      // `}`, blank line) route to the summary body instead of an
      // inline comment "on an empty line."
      addedLineTextByLine,
      // SIG-216 fix-up: thread the source-repo coordinates so the
      // body-only finding anchors render as clickable Markdown links
      // (`[path:line](https://github.com/...blob/<sha>/<path>#L<line>)`)
      // in production. Pre-fix-up the clickable-link path was test-only
      // because the ensemble didn't pass `linkContext`, so real PR
      // reviews fell back to the back-compat inline-code anchor.
      linkContext: { owner, repo, headSha },
    } satisfies Parameters<typeof buildReviewSubmissionWithMetadata>[0]
    const submissionBuild = buildReviewSubmissionWithMetadata(submissionBuildArgs)
    // SIG-318 (PR 0b): golden-output capture seam #2 (render). No-op unless
    // OPENCLAW_GOLDEN_CAPTURE === "on"; off/unset → byte-identical behavior.
    // `trace` = the in-scope decision values at this seam (Kimi's ask): specialist
    // coverage, degraded-coverage + downgrade signals, consensus ranking, finding
    // delta, verdict-gate override, trust-ledger mode, and the token ledger. These
    // are diagnostic context, NOT asserted by the parity test.
    captureGolden(env, "render", {
      input: submissionBuildArgs,
      output: submissionBuild,
      trace: {
        coverage,
        degradedCoverage,
        reviewIncomplete,
        synthConfidence,
        approvalReadiness,
        deltaCounts,
        reviewEventOverride,
        trustLedgerMode,
        consensusByIndex: filteredConsensusByIndex,
        tokenUsageByModel,
      },
    })
    const submission = submissionBuild.submission
    const bodyOnlyAnnotations = submissionBuild.bodyOnlyAnnotations
    const allFindingAnnotations = buildBodyOnlyCheckAnnotations([
      ...submissionVerdict.findings,
      ...renderableUnanchoredForSubmission,
    ])
    const checkAnnotationMeta = (annotations: CheckRunAnnotation[]) =>
      annotations.length > 0 ? { checkAnnotations: annotations } : {}

    // SIG-144: when the configured surface is `annotations` (only), the
    // findings are delivered as Check annotations (posted by the
    // dispatcher's `completeCheckRun`), NOT as inline review comments.
    // Strip the inline comments from the submission so the formal review
    // still registers its verdict (APPROVE / REQUEST_CHANGES) + summary
    // body, but doesn't double-post each finding as a review comment. The
    // `both` and `comments` surfaces keep inline comments untouched.
    const reviewOutputSurface = ensembleConfig.flags.reviewOutputSurface
    const { suppressedComments } = applyOutputSurfaceToSubmission(submission, reviewOutputSurface)
    if (suppressedComments > 0) {
      console.log(JSON.stringify({
        event: "pr-review-inline-comments-suppressed-for-annotations",
        owner, repo, prNumber,
        suppressed: suppressedComments,
      }))
    }
  return {
    submissionVerdict,
    renderableUnanchoredForSubmission,
    findingMarkers,
    primaryEvent,
    primaryAffordance,
    prepareFallbackAffordance,
    submissionBuild,
    submission,
    bodyOnlyAnnotations,
    allFindingAnnotations,
    checkAnnotationMeta,
    reviewOutputSurface,
  }
}
