// SIG-318 (PR 12d) — the RENDER-PREP phase of the PR-review orchestrator (app
// layer). Carved verbatim from `handlePrReviewEnsemble`, between stale-head
// guard #2 and merge-guard #2: the review-memory soften pre-pass + the SIG-280
// warm veto (incl. the shared `runClaimClassifier` model closure), the renderable-
// set assembly (content fingerprints, consensus annotation, withdrawal filtering,
// repeat-FP metrics, precision profile, the `keepIndex` parallel-array bookkeeping,
// approval-readiness, the review-event resolution, and the `submissionVerdict`),
// the cross-push delta-badge snapshot, and the specialist coverage roster. It then
// delegates the verification/marker pre-compute to `./verification-prep` (split out
// so neither app file exceeds 1k lines) and returns the values the merge-guard +
// verify-and-build phases downstream consume.
//
// THE INDEX-ALIGNMENT INVARIANT: the parallel arrays (`keepIndex`, the filtered-
// consensus triple, the markers) are the most fragile code in the orchestrator —
// the moved statements are byte-identical with NO reordering. ZERO behavior change;
// only the function wrapper + the explicit arg/result plumbing is new.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home
// (the review-memory leaves, the findings/verdict/synth domains, the lib leaves,
// the model-provider adapter for the claim classifier). It never imports the
// orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewVerdict, PrReviewFinding, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import type { DeltaBadgeCounts } from "@/src/lib/ensemble/render/review-body"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import {
  loadWithdrawals,
  filterWithdrawnFindings,
  filterWithdrawnFindingsDetailed,
  computeContentFingerprint,
} from "@/src/lib/review-withdrawal-store"
import { recordRepeatFpMetrics, type RepeatFpEvent } from "@/src/lib/validation-metrics-client"
import { assessApprovalReadiness, buildApprovalReadinessSummary } from "@/src/lib/approval-readiness"
import { isSoftenActive, softenScoreWithFloor } from "@/src/lib/review-memory/soften-gate"
import {
  readCalibrationParams,
  shouldKeepSoften,
  decideWarmSoftenSurvival,
  type WarmSoftenCandidate,
  type WarmSoftenDecision,
} from "@/src/lib/review-memory/calibration"
import { resolveReviewMemoryConfig, type MatchedSigilixCustomRule, type SigilixConfig } from "@/src/lib/sigilix-config"
import { categoryFromRoleHint, computeFid, computePathSha256 } from "@/src/lib/review-memory/marker"
import {
  extractClaims,
  CLAIM_EXTRACTION_SCHEMA,
  type ClaimExtractionFinding,
} from "@/src/lib/review-memory/claim-extractor"
import { shadowMatchReviewMemoryClaims, type ShadowMatchFinding } from "@/src/lib/review-memory/shadow-match"
import type { ReviewMemoryClaimMarkerData, ReviewMemoryClaimType } from "@/src/lib/review-memory/types"
import type { ReviewMemoryFinding } from "@/src/lib/review-memory/types"
import { loadPrecisionProfile, recordOutcome, applyPrecisionProfile } from "@/src/features/precision-profile"
import { applyLearningSuppressions } from "./learnings-suppress-prep"
import { applyMarkerAttributions } from "./marker-attribution-prep"
import type { MatchedSdkPack } from "@/src/lib/sdk-packs"
import { readReviewManifest, toManifestFinding, type ReviewManifestFinding } from "@/src/lib/review-manifest"
import { type RouterDecision } from "@/src/lib/ensemble-router"
import {
  chooseReviewEvent,
  resolveReviewEventOverride,
  severityTier,
  LOW_CONFIDENCE_COMMENT_THRESHOLD,
} from "@/src/lib/ensemble/domain/verdict"
import { annotateWithConsensus, computeFindingKey, computeFindingDelta } from "@/src/lib/ensemble/domain/findings"
import {
  collectApprovalReadinessSourceFindings,
  type ApprovalReadinessSourceVerdict,
} from "@/src/lib/ensemble/domain/synth"
import type { SynthesizerProvenance, ValidatedOutput, CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import {
  CLAIM_EXTRACTOR_CONFIG,
  CLAIM_EXTRACTOR_TIMEOUT_MS,
  modelApiKeys,
  runWithRetryAndFallback,
  selectConfigApiKey,
} from "@/src/lib/ensemble/adapters/model-provider"
import { prepareVerification } from "./verification-prep"

type SynthesizerProvenanceFindings = SynthesizerProvenance["findings"]
/**
 * The filtered (keepIndex-projected) parallel provenance view. `keepIndex.map`
 * under `noUncheckedIndexedAccess` yields `(entry | undefined)[]`; this preserves
 * that exact shape so the index-aligned downstream consumers (shadow-divergence,
 * the marker walk) see the same optional-element type the orchestrator did before
 * the carve.
 */
type FilteredProvenance = Array<SynthesizerProvenanceFindings[number] | undefined>
type ReviewableMap = ReturnType<typeof parseDiffToReviewablePositions>

export interface RenderPrepArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  repoId?: number // SIG-104 PR-3: learnings store key for the suppress gate.
  headSha: string
  ensembleConfig: EnsembleConfig
  sigilixConfig: SigilixConfig
  orchCtrl: AbortController
  /** The dispatcher's mutable validation-rejection sink (the re-anchor gate pushes to it). */
  validationSink: ValidationRejectionEvent[] | undefined
  router: RouterDecision
  fullPrDiff: string
  reviewable: ReviewableMap
  filesNotReviewed: string[]
  droppedTooLarge: string[]
  /** The specialists-phase outputs the render path consumes. */
  succeeded: CollectedVerdict[]
  degradedCoverage: { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } | null
  synthInputVerdicts: ReadonlyArray<ApprovalReadinessSourceVerdict>
  synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
  shadowMemoriesForPhase3: ReviewMemoryFinding[]
  /** The adjudicate-phase outputs. */
  validated: ValidatedOutput
  consensusVerdict: PrReviewVerdict
  consensusProvenance: SynthesizerProvenanceFindings
  consensusByIndex: number[]
  matchedSdkPacks?: MatchedSdkPack[] // SIG-298: packs actually injected, for the attribution gate.
  matchedCustomRules?: MatchedSigilixCustomRule[] // Config-as-code: rules actually injected, for the attribution gate.
}

