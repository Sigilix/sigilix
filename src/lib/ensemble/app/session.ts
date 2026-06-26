// SIG-318 (PR 12f) — the SESSION phase of the PR-review orchestrator (app layer):
// the single finalize choke point every exit path funnels through, plus the
// review-result contract (`EnsembleResult` / `ReviewMeta` / the status union) the
// handler returns. Carved verbatim from `handlePrReviewEnsemble`; the `finalize`
// body is byte-identical, only the function wrapper + the explicit telemetry-type
// parameter is new. ZERO behavior change.
//
// THE TELEMETRY-TYPE PARAMETER (reported): the orchestrator's `EnsembleTelemetry`
// is a ~310-line `interface` that stays god-file-resident (it transitively names
// many god-file-private types — RouterDecision, DeterministicCheckHit, the diff-
// packing/secret-scan/dep-vuln/sarif/review-memory blobs — and is NOT exported).
// `finalize` only touches a handful of its fields (the four routing keys, the two
// it writes — `totalMs`, `retrievalCacheStats` — and the budget/SLO inputs), so
// it is generic over `Tel extends FinalizeTelemetry`: a minimal STRUCTURAL SLICE
// (the persistence-port `EnsembleTelemetrySummary` + 12a `AdjudicateTelemetry`
// precedent). The orchestrator's full `EnsembleTelemetry` satisfies the slice, so
// `Tel` infers to it at the call site and the returned `EnsembleResult<Tel>` is
// the concrete public shape — no behavior change, the full object flows through.
//
// `EnsembleResult` is therefore generic over `Tel` too; the god-file binds the
// concrete `EnsembleResult = EnsembleResultBase<EnsembleTelemetry>` + re-exports
// `ReviewMeta`, so the public surface is byte-identical (same names/kinds).
//
// Dependency rule: every dependency imports from its canonical NON-god-file home —
// the verdict domain (`ReviewEvent`), the github leaf (`CheckRunAnnotation`,
// `Env`), the retrieval-cache leaf, the SLO leaf, and the persistence ADAPTER
// (`incrementDailyBudget` / `writeTelemetry`, the relocated KV writes). It never
// imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import type { ReviewEvent } from "@/src/lib/ensemble/domain/verdict"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { RetrievalCacheStats } from "@/src/lib/retrieval-cache"
import type { createRetrievalCache } from "@/src/lib/retrieval-cache"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import type { ReviewStatusProof } from "@/src/lib/pr-review-status-render"
import type { SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import { emitReviewSlo, computeReviewCost } from "@/src/lib/ensemble-slo-telemetry"
import { incrementDailyBudget, incrementDailyCostUsd, writeTelemetry } from "@/src/lib/ensemble/adapters/persistence"
import { appendUsage } from "@/src/features/tenancy"

// ARC-250: `stale_head` is split out from `skipped` so the dispatcher
// can short-circuit the Phase 3 fallback. Falling through to Phase 3
// when the ensemble guard fired would just hit Phase 3's identical
// stale-head guard and skip again — invisible to the customer.
export type EnsembleResultStatus = "posted" | "shadow_recorded" | "skipped" | "stale_head" | "errored"

/**
 * ARC-276: signal the customer-visible verdict + findings count back
 * to the dispatcher so the Sigilix Check Run title can reflect the
 * actual review outcome (`Approved — no issues found` vs `N findings
 * posted`).
 *
 * ARC-279: `surface` distinguishes a real GitHub review from the
 * fallback PR comment that fires when the formal submit silently
 * rejects. The dispatcher uses `surface === "comment"` to map the
 * Check Run to `failure` with a "see PR comment" title instead of
 * the normal `success` outcome.
 *
 * ARC-280 follow-up: `surface === "skip-notice"` signals that the
 * ensemble couldn't even generate a verdict (router_no_specialists,
 * specialists_all_failed, synth retry exhausted) and posted a
 * minimal "Sigilix couldn't review" comment instead. The catch-all
 * `internal_error` path is intentionally NOT in this list — it
 * returns a generic `errored` result with no `surface`, because the
 * catch may fire before the client/auth is built (so the
 * `bailWithSkipNotice` closure isn't reachable). Set on `status ===
 * "errored"` so the dispatcher's existing errored → failure mapping
 * kicks in; the Check Run renderer then branches on `surface ===
 * "skip-notice"` to show a "couldn't review — see PR comment"
 * title. `event` + `findingsCount` are required by the type but
 * ignored on this branch (we don't have a verdict to count).
 */
export interface ReviewMeta {
  event: ReviewEvent
  findingsCount: number
  /** Default behavior when omitted is `"review"` (back-compat with
   *  Phase 3's `PrReviewMeta` shape). */
  surface?: "review" | "comment" | "skip-notice"
  /** Body-only findings rendered as GitHub Checks annotations. */
  checkAnnotations?: CheckRunAnnotation[]
  /** SIG-171: scanner-derived Lane A annotations rendered independently
   *  from model-authored review findings. */
  deterministicCheckAnnotations?: CheckRunAnnotation[]
  /** SIG-184: the runner-evidence trust state when a receipt was
   *  consulted (flag-gated; omitted = `runner-absent` = no badge).
   *  Flows verbatim into `ReviewCheckMeta.runnerEvidence` (index.ts
   *  spreads this object) so the check-run summary renders the pill. */
  runnerEvidence?: "verified" | "evidence-pending"
  /** SIG-471 PR-3: the pre-formatted overview "Manage" footer line (dismiss/re-run
   *  hint + Review #N + short SHA). The minimal review BODY no longer carries this
   *  footer; it moves to the editable overview status block. Built on the posted
   *  path from the submission affordance's `reviewCounter` + the head SHA, threaded
   *  through `finalStatusUpdate` onto the terminal `ReviewStatusSnapshot.manage`.
   *  Omitted → no Manage line (the overview footer is simply absent). */
  manage?: string
  /** SIG-471 pre-receipt proof counts for the terminal overview status block;
   *  verified=0 until the runner receipt patches it. Built on the posted path from
   *  the manifest findings (empty verifiedKeys), threaded through `finalStatusUpdate`
   *  onto the terminal `ReviewStatusSnapshot.proof` so the overview shows the Proof
   *  line immediately rather than only after the receipt lands. */
  proof?: ReviewStatusProof
}

export type PostReviewWorkOutcome = { status: "completed" } | { status: "failed"; error: string }

/**
 * SIG-304 (review CLI): the built review carried out of a `dryRun` orchestrator run
 * — the final validated/demoted verdict (anchored findings) plus the body-only
 * (unanchored) findings — so a headless/Node caller can render PR-parity output
 * locally without anything being posted. Only set when `args.dryRun` was true.
 */
export interface DryRunReview {
  verdict: PrReviewVerdict
  unanchoredFindings: readonly PrReviewFinding[]
  /** SIG-304 recall-safety: set when the review ran with DEGRADED coverage — a
   *  specialist was unavailable (e.g. logic timed out / provider 500), so the engine
   *  produced a verdict on PARTIAL input. The prod GitHub path downgrades APPROVE→COMMENT
   *  + posts a Coverage line for exactly this; headless callers MUST surface it too (a
   *  partial review is NEVER a clean pass): a banner in plain/rich + a field in json +
   *  a non-zero exit even with zero findings. Absent → full coverage. */
  incomplete?: { rolesMissing: readonly string[] }
}

/**
 * The review-result contract, generic over the telemetry type the handler holds.
 * The god-file binds `Tel = EnsembleTelemetry` (the concrete, public
 * `EnsembleResult`); this generic exists so the result can name the orchestrator's
 * full telemetry shape without this module importing the god-file-private
 * `EnsembleTelemetry` interface (see the header note).
 */
export interface EnsembleResult<Tel = FinalizeTelemetry> {
  status: EnsembleResultStatus
  telemetry: Tel
  /** ARC-276/279/280: set on `posted` (real review or comment
   *  fallback) AND on `errored` when a skip-notice was posted. */
  reviewMeta?: ReviewMeta
  /** Merge-gated follow-up work that must finish before the dispatcher completes the Check Run. */
  postReviewWork?: Promise<PostReviewWorkOutcome>
  /** SIG-304: the built review from a `dryRun` run (CLI/headless). Absent on all prod paths. */
  dryRunReview?: DryRunReview
}

/** Fallback reasons that mean the engine COULD NOT produce a verdict (vs a
 *  legitimate empty/skipped review). See the `fellBackReason` note above.
 *
 *  Every `SkipNoticeReason` IS a no-verdict failure by definition — each is the
 *  reason a skip-notice (not a review) was posted — so this set is the WHOLE union,
 *  derived exhaustively: the `satisfies Record<SkipNoticeReason, true>` makes the
 *  compiler reject any new reason that isn't listed here. This prevents the drift
 *  that previously dropped `synth_failed_parse` / `synth_invalid_provenance` /
 *  `cost_governor_trimmed_all_routable`, which let a failed dry-run synth read as a
 *  clean 200/null pass — the SIG-304 Phase 2.4 recall-safety hole. */
const NO_VERDICT_FAILURES: ReadonlySet<string> = new Set(
  Object.keys({
    router_no_specialists: true,
    specialists_all_failed: true,
    synth_timeout: true,
    synth_failed_parse: true,
    synth_invalid_provenance: true,
    cost_governor_trimmed_all_routable: true,
    internal_error: true,
  } satisfies Record<SkipNoticeReason, true>),
)

/**
 * SIG-304 recall-safety: true when a dry-run result is an ENGINE FAILURE that
 * produced no verdict — `errored`, or a `skipped` bail whose `fellBackReason` means
 * "couldn't even generate a verdict" (total model outage / synth exhaustion).
 * Headless callers (CLI + /v1/review) MUST surface this as an error, NEVER as a
 * clean pass — a transient failure must not read as "no issues found".
 */
export function isDryRunEngineFailure(result: EnsembleResult): boolean {
  if (result.status === "errored") return true
  if (result.dryRunReview) return false
  const reason = (result.telemetry as { fellBackReason?: string }).fellBackReason
  return reason !== undefined && NO_VERDICT_FAILURES.has(reason)
}

/**
 * Minimal structural slice of the orchestrator's `EnsembleTelemetry` that
 * `finalize` actually touches — the four routing fields, the two it writes
 * (`totalMs`, `retrievalCacheStats`), and the budget/SLO inputs (the per-role +
 * synth `attemptsUsed`, the token ledger, the optional first-overview latency).
 * The full `EnsembleTelemetry` satisfies this, so `Tel` infers to it at the call
 * site and `finalize`'s writes land on the same object by reference.
 */
export interface FinalizeTelemetry {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  startMs: number
  totalMs: number
  /** SIG-343: GitHub App installation id — present on prod orchestrator runs,
   *  absent on headless/CLI dry-runs and non-prod telemetry constructors that
   *  do not meter usage. `finalize()` guards on both fields before calling
   *  `appendUsage`, so omitting them simply skips the ledger row. */
  installationId?: number
  /** SIG-343: GitHub repo id — paired with `installationId` for usage metering. */
  repoId?: number
  /** SIG-343 Task 8: PR author login captured from getPullRequest meta.
   *  Forwarded to appendUsage for per-developer attribution. Optional — absent
   *  on early-bail / headless paths that skip getPullRequest. */
  authorLogin?: string
  retrievalCacheStats: RetrievalCacheStats | null
  tokenUsageByModel: TokenUsageByModel
  specialistVerdicts: ReadonlyArray<{ attemptsUsed?: number }>
  synthesizer: { attemptsUsed?: number } | null
  timeToFirstOverviewMs?: number
  /** SIG-417: the pre-flight cost projection (set by `packAndRoute`). Read here
   *  to emit the post-hoc `cost-projection-miss` calibration event. Absent on
   *  early-bail paths that never packed. */
  costProjection?: {
    projectedUsd: number
    governorEnabled: boolean
    governorTrimmed: boolean
  }
}

export async function finalize<Tel extends FinalizeTelemetry>(
  telemetry: Tel,
  env: Env,
  status: EnsembleResultStatus,
  cache: ReturnType<typeof createRetrievalCache> | null,
  reviewMeta?: ReviewMeta,
): Promise<EnsembleResult<Tel>> {
  telemetry.totalMs = Date.now() - telemetry.startMs
  // Capture retrieval cache stats BEFORE the KV write so telemetry
  // reflects everything the cache observed during this run (CR catch).
  if (cache !== null) {
    telemetry.retrievalCacheStats = cache.stats()
  }
  // Best-effort daily-budget increment.
  //
  // CR PR #37 catch: previously this counted dispatched specialists as
  // 1 each + synth as 1. With retries + cross-provider fallback, a
  // single role can use up to 4 model invocations. Using attemptsUsed
  // (set by runWithRetryAndFallback) gives accurate spend telemetry
  // and keeps the daily budget honest.
  let callsUsed = 0
  for (const sv of telemetry.specialistVerdicts) {
    callsUsed += sv.attemptsUsed ?? 1 // ?? 1 — defensive for legacy records
  }
  if (telemetry.synthesizer) {
    callsUsed += telemetry.synthesizer.attemptsUsed ?? 1
  }
  await incrementDailyBudget(env, callsUsed).catch(() => {})
  // SIG-343: meter one usage row per review (best-effort, fail-open — appendUsage
  // never throws and no-ops without the binding or on incomplete identity).
  // Guard explicitly so we never issue a pointless call on headless/CLI dry-runs
  // or non-prod telemetry constructors that omit installationId/repoId.
  if (typeof telemetry.installationId === "number" && typeof telemetry.repoId === "number") {
    try {
      const tokens = Object.values(telemetry.tokenUsageByModel).reduce((n, m) => n + m.inputTokens + m.outputTokens, 0)
      await appendUsage(env, {
        installationId: telemetry.installationId,
        repoId: telemetry.repoId,
        prNumber: telemetry.prNumber,
        headSha: telemetry.headSha,
        modelCalls: callsUsed,
        tokens,
        authorLogin: telemetry.authorLogin ?? null,
        nowIso: new Date().toISOString(),
      })
    } catch {}
  }
  // SIG-149: emit the per-review latency + cost SLO roll-up. Fires here
  // because finalize() is the single choke point every exit path funnels
  // through (success, stale-head, errored, skip-notice) and `totalMs` +
  // `tokenUsageByModel` are both final by now. Pure-observability: the
  // emitter only console.log's + does arithmetic, but we still guard it
  // so a telemetry bug can never convert a posted review into a throw
  // (same discipline as the writeTelemetry catch below). Tier omitted →
  // the `default` SLO target applies until SIG-41 lands plan tiers.
  try {
    emitReviewSlo(
      {
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        headSha: telemetry.headSha,
      },
      {
        status,
        totalMs: telemetry.totalMs,
        usage: telemetry.tokenUsageByModel,
        // Conditional spread under exactOptionalPropertyTypes — absent
        // when no overview posted, so the overview SLO dimension is
        // evaluated as "no data" rather than 0.
        ...(telemetry.timeToFirstOverviewMs !== undefined
          ? { timeToFirstOverviewMs: telemetry.timeToFirstOverviewMs }
          : {}),
      },
    )
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "review-slo-emit-failed",
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
  }
  // SIG-417: the actual per-review cost (blended measured `usage.cost` + the
  // pricing estimate for any unpriced tokens). Computed once here for the
  // separate daily-COST accumulator + the projection-miss calibration event.
  // Guarded so a cost-telemetry bug can never convert a posted review into a
  // throw (same discipline as the SLO + telemetry-write catches).
  try {
    const cost = computeReviewCost(telemetry.tokenUsageByModel)
    // (D) the per-day cost-in-USD accumulator — SEPARATE from the call-count
    // budget above (which loses dollar decimals). Best-effort.
    await incrementDailyCostUsd(env, cost.totalUsd).catch(() => {})
    // (B) post-hoc projection-miss: compare the pre-flight projection against
    // the real spend so the estimator can be calibrated BEFORE any enforcement
    // is ever flipped on. Only when a projection was actually computed.
    if (telemetry.costProjection !== undefined) {
      const projectedUsd = telemetry.costProjection.projectedUsd
      const actualUsd = cost.totalUsd
      console.log(
        JSON.stringify({
          event: "cost-projection-miss",
          owner: telemetry.owner,
          repo: telemetry.repo,
          prNumber: telemetry.prNumber,
          headSha: telemetry.headSha.slice(0, 7),
          projectedUsd,
          actualUsd,
          deltaUsd: actualUsd - projectedUsd,
          // Ratio actual/projected — >1 means the projection under-estimated.
          ratio: projectedUsd > 0 ? actualUsd / projectedUsd : null,
          governorEnabled: telemetry.costProjection.governorEnabled,
          governorTrimmed: telemetry.costProjection.governorTrimmed,
        }),
      )
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "cost-accounting-failed",
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
  }
  // Best-effort telemetry write — but no longer SILENT (SIG-306): a swallowed
  // failure here is exactly how the FP-rate ruler went blind for ~30 days after
  // the org rename. Log the failure (owner/repo/pr) so a regression is visible.
  await writeTelemetry(env, telemetry).catch((e) => {
    console.error(
      JSON.stringify({
        event: "telemetry-write-failed",
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
  })
  return reviewMeta !== undefined ? { status, telemetry, reviewMeta } : { status, telemetry }
}
