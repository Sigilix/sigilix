// SIG-318 (PR 12d) — the VERIFICATION-PREP tail of the render-prep phase (app
// layer). Carved verbatim from `handlePrReviewEnsemble`: the write-time claim
// extraction (reusing the warm pre-pass when present), the SIG-285 verification-
// mode + added-line-index hoist, the SIG-285 inline-first re-anchor ENFORCE
// mutation, the SIG-276/SIG-280 SHADOW-ONLY claim-match telemetry, and the
// per-finding sigilix marker generation. Split out of render-prep so neither
// app file exceeds 1k lines; the boundary is the marker/verification pre-compute
// (everything after the coverage roster). render-prep delegates here at its end.
//
// The moved statements are byte-identical; only the function wrapper + the
// explicit arg/result plumbing is new. ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file
// home (the review-memory leaves, the verification leaves, the verdict domain).
// It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules"
import { isSubstantiveAnchorLine } from "@/src/shared/util/anchor-lines"
import { readVerificationMode, readReanchorEnabled } from "@/src/lib/verification/mode"
import { applyReanchors } from "@/src/lib/verification/verify-finding"
import {
  buildSigilixMarker,
  categoryFromRoleHint,
  computeFid,
  computePathSha256,
  markerSeverityFromScore,
} from "@/src/lib/review-memory/marker"
import {
  extractClaims,
  type ClaimExtractionFinding,
} from "@/src/lib/review-memory/claim-extractor"
import {
  shadowMatchReviewMemoryClaims,
  type ShadowMatchFinding,
} from "@/src/lib/review-memory/shadow-match"
import type {
  ReviewMemoryClaimMarkerData,
} from "@/src/lib/review-memory/types"
import type { ReviewMemoryFinding } from "@/src/lib/review-memory/types"
import { severityTier } from "@/src/lib/ensemble/domain/verdict"
import type { SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"

type SynthesizerProvenanceFindings = SynthesizerProvenance["findings"]
/**
 * The filtered (keepIndex-projected) parallel provenance view from render-prep —
 * `(entry | undefined)[]` under `noUncheckedIndexedAccess` (the marker walk reads
 * `[j]?.sourceSpecialists`, tolerating the optional element).
 */
type FilteredProvenance = Array<SynthesizerProvenanceFindings[number] | undefined>

export interface VerificationPrepArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  fullPrDiff: string
  /** The dispatcher's mutable validation-rejection sink (the re-anchor gate pushes to it). */
  validationSink: ValidationRejectionEvent[] | undefined
  /** The render-prep submission verdict — re-anchor mutates `.findings` in place. */
  submissionVerdict: PrReviewVerdict
  /** The withdrawal-filtered, consensus-ranked parallel views from render-prep. */
  filteredConsensusFindings: PrReviewFinding[]
  filteredConsensusProvenance: FilteredProvenance
  /** OPENCLAW_REVIEW_MEMORY_CLAIMS === "on" (computed in render-prep). */
  claimsEnabled: boolean
  /** The warm pre-pass's claim extraction (reused so the classifier runs at most once). */
  earlyClaimsPerFinding: ReadonlyArray<readonly ReviewMemoryClaimMarkerData[]> | null
  /** OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW mode (computed in render-prep). */
  claimShadowMode: string
  /** The Phase-3 shadow memories (passed through from the specialists phase). */
  shadowMemoriesForPhase3: ReviewMemoryFinding[]
  /** The shared (paid) claim-extractor model closure built in render-prep. */
  runClaimClassifier: (system: string, user: string) => Promise<string | null>
}

export interface VerificationPrepResult {
  verificationMode: ReturnType<typeof readVerificationMode>
  addedLineTextByLine: ReturnType<typeof buildAddedLineTextByLine>
  findingMarkers: Array<string | null>
}