export interface RenderPrepResult {
  submissionVerdict: PrReviewVerdict
  renderableUnanchoredForSubmission: PrReviewFinding[]
  filteredConsensusByIndex: number[]
  filteredConsensusProvenance: FilteredProvenance
  intendedEvent: ReturnType<typeof chooseReviewEvent>
  approvalReadiness: ReturnType<typeof assessApprovalReadiness>
  effectiveEvent: ReturnType<typeof assessApprovalReadiness>["event"]
  synthConfidence: number
  reviewIncomplete: boolean
  reviewEventOverride: ReturnType<typeof resolveReviewEventOverride>
  deltaCounts: DeltaBadgeCounts | null
  currentFindingsForManifest: ReviewManifestFinding[]
  coverage: CoverageRoles
  verificationMode: Awaited<ReturnType<typeof prepareVerification>>["verificationMode"]
  addedLineTextByLine: Awaited<ReturnType<typeof prepareVerification>>["addedLineTextByLine"]
  findingMarkers: Array<string | null>
}

export async function prepareRender(a: RenderPrepArgs): Promise<RenderPrepResult> {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
    ensembleConfig,
    sigilixConfig,
    orchCtrl,
    validationSink,
    router,
    fullPrDiff,
    reviewable,
    filesNotReviewed,
    droppedTooLarge,
    succeeded,
    degradedCoverage,
    synthInputVerdicts,
    synthOutput,
    shadowMemoriesForPhase3,
    validated,
    consensusVerdict,
    consensusProvenance,
    consensusByIndex,
  } = a
  // ─── SIG-216: overview-then-submit ordering ────────────────
  // The overview comment lands immediately BEFORE the review comment in this
  // same handler invocation, CodeRabbit-style (see `runInlineOverview` below,
  // called once the submission verdict is final, just before `submitReview`).

  // ─── Submit ────────────────────────────────────────────────
  // GitHub validates every inline anchor and rejects the entire review
  // on a single bad position (typical 422). When that happens the
  // ensemble verdict is good but unsubmittable in its inline shape —
  // Greptile's pr_review.ts handles this by re-posting the review
  // anchorless with all findings rolled into the body. Same pattern
  // here: catch any submit error and retry with `buildFallbackSubmission`.
  // If the fallback ALSO fails, the outer try/catch records it as
  // `internal_error` (same behaviour as before this change).
  // Pass `unanchoredFindings` to the primary submission so any
  // findings that failed line-validity are still rolled into the
  // body (instead of being recovered ONLY when the inline submit
  // fails). CR PR #38 catch — without this, GitHub's success path
  // silently drops the unanchored set.
  //
  // ARC-189 Task 10b: apply review-memory soften BEFORE rendering.
  // The synth's `provenance.softened[]` references specialist
  // sourceFindingIds (e.g., "logic-3"); for each kept finding whose
  // provenance.sourceFindingIds intersects the softened set, build
  // a CLONE of the finding with `score = Math.max(1, score - 1)`.
  // Original finding objects are NEVER mutated (Kimi MINOR on plan
  // v2 — preserves immutability for downstream telemetry).
  const softenedSet = new Set<string>()
  if (synthOutput.provenance?.softened) {
    for (const s of synthOutput.provenance.softened) {
      if (typeof s.sourceFindingId === "string") {
        softenedSet.add(s.sourceFindingId)
      }
    }
  }
  // SIG-280 PR B: soften is now CALIBRATED + opt-in. It only changes a
  // score when `softenActive` (global flag === "soften" AND per-repo
  // `claimSoftening` true). PR B ships the COLD regime: no calibration
  // params exist yet (PR C produces them), so the veto cancels EVERY
  // soften — we record what WOULD have softened (telemetry) then clear
  // the set, so nothing is softened until the calibrated path lands and
  // the founder enables it (believability-dominant: worst case is "no
  // soften", never over-soften). When NOT active, the soften loop below
  // simply doesn't decrement, turning off the pre-Phase-4 uncalibrated
  // always-on soften.
  const claimShadowMode = ensembleConfig.flags.reviewMemoryClaimShadowMode
  // `reviewMemoryConfig` is scoped to the review-memory injection block
  // above; re-resolve the per-repo bool here (pure + cheap) from the
  // function-scoped sigilixConfig.
  const softenActive = isSoftenActive(claimShadowMode, resolveReviewMemoryConfig(sigilixConfig).claimSoftening)
  const claimsEnabled = ensembleConfig.flags.reviewMemoryClaims === "on"

  // Reusable claim-extractor model closure. Shared by the SIG-280 PR C
  // warm veto below and the Phase-2/3 extraction site further down, so
  // the (paid) classifier runs at most ONCE per review even on the warm
  // path (the warm pre-pass memoizes its output into
  // `earlyClaimsPerFinding`).
  const runClaimClassifier = async (system: string, user: string): Promise<string | null> => {
    // SIG-406: the claim extractor runs on OpenRouter (deepseek/deepseek-v4-flash) —
    // select the key by model-id shape (NEVER send the Ollama key to OpenRouter).
    // Fail-open by design: no matching key → no claims (not an error).
    const claimApiKey = selectConfigApiKey(CLAIM_EXTRACTOR_CONFIG, modelApiKeys(env))
    if (!claimApiKey) return null
    const res = await runWithRetryAndFallback<string>({
      config: CLAIM_EXTRACTOR_CONFIG,
      apiKey: claimApiKey,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal: orchCtrl.signal,
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      format: CLAIM_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      parseAnswer: (content) => content,
      parseFailureLabel: "claim_extractor_did_not_parse",
      startedAt: Date.now(),
      perAttemptTimeoutMs: CLAIM_EXTRACTOR_TIMEOUT_MS,
    })
    return res.verdict
  }

  // Withdrawals are loaded ONCE here (hoisted from the post-soften
  // filter site below) so the warm veto and the main render path derive
  // the SAME withdrawal-survivor index from one read — eliminating any
  // chance the two diverge between back-to-back KV reads. Defense-in-
  // depth wrap (CodeRabbit M1, PR #142): the store helper already
  // returns [] on KV/parse failure, but a future sync throw would
  // otherwise unwind the whole review path; withdrawal suppression is a
  // nice-to-have and must never fail a review.
  let withdrawals: Awaited<ReturnType<typeof loadWithdrawals>> = []
  try {
    withdrawals = await loadWithdrawals(env, owner, repo, prNumber)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "review-withdrawal-load-unexpected-throw",
        owner,
        repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // SIG-280 PR C — the soften VETO. PR B shipped only the COLD regime
  // (no calibration params → veto EVERY soften). PR C adds the WARM
  // regime: when a calibration blob exists in KV with >=1 trustworthy
  // claim type, each soften survives ONLY if the finding matched — at
  // claim level, conditioned on the active memory's shadowClaims, i.e.
  // exactly what the calibration corpus measured — a claim type whose
  // 95% lower bound clears the threshold. The ENTIRE warm branch is
  // gated on params existing; in prod they do not yet, so the cold
  // veto-all runs byte-identically to PR B until calibration is fitted
  // and the founder enables it. Believability-dominant: any ambiguity
  // (no match, cold/thin type, low bound, missing params) → veto, and
  // the P0/P1 floor in the soften clone below is the final guard.
  let earlyClaimsPerFinding: ReadonlyArray<readonly ReviewMemoryClaimMarkerData[]> | null = null
  // Survival is keyed by CONSENSUS-FINDING INDEX, never by sourceFindingId
  // (Codex + CodeRabbit P1: one source id can map to multiple synthesized
  // findings, so a source-id set would leak a survival onto a sibling).
  // null on the soften-inactive path; an (empty in cold regime) Set when
  // the veto pre-pass runs. The soften clone loop + approval-readiness key
  // off this index set.
  let survivingSoftenIndexSet: Set<number> | null = null
  if (softenActive && softenedSet.size > 0) {
    const calibrationBlob = claimsEnabled ? await readCalibrationParams(env.OPENCLAW_STATE) : null
    const warmUsable =
      calibrationBlob !== null &&
      shadowMemoriesForPhase3.length > 0 &&
      Object.values(calibrationBlob).some((p) => shouldKeepSoften(p))

    // Per softened finding, the claim types it matched a memory on.
    // WARM only — needs the model-backed claim extraction + the shadow
    // match. Cold/off paths never compute this (→ empty → veto-all).
    const matchedTypesByFid = new Map<string, Set<ReviewMemoryClaimType>>()
    if (warmUsable) {
      // Re-derive today's withdrawal-survivor index the SAME way the
      // main render path does. `filterWithdrawnFindings` matches on
      // path+line+body (score-independent), so an UNSOFTENED probe
      // over the same `withdrawals` yields the identical keepIndex —
      // and extracting claims over exactly that filtered batch keeps
      // the veto's claim types on the same batch shape the corpus saw
      // (Codex Option E: avoids batch-drift over-soften).
      const probe = consensusVerdict.findings.map((f, i) => annotateWithConsensus(f, consensusByIndex[i] ?? 1))
      const { kept: probeKept } = filterWithdrawnFindings(probe, withdrawals)
      const probeKeptSet = new Set(probeKept)
      const warmKeepIndex: number[] = []
      for (let i = 0; i < probe.length; i++) {
        if (probeKeptSet.has(probe[i]!)) warmKeepIndex.push(i)
      }
      const warmFiltered = warmKeepIndex.map((i) => consensusVerdict.findings[i]!)
      const warmFilteredProvenance = warmKeepIndex.map((i) => consensusProvenance[i])

      const warmClaims = await extractClaims({
        findings: warmFiltered.map(
          (f): ClaimExtractionFinding => ({
            headline: f.headline,
            body: f.body,
            category: f.category,
          }),
        ),
        runClassifier: runClaimClassifier,
      })
      earlyClaimsPerFinding = warmClaims

      const warmShadowFids = await Promise.all(
        warmFiltered.map((f) => computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline })),
      )
      const warmShadowPathHashes = await Promise.all(warmFiltered.map((f) => computePathSha256(f.path)))
      const warmShadowFindings: ShadowMatchFinding[] = warmFiltered.map((f, j) => {
        const sourceSpec = warmFilteredProvenance[j]?.sourceSpecialists?.[0]
        return {
          category: sourceSpec ? categoryFromRoleHint(sourceSpec) : null,
          pathSha12: warmShadowPathHashes[j]?.slice(0, 12) ?? null,
          fid: warmShadowFids[j] ?? "",
          severityTier: severityTier(f.score),
          claims: (warmClaims[j] ?? []).map((c) => ({
            type: c.type,
            extractorVersion: c.extractorVersion,
          })),
        }
      })
      const warmRows = shadowMatchReviewMemoryClaims({
        memories: shadowMemoriesForPhase3,
        findings: warmShadowFindings,
      })
      // Codex P1: the soften veto joins a candidate to its matched claim
      // types BY fid. `computeFid` ignores body/category, so two distinct
      // findings sharing (path, line, headline) collide on fid — one
      // could then inherit the other's match and be softened though it
      // matched nothing. Believability-dominant resolution: if a fid is
      // ambiguous (more than one finding in this review carries it), we
      // CANNOT safely attribute a match, so we drop it from the map →
      // every candidate with that fid vetoes. Near-impossible after
      // consensus dedup, but the cost of being wrong here is hiding a
      // real finding, so we refuse to guess.
      const fidCounts = new Map<string, number>()
      for (const fid of warmShadowFids) {
        fidCounts.set(fid, (fidCounts.get(fid) ?? 0) + 1)
      }
      for (const row of warmRows) {
        if (!row.claimType) continue
        if ((fidCounts.get(row.fid) ?? 0) > 1) continue // ambiguous fid → veto
        let set = matchedTypesByFid.get(row.fid)
        if (!set) {
          set = new Set<ReviewMemoryClaimType>()
          matchedTypesByFid.set(row.fid, set)
        }
        set.add(row.claimType)
      }
    }

    // Build candidates — the softened findings, keyed by consensus index.
    const candidates: WarmSoftenCandidate[] = []
    for (let i = 0; i < consensusVerdict.findings.length; i++) {
      const f = consensusVerdict.findings[i]!
      const sourceIds = consensusProvenance[i]?.sourceFindingIds ?? []
      // Candidacy: the finding had at least one synth-softened source id.
      if (!sourceIds.some((id) => softenedSet.has(id))) continue
      const fid = await computeFid({
        ruleId: null,
        path: f.path,
        line: f.line,
        headline: f.headline,
      })
      candidates.push({
        index: i,
        fid,
        matchedTypes: [...(matchedTypesByFid.get(fid) ?? [])],
      })
    }
    const decisions: WarmSoftenDecision[] = warmUsable
      ? decideWarmSoftenSurvival({ candidates, blob: calibrationBlob! })
      : candidates.map((c) => ({
          index: c.index,
          fid: c.fid,
          kept: false,
          keepingTypes: [] as ReviewMemoryClaimType[],
        }))

    // Survival is carried forward BY INDEX (empty in the cold regime →
    // veto-all, exactly as PR B). Keying by index — never by source id —
    // prevents a kept finding from softening a sibling that shares a
    // specialist source id (Codex + CodeRabbit P1).
    survivingSoftenIndexSet = new Set<number>()
    for (const d of decisions) {
      if (d.kept) survivingSoftenIndexSet.add(d.index)
      console.log(
        JSON.stringify({
          event: "review-memory-claim-soften",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          fid: d.fid,
          severityTier: severityTier(consensusVerdict.findings[d.index]!.score),
          keepingTypes: d.keepingTypes,
          vetoed: !d.kept,
          paramsMissing: !warmUsable,
        }),
      )
    }
  }
  let softenedCount = 0
  // SIG-280 PR C: the SINGLE source of truth for "this finding's score was
  // actually lowered in the rendered output" — populated below exactly where
  // the soften clone is built. Approval-readiness reads this (intersected
  // with the withdrawal-survivor `keepIndex`) instead of re-encoding the
  // soften contract, so the two paths can never drift (CodeRabbit).
  const actuallySoftenedIndexSet = new Set<number>()
  // ARC-270: soften walks the CONSENSUS-RANKED arrays (verdict +
  // provenance + consensusByIndex stay in lockstep). Body
  // annotation happens here too, so renderable findings carry both
  // the (possibly softened) score AND the consensus prefix.
  //
  // Caveat: the rendered Fix Plan (`renderFixPlan` in
  // `triage-pr-review.ts`) and the anchorless 422-fallback's
  // per-file rendering both apply their own sort (by location /
  // by score within file). They override consensus ORDER, but the
  // `_Flagged by N specialists._` body prefix still surfaces the
  // signal — the badge stays, just the row position differs in
  // those two surfaces.
  // SIG-217: annotate each finding with its content fingerprint BEFORE
  // render + withdrawal filtering. Computed from the RAW synth body (this
  // runs before annotateWithConsensus prepends its "_Flagged by N_" line),
  // so the value is stable across pushes regardless of the per-push blob
  // hash that drives the model-emitted finding ID. The fingerprint then
  // (a) flows into the rendered comment as a hidden marker, and (b) lets a
  // later content-equivalent re-fire be recognized as already-dismissed.
  // Mutates in place — runtime-only field, like `trust`. Best-effort: a hash
  // failure leaves the finding without a fingerprint (Jaccard fallback).
  try {
    await Promise.all(
      consensusVerdict.findings.map(async (f) => {
        f.contentFingerprint = await computeContentFingerprint(f.category, f.path, f.body)
      }),
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "finding-fingerprint-annotate-failed",
        owner,
        repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  const renderableFindings = consensusVerdict.findings.map((f, i) => {
    // SIG-280 PR C: soften iff this finding's INDEX survived the veto
    // pre-pass (cold regime → empty set, so this never fires in prod yet).
    // Index-keyed — see `survivingSoftenIndexSet`. `softenScoreWithFloor`
    // keeps a P0/P1 (score >= 4) UNCHANGED — a blocker is never softened
    // below its tier — and decrements P2/P3 by one (floored at 1).
    //
    // Codex P1 note: the floor reads the CONSENSUS finding's `f.score`,
    // not the underlying specialist source score. That equals the true
    // severity only because the synthesizer is required to emit findings
    // at TRUE severity and never pre-downgrade (the SIG-284 renderer-only-
    // soften contract, pinned by PROMPT_VERSION + the double-soften test).
    // If a synth ever under-scored a true P0/P1 to <4 this floor wouldn't
    // catch it — but that is a synth-correctness bug, out of scope here,
    // and guarded by the prompt contract rather than this line.
    const matched = softenActive && (survivingSoftenIndexSet?.has(i) ?? false)
    let working = f
    if (matched) {
      const effectiveScore = softenScoreWithFloor(f.score)
      if (effectiveScore !== f.score) {
        softenedCount++
        actuallySoftenedIndexSet.add(i)
        working = { ...f, score: effectiveScore }
      }
    }
    // Body annotation — only when consensus >= 2.
    return annotateWithConsensus(working, consensusByIndex[i] ?? 1)
  })
  const renderableUnanchoredRaw = validated.unanchoredFindings // unanchored never matches by INDEX (no parallel arrays)
  // SIG-160 PR3: drop any finding the bot already conceded via mention-reply
  // (`<!-- sigilix:gh-mention-reply -->` with verdict:"concede"). Filter
  // applies to inline-anchored findings only — unanchored findings have
  // no path+line to match a WithdrawalRecord against. Runs BEFORE the
  // manifest snapshot + counter bump so a withdrawn finding never:
  //   - lands in the persisted manifest (would corrupt next push's delta)
  //   - triggers a REQUEST_CHANGES counter bump (would re-block the PR)
  //   - reaches `buildReviewSubmission` (would post the inline comment).
  //
  // Index alignment (CodeRabbit M1 catch): `consensusVerdict.findings`,
  // `consensusByIndex`, and `consensusProvenance` are parallel arrays
  // — index `i` in each refers to the same finding. The filter must
  // produce a `keepIndex` whose entries are valid indices into the
  // original arrays, and downstream consumers (snapshot + marker
  // computation) read through that index list so the filtered view
  // stays aligned end-to-end.
  //
  // `withdrawals` is loaded once near the soften pre-pass above (SIG-280
  // PR C hoisted it so the warm veto and this render path share one
  // read); the defensive wrap + rationale live there.
  const {
    kept: postWithdrawalFindings,
    suppressed: withdrawnDetailed,
    decayExpired: decayExpiredFindings,
  } = filterWithdrawnFindingsDetailed(renderableFindings, withdrawals)
  const withdrawnFindings = withdrawnDetailed.map((s) => s.finding)
  // SIG-217: emit repeat-FP telemetry. Two cases feed one batch:
  //   - fingerprint re-fires still inside the decay window (suppressed) →
  //     `repeat-fp-detected`, plus `severity-escalation-attempt` if the score
  //     climbed above what it was when dismissed.
  //   - decay-window lapses (SIG-217 Part B) — the finding was LET THROUGH
  //     because the dismissal aged past the decay window → emit
  //     `dismiss-decay-window-expired`.
  // The finding's category is the per-specialist dimension (logic / security /
  // performance / testing …). Awaited-but-non-fatal (the recordDismissalMetric
  // pattern) — a telemetry failure must never affect the review.
  const repeatFpEvents: RepeatFpEvent[] = []
  for (const s of withdrawnDetailed) {
    if (!s.viaFingerprint) continue
    repeatFpEvents.push({ kind: "repeat-fp-detected", specialist: s.finding.category })
    if (s.severityEscalated) {
      repeatFpEvents.push({ kind: "severity-escalation-attempt", specialist: s.finding.category })
    }
  }
  for (const s of decayExpiredFindings) {
    repeatFpEvents.push({ kind: "dismiss-decay-window-expired", specialist: s.finding.category })
  }
  if (repeatFpEvents.length > 0) {
    try {
      await recordRepeatFpMetrics(env, { owner, repo, prNumber, headSha, events: repeatFpEvents })
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "repeat-fp-metrics-record-error",
          owner,
          repo,
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
  // SIG-147: per-repo precision profile — suppress repeatedly-dismissed
  // PATTERNS (recall-safe: never a P0/P1) and record the `stale` outcome from
  // decay-expired dismissals. Shadow by default (compute + telemeter, no
  // output change); `enforce` filters. Best-effort — a profile failure must
  // never affect the review. Boost is computed/surfaced but applied at the
  // SIG-104 prompt gate (not yet built); see precision-profile/README.md.
  // NOTE: `shadow` leaves the posted review byte-identical, but DOES still
  // write `stale` outcomes to KV (building the corpus is the point of shadow);
  // only `enforce` changes what's posted.
  const precisionMode = ensembleConfig.flags.precisionProfileMode
  let precisionKept = postWithdrawalFindings
  if (precisionMode !== "off") {
    // Key on the owner/repo slug — the SAME key the dismiss path
    // (github-mention) records outcomes under, so the signal round-trips.
    const precisionRepoKey = `${owner}/${repo}`
    try {
      const profile = await loadPrecisionProfile(env, precisionRepoKey)
      const precision = applyPrecisionProfile(postWithdrawalFindings, profile, {
        enforce: precisionMode === "enforce",
      })
      if (precision.suppressed.length > 0 || precision.boosted.length > 0) {
        console.log(
          JSON.stringify({
            event: "precision-profile-decision",
            owner,
            repo,
            prNumber,
            mode: precisionMode,
            // FP-reduction signal (ties SIG-114): each suppressed finding is an avoided FP.
            suppressed: precision.suppressed.length,
            boosted: precision.boosted.length,
            suppressed_categories: precision.suppressed.map((s) => s.finding.category),
            boosted_categories: precision.boosted.map((b) => b.finding.category),
          }),
        )
      }
      if (precisionMode === "enforce") precisionKept = precision.kept
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "precision-profile-apply-failed",
          owner,
          repo,
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    // A decay-expired dismissal (SIG-217) relaxes its pattern back toward neutral.
    for (const s of decayExpiredFindings) {
      if (!s.finding.contentFingerprint) continue
      try {
        await recordOutcome(env, {
          repoId: precisionRepoKey,
          category: s.finding.category,
          patternHash: s.finding.contentFingerprint,
          outcome: "stale",
        })
      } catch {
        /* non-fatal */
      }
    }
  }
  // SIG-104 PR-3: the learnings SUPPRESS gate — carve-outs + mode in `learnings-suppress-prep`.
  precisionKept = await applyLearningSuppressions({
    env,
    owner,
    repo,
    prNumber,
    repoId: a.repoId,
    kept: precisionKept,
    renderableFindings,
    consensusProvenance,
    changedPaths: [...reviewable.keys(), ...filesNotReviewed],
  })
  // SIG-298 + config-as-code: strip `[sdk:<packId>]` / `[repo-rule:<id>]` self-tag
  // markers + stamp attribution (pure/sync) over BOTH renderable scopes.
  precisionKept = applyMarkerAttributions({ ...a, precisionKept, renderableUnanchoredRaw })
  // SIG-281 PR C (Codex P2): also suppress withdrawn findings from the
  // body-only set. PR C's enforce mode can demote a LINE-scoped finding
  // (which carries a real path+line) to the body; without this it would
  // bypass withdrawal suppression and a previously-dismissed nit could
  // reappear in the Review Body. Safe for pr/file-scope body findings
  // too — findingMatchesWithdrawal requires path + line-proximity + body
  // similarity, so an unrelated body finding cannot false-match. This
  // also closes the pre-existing gap where SIG-141 line-1 / unanchorable
  // demotions skipped withdrawal entirely.
  const { kept: renderableUnanchored, suppressed: withdrawnUnanchored } = filterWithdrawnFindings(
    renderableUnanchoredRaw,
    withdrawals,
  )
  const keptRefSet = new Set(precisionKept)
  const keepIndex: number[] = []
  for (let i = 0; i < renderableFindings.length; i++) {
    if (keptRefSet.has(renderableFindings[i]!)) keepIndex.push(i)
  }
  if (withdrawnFindings.length > 0 || withdrawnUnanchored.length > 0) {
    console.log(
      JSON.stringify({
        event: "review-findings-suppressed-by-withdrawal",
        owner,
        repo,
        prNumber,
        suppressed: withdrawnFindings.length,
        // SIG-281 PR C: body-only findings now also withdrawal-filtered.
        suppressed_unanchored: withdrawnUnanchored.length,
        withdrawals_active: withdrawals.length,
        paths: [...withdrawnFindings, ...withdrawnUnanchored].map((f) => f.path),
      }),
    )
  }
  // Filtered parallel views for downstream consumers — snapshot and
  // marker computation read through these so the manifest, counter,
  // and inline-comment markers all see the same kept set the renderer
  // does. Original `consensusVerdict` stays intact (it's the audit
  // record of what the model produced before suppression).
  const filteredConsensusFindings = keepIndex.map((i) => consensusVerdict.findings[i]!)
  const filteredConsensusByIndex = keepIndex.map((i) => consensusByIndex[i] ?? 1)
  const filteredConsensusProvenance = keepIndex.map((i) => consensusProvenance[i])
  // CodeRabbit M2 (review on PR #142): the synthesizer wrote
  // `consensusVerdict.summary` over the FULL finding set including
  // findings we're about to suppress. Reusing it verbatim could
  // surface conceded content (e.g. "two findings about test
  // coverage") even though the renderer drops one of them. When any
  // suppression happened, replace the summary with a neutral
  // fallback the renderer can use unmodified.
  //
  // CodeRabbit M-new (follow-up review on PR #142): the "nothing
  // remaining to block" branch must consider BOTH anchored kept +
  // unanchored findings — `renderableUnanchored` is independent of
  // the withdrawal filter (no path+line to match against). Without
  // this, an all-anchored-withdrawn run with surviving unanchored
  // findings would post REQUEST_CHANGES with a summary that says
  // "nothing remaining." `chooseReviewEvent` reads the merged set
  // for the verdict decision, so the summary must agree.
  const hasRemainingFindings = precisionKept.length + renderableUnanchored.length > 0
  // SIG-281 PR C (Codex P2 follow-on): regenerate the summary when
  // EITHER an inline OR a body finding was withdrawal-suppressed —
  // otherwise a body-only withdrawal would remove the finding from the
  // submission but leave the consensus summary still describing it.
  const summaryAfterSuppression =
    withdrawnFindings.length > 0 || withdrawnUnanchored.length > 0
      ? !hasRemainingFindings
        ? "All flagged findings were previously addressed via review-thread acknowledgments; nothing remaining to block."
        : "Summary regenerated after suppressing findings previously acknowledged via review-thread replies."
      : consensusVerdict.summary
  const renderableVerdict: PrReviewVerdict = {
    ...consensusVerdict,
    summary: summaryAfterSuppression,
    findings: precisionKept,
  }
  if (softenedCount > 0) {
    console.log(
      JSON.stringify({
        event: "review-memory-softened-rendered",
        owner,
        repo,
        prNumber,
        softenedCount,
      }),
    )
  }

  // SIG-205 — approval-readiness must run before the delta/manifest
  // snapshot below. Its body-only blockers are customer-visible
  // findings, so they need the same persistence and still-open/new
  // tracking as normal unanchored findings.
  const intendedEvent = chooseReviewEvent([...renderableVerdict.findings, ...renderableUnanchored])
  const sourceFindingsForApproval = collectApprovalReadinessSourceFindings(synthInputVerdicts, withdrawals)
  // SIG-280 PR C: which synth-softened source ids were ACTUALLY softened in
  // the rendered output. Derived from finding INDICES, never a source-id set,
  // because a source id can feed multiple synthesized findings.
  //
  // We reuse `actuallySoftenedIndexSet` — the SINGLE source of truth built in
  // the renderableFindings map above where the score is actually changed —
  // and intersect it with the withdrawal survivors (`keepIndex`). That makes
  // "actually de-emphasized in the output" mean: the renderer lowered the
  // score AND the finding survived withdrawal filtering. No re-encoding of the
  // soften contract here, so approval can't drift from rendered output
  // (CodeRabbit). A P0/P1 the floor left unchanged was never added to the set,
  // so it correctly does NOT count.
  // FAIL CLOSED: a source id de-emphasized in one finding but left at full
  // severity in another (vetoed, withdrawn, or floor-no-op) is NOT counted as
  // accounted — else approval-readiness could approve over a sibling finding
  // still at full severity (undercount blockers).
  const keptIndexSet = new Set(keepIndex)
  const softenMembership = new Map<string, { survived: boolean; vetoed: boolean }>()
  if (softenActive) {
    for (let idx = 0; idx < consensusProvenance.length; idx++) {
      const survived = actuallySoftenedIndexSet.has(idx) && keptIndexSet.has(idx)
      for (const sourceFindingId of consensusProvenance[idx]?.sourceFindingIds ?? []) {
        if (!softenedSet.has(sourceFindingId)) continue
        const state = softenMembership.get(sourceFindingId) ?? { survived: false, vetoed: false }
        if (survived) state.survived = true
        else state.vetoed = true
        softenMembership.set(sourceFindingId, state)
      }
    }
  }
  const approvalReadiness = assessApprovalReadiness({
    intendedEvent,
    sourceFindings: sourceFindingsForApproval,
    // Pass only source ids that survived softening EVERYWHERE they appear —
    // a source finding counts as "accounted" only when it was actually
    // de-emphasized in the output, so approval-readiness never silently
    // approves over a finding the calibrated veto kept at full severity.
    // Empty in the cold regime; [] when soften is inactive entirely.
    provenance: {
      ...validated.provenance,
      softened: softenActive
        ? (validated.provenance.softened ?? []).filter((s) => {
            if (typeof s.sourceFindingId !== "string") return false
            const state = softenMembership.get(s.sourceFindingId)
            return state !== undefined && state.survived && !state.vetoed
          })
        : [],
    },
  })
  const renderableUnanchoredForSubmission = [...renderableUnanchored, ...approvalReadiness.bodyOnlyFindings]
  const effectiveEvent = approvalReadiness.event
  // SIG-287: a degraded-coverage or low-confidence review must NOT post a
  // confident clean APPROVE — that is the fake-approve believability bug (the
  // bot says "all clear" when its primary bug-finder, logic, didn't run).
  // Downgrade an otherwise-APPROVE to a neutral COMMENT ("Sigilix looked, but
  // this is not a full sign-off"). A real blocker still escalates to
  // REQUEST_CHANGES (escalation wins); the COMMENT override can only weaken
  // APPROVE→COMMENT, never hide a rendered blocker — see
  // `chooseRenderedEventWithOverride`. Honors the founder's SIG-14 posture
  // ("speak, don't be silent"): the bot still comments, it just stops
  // rubber-stamping a review it couldn't actually complete.
  const synthConfidence = typeof renderableVerdict.confidence === "number" ? renderableVerdict.confidence : 5
  // TODO(SIG-364): extract an isLowConfidence predicate into domain/verdict when the orchestrator is thinned — the comparison direction is policy.
  const reviewIncomplete = degradedCoverage !== null || synthConfidence <= LOW_CONFIDENCE_COMMENT_THRESHOLD
  // SIG-245 / SIG-414: the APPROVE→COMMENT downgrade union is the REAL coverage
  // gaps ONLY — oversized ∪ spillover. POLICY skips are EXCLUDED (not a gap), so
  // a policy-only skip stays APPROVE (Req 3) — the orchestrator-built `disclosure`
  // carries policy informationally, but it never enters this union. Separate from
  // `reviewIncomplete` so the degraded summary prefix isn't applied here.
  const filesDroppedFromReview = [...new Set([...filesNotReviewed, ...droppedTooLarge])]
  const reviewEventOverride = resolveReviewEventOverride({
    hasApprovalBlocker: approvalReadiness.blockers.length > 0,
    reviewIncomplete,
    filesDroppedCount: filesDroppedFromReview.length,
  })
  if (reviewIncomplete) {
    console.log(
      JSON.stringify({
        event: "review-incomplete-downgrade",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        reason: degradedCoverage !== null ? "degraded_coverage" : "low_confidence",
        rolesMissing: degradedCoverage?.rolesMissing ?? [],
        synthConfidence,
      }),
    )
  }
  // Visible caveat so a downgraded review reads as honestly partial, never as
  // a quiet clean approve (SIG-94 hid coverage on APPROVE; this re-surfaces it
  // only when the review is actually incomplete).
  const incompleteSummaryPrefix = reviewIncomplete
    ? degradedCoverage !== null
      ? `> ⚠️ **Partial review** — ${degradedCoverage.rolesMissing.join(", ")} specialist` +
        `${degradedCoverage.rolesMissing.length === 1 ? "" : "s"} unavailable; this is **not** a full Sigilix sign-off.\n\n`
      : `> ⚠️ **Low-confidence review** — posted as a comment, not a full approval.\n\n`
    : ""
  const submissionVerdict: PrReviewVerdict = {
    ...renderableVerdict,
    summary: incompleteSummaryPrefix + buildApprovalReadinessSummary(approvalReadiness, renderableVerdict.summary),
  }

  // ARC-271 — finding delta vs the prior review.
  //
  // For each current finding compute a stable key and look it up
  // in the prior manifest. The result is a {new, still-open,
  // likely-fixed, carried-over} count surfaced in the review body.
  //
  // Best-effort: manifest read failures (KV outage, malformed
  // record, never-written) degrade to "no delta" — the review
  // body simply doesn't show the Δ line. The current findings
  // are persisted on the success path regardless so subsequent
  // pushes can compute deltas against them.
  // CodeRabbit MAJOR catch on PR #83: the review body includes
  // BOTH `consensusVerdict.findings` (inline-anchored) AND
  // `validated.unanchoredFindings` (body-only). The manifest
  // snapshot must capture both — otherwise a still-open unanchored
  // finding silently disappears from the delta and re-appears as
  // `new` on the next push. Unanchored findings never went through
  // consensus ranking (they were filtered for failing line
  // validity, not for consensus), so their consensus defaults to 1.
  // SIG-160 PR3: snapshot the FILTERED set so withdrawn findings
  // don't land in the persisted manifest — otherwise next push's
  // delta would compare {prior: includes withdrawn} vs
  // {current: excludes withdrawn} and report the withdrawn finding
  // as `likely-fixed`. SIG-205 extends the body-only side with
  // approval-readiness blockers, which are already derived from the
  // withdrawal-filtered source findings above.
  const snapshotInputs = [
    ...filteredConsensusFindings.map((f, j) => ({
      f,
      consensus: filteredConsensusByIndex[j] ?? 1,
    })),
    ...renderableUnanchoredForSubmission.map((f) => ({ f, consensus: 1 })),
  ]
  // SIG-471 (quiet-VERIFIED): `toManifestFinding` persists the receipt-join fields
  // (line/category/evidenceId/cweId/trustTier/deterministicFactIds) so the
  // overview-proof-update job can re-verify without a full re-review.
  const currentFindingsForManifest: ReviewManifestFinding[] = await Promise.all(
    snapshotInputs.map(async ({ f, consensus }) =>
      toManifestFinding(await computeFindingKey(f.path, f.headline), consensus, f),
    ),
  )
  const currentKeySet = new Set(currentFindingsForManifest.map((f) => f.key))
  // ARC-281: pass the delta counts straight into the renderer
  // (it draws the `**Δ:**` badge under the heading) instead of
  // prepending a "**Δ since last review:** …" string into the
  // summary. `null` = no prior manifest / no signal.
  let deltaCounts: DeltaBadgeCounts | null = null
  try {
    const priorRead = await readReviewManifest(env, owner, repo, prNumber)
    if (priorRead.kind === "ok" && priorRead.manifest.findings) {
      // Codex spec warning: a finding's path NOT in the current PR's
      // changed-file set means specialists never looked at it on
      // this run (incremental review only sends changed-file
      // diffs). Don't claim "fixed" in that case — classify as
      // `carried-over` instead.
      //
      // `reviewable.keys()` is our changed-paths source of truth:
      // it's parsed from the diff that the specialists actually
      // saw, so every path with at least one reviewable position
      // is a file we have fresh signal on. Pure-rename or empty
      // diffs without reviewable positions correctly fall out
      // (we had no signal on them).
      const changedPaths = new Set(reviewable.keys())
      // SIG-392: a same-head rerun (warmup rerun, manual /sigilix review)
      // must never claim "likely-fixed" — the code didn't change; absent
      // findings are draw variance and classify as carried-over.
      const delta = computeFindingDelta(currentKeySet, priorRead.manifest.findings, changedPaths, {
        sameHead: priorRead.manifest.headSha === headSha,
      })
      // Promote to the renderer-facing shape. We still gate the
      // observability log on the same "any signal" predicate as
      // `renderDeltaBadge` so a no-change second review doesn't
      // log a "+0 new" line.
      const anySignal =
        delta.newCount > 0 || delta.stillOpenCount > 0 || delta.likelyFixedCount > 0 || delta.carriedOverCount > 0
      if (anySignal) {
        deltaCounts = {
          newCount: delta.newCount,
          stillOpenCount: delta.stillOpenCount,
          likelyFixedCount: delta.likelyFixedCount,
          carriedOverCount: delta.carriedOverCount,
        }
        console.log(
          JSON.stringify({
            event: "pr-review-delta-computed",
            owner,
            repo,
            prNumber,
            headSha: headSha.slice(0, 7),
            ...delta,
          }),
        )
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-review-delta-read-failed",
        owner,
        repo,
        prNumber,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // ARC-281: specialist coverage roster for the renderer. The
  // `**Coverage:**` line uses the dispatched/succeeded split
  // directly — `degradedCoverage` upstream already drove prompt
  // logic; this is purely display.
  const coverage: CoverageRoles = {
    dispatched: router.specialists,
    succeeded: succeeded.map((v) => v.role),
  }

  // SIG-318 (PR 12d): the verification/marker pre-compute (write-time claim
  // extraction, the SIG-285 mode + added-line hoist, the re-anchor ENFORCE
  // mutation, the SIG-276/SIG-280 shadow claim-match, the per-finding markers)
  // moved to ensemble/app/verification-prep. It mutates `submissionVerdict`'s
  // findings by reference on the (default-off) re-anchor path; the values it
  // returns flow downstream unchanged.
  const { verificationMode, addedLineTextByLine, findingMarkers } = await prepareVerification({
    env,
    owner,
    repo,
    prNumber,
    headSha,
    fullPrDiff,
    validationSink,
    submissionVerdict,
    filteredConsensusFindings,
    filteredConsensusProvenance,
    claimsEnabled,
    earlyClaimsPerFinding,
    claimShadowMode,
    shadowMemoriesForPhase3,
    runClaimClassifier,
  })

  return {
    submissionVerdict,
    renderableUnanchoredForSubmission,
    filteredConsensusByIndex,
    filteredConsensusProvenance,
    intendedEvent,
    approvalReadiness,
    effectiveEvent,
    synthConfidence,
    reviewIncomplete,
    reviewEventOverride,
    deltaCounts,
    currentFindingsForManifest,
    coverage,
    verificationMode,
    addedLineTextByLine,
    findingMarkers,
  }
}