export async function prepareVerification(a: VerificationPrepArgs): Promise<VerificationPrepResult> {
  const {
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
  } = a
    // ARC-189: pre-compute the per-finding sigilix marker BEFORE
    // calling buildReviewSubmission so marker construction (async via
    // crypto.subtle) doesn't force the whole renderer async. Markers
    // align by index with `validated.verdict.findings` AND
    // `validated.cleanFindingProvenance` — the same walk in
    // validateForSubmission produced both. Findings with no source
    // specialist (defensive, shouldn't happen post-hallucination
    // guard) emit `null` and skip the marker.
    //
    // Marker severity uses the ORIGINAL (pre-soften) score so the
    // marker reflects what synth actually emitted; the soften
    // applies to the rendered finding body only.
    // ARC-270: marker computation walks the consensus-ranked arrays
    // so per-finding markers stay aligned with the rendered finding
    // order. `consensusProvenance` and `consensusVerdict.findings`
    // are in the new ranking; `findingMarkers[i]` lines up with
    // `renderableFindings[i]`.
    //
    // SIG-160 PR3: walk the FILTERED parallel views so markers align
    // with `postWithdrawalFindings` (== `renderableVerdict.findings`),
    // not the original pre-suppression set. Otherwise `buildReviewSubmission`
    // would index off-by-one when consulting `findingMarkers` for an inline
    // comment whose `originalIndex` survived suppression.
    //
    // SIG-276 Phase 2: extract write-time claims over the SAME filtered/
    // ranked findings, so `claimsPerFinding[j]` aligns with the marker
    // walk below. Gated behind OPENCLAW_REVIEW_MEMORY_CLAIMS (default off)
    // so the extra per-PR classifier round-trip is opt-in. Fail-open: a
    // classifier blip yields no claims rather than blocking the merge path
    // or rotating a marker. The id-less claim data rides the marker;
    // capture (PR B) recomputes each id before storing it on a signal.
    const claimT0 = Date.now()
    // SIG-280 PR C: reuse the warm pre-pass's claim extraction when it
    // ran — the (paid) classifier is invoked at most once per review. It
    // was extracted over the SAME withdrawal-filtered batch (one shared
    // `withdrawals` read + a score-independent filter), so it aligns with
    // `filteredConsensusFindings`. The length guard is belt-and-suspenders:
    // if that invariant is ever broken, fall back to a fresh extraction
    // rather than misalign markers / the shadow corpus.
    const claimsPerFinding: ReadonlyArray<readonly ReviewMemoryClaimMarkerData[]> =
      earlyClaimsPerFinding &&
      earlyClaimsPerFinding.length === filteredConsensusFindings.length
        ? earlyClaimsPerFinding
        : claimsEnabled
          ? await extractClaims({
              findings: filteredConsensusFindings.map(
                (f): ClaimExtractionFinding => ({
                  headline: f.headline,
                  body: f.body,
                  category: f.category,
                }),
              ),
              runClassifier: runClaimClassifier,
            })
          : filteredConsensusFindings.map(() => [])
    if (claimsEnabled) {
      const claimsEmitted = claimsPerFinding.reduce((s, cs) => s + cs.length, 0)
      console.log(
        JSON.stringify({
          event: "review-memory-claim-extracted",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          findingCount: filteredConsensusFindings.length,
          claimsEmitted,
          elapsedMs: Date.now() - claimT0,
        }),
      )
    }

    // SIG-285: build the added-line index + verification mode once here —
    // HOISTED above BOTH the SIG-280 shadow-claim fid computation below AND the
    // marker generation, so a re-anchored finding's line is updated BEFORE either
    // reads it (the fid includes `line`). Both consts are reused by the
    // verification block further down (no recompute).
    const verificationMode = readVerificationMode(env)
    const addedLineTextByLine = buildAddedLineTextByLine(fullPrDiff)

    // SIG-285 re-anchor ENFORCE (inline-first): when verification is `enforce`
    // AND OPENCLAW_VERIFICATION_REANCHOR=on (default OFF — inert), MOVE each
    // refuted inline finding that has an UNAMBIGUOUS same-file target to the
    // correct line, in place, keeping the marker source (filteredConsensusFindings)
    // aligned. Runs BEFORE the shadow-claim fid + the markers (Codex #260: so the
    // SIG-280 shadow fid and the posted marker both use the post-move line — no
    // corpus-join divergence). A mis-anchored inline comment becomes a CORRECTLY-
    // anchored one (the founder's inline-first direction) instead of a body row.
    // Re-anchored findings are then no longer refuted at the verification block
    // below, so PR4 only body-demotes the ambiguous/no-match remainder. Default
    // OFF → byte-identical to PR1+PR4.
    if (verificationMode === "enforce" && readReanchorEnabled(env)) {
      const reanchored = applyReanchors(
        submissionVerdict.findings,
        filteredConsensusFindings,
        addedLineTextByLine,
        isSubstantiveAnchorLine,
      )
      for (const r of reanchored) {
        console.log(JSON.stringify({
          event: "verification-reanchor-applied",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          path: r.path, fromLine: r.fromLine, toLine: r.toLine,
        }))
        // dropped:false — a re-anchored finding is KEPT inline (MOVED to the
        // correct line), NOT dropped/demoted. The `applied` reason distinguishes
        // it from the shadow would-reanchor decisions (CodeRabbit #260).
        validationSink?.push({ kind: "gate-rejection", gate: "verification-reanchor", reason: "applied", dropped: false })
      }
    }

    // SIG-276 Phase 3 (Site 2): SHADOW-ONLY claim-match telemetry. Match
    // each incoming finding's write-time claim TYPES against the active
    // memories' `shadowClaims` (populated by lookup Site 1) and emit ONE
    // aggregated `review-memory-claim-shadow` event per review. This pass
    // is OBSERVATION-ONLY — its output is block-scoped and consumed by
    // NOTHING below (no markers, no soften, no submission). It changes no
    // score and posts no comment; it only generates the corpus Phase 4
    // calibrates on. Gated: requires the shadow flag AND real claims
    // (claimsEnabled) AND a non-skipped lookup — otherwise a no-op.
    if (
      claimShadowMode !== "off" &&
      claimsEnabled &&
      shadowMemoriesForPhase3.length > 0
    ) {
      const shadowPathHashes = await Promise.all(
        filteredConsensusFindings.map((f) => computePathSha256(f.path)),
      )
      // SIG-280: per-finding sha16 fid (same canonical form as the marker)
      // becomes the OFFLINE join key linking this claim-matched finding to a
      // later `review-memory-outcome` dismissal event. NOTE (SIG-285, Codex #260):
      // the re-anchor mutation runs ABOVE this block, so `f.line` here is already
      // the post-move line — this fid matches the posted marker fid even for a
      // re-anchored finding (no SIG-280 corpus-join divergence).
      const shadowFids = await Promise.all(
        filteredConsensusFindings.map((f) =>
          computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline }),
        ),
      )
      const shadowFindings: ShadowMatchFinding[] = filteredConsensusFindings.map(
        (f, j) => {
          const sourceSpec = filteredConsensusProvenance[j]?.sourceSpecialists?.[0]
          return {
            category: sourceSpec ? categoryFromRoleHint(sourceSpec) : null,
            pathSha12: shadowPathHashes[j]?.slice(0, 12) ?? null,
            fid: shadowFids[j] ?? "",
            severityTier: severityTier(f.score),
            claims: (claimsPerFinding[j] ?? []).map((c) => ({
              type: c.type,
              extractorVersion: c.extractorVersion,
            })),
          }
        },
      )
      const shadowRows = shadowMatchReviewMemoryClaims({
        memories: shadowMemoriesForPhase3,
        findings: shadowFindings,
      })
      // Emit unconditionally (within the gate): a matchCount:0 event is a
      // meaningful Phase-4 DENOMINATOR — "shadow ran with active memories but
      // no finding's category overlapped" — so coverage is explicit rather
      // than inferred from the absence of an event.
      const shadowEvent = {
        event: "review-memory-claim-shadow",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        matchCount: shadowRows.length,
        matches: shadowRows,
      }
      console.log(JSON.stringify(shadowEvent))
      // SIG-280 PR A: ALSO persist the rows to a durable KV record so the
      // offline calibration fit (which reads KV, not console logs) can read
      // the claim-matched set — the NEGATIVE-class denominator. Each row's
      // `fid` joins to the dismissal signals already in KV (same computeFid),
      // which are the POSITIVE labels. Best-effort: never throws (this is
      // telemetry on the review path); enum/numeric/bool + sha16 fid only.
      try {
        const reverseTs = String(9_999_999_999_999 - Date.now()).padStart(13, "0")
        await env.OPENCLAW_STATE.put(
          `review-memory-claim-shadow:${reverseTs}:${owner}/${repo}#${prNumber}:${headSha.slice(0, 7)}`,
          JSON.stringify(shadowEvent),
          { expirationTtl: 30 * 24 * 60 * 60 },
        )
      } catch {
        // best-effort durable corpus write — losing one is acceptable; the
        // console event still lands for live/Logpush observation.
      }
    }

    // SIG-285 PR 4 filters this in lockstep with submissionVerdict.findings when a
    // refuted finding is demoted, to keep the marker<->finding index alignment the
    // builder relies on (SIG-127). The orchestrator re-binds the returned array to a
    // `let` for that downstream demotion; here it is never reassigned (const).
    const findingMarkers: Array<string | null> = await Promise.all(
      filteredConsensusFindings.map(async (f, j) => {
        const sourceSpec = filteredConsensusProvenance[j]?.sourceSpecialists?.[0]
        if (!sourceSpec) return null
        return await buildSigilixMarker({
          ruleId: null,
          path: f.path,
          line: f.line,
          headline: f.headline,
          category: categoryFromRoleHint(sourceSpec),
          severity: markerSeverityFromScore(f.score),
          claims: claimsPerFinding[j] ?? [],
        })
      }),
    )

  return { verificationMode, addedLineTextByLine, findingMarkers }
}
