// SIG-318 / SIG-366: the orchestrator's pure module-level helpers + tunables,
// split into a sibling leaf so `app/orchestrator.ts` stays under the 1k-line cap
// (the consistently-respected SIG-318 file-size invariant) after Prettier's
// canonical wrapping pushed it just over. Moved VERBATIM from the orchestrator
// (only the `export` keywords + the import paths change). ZERO behavior change.
//
// All three are part of the public surface — `INLINE_OVERVIEW_MIN_BUDGET_MS` /
// `INLINE_OVERVIEW_MAX_BUDGET_MS` (the SIG-216 inline-overview budget thresholds),
// `resolveEnsembleConfig` (the inject-vs-parse config contract), and the
// `validateForSubmission` public wrapper — so the orchestrator re-exports each one
// (and through the `triage-pr-review-ensemble` shim) so the surface is
// byte-identical.
//
// Dependency rule: a pure leaf — it imports each dependency from its canonical
// NON-shim home (the config parser, the validation domain, the ast-rules feature)
// and only `import type`s `EnsembleHandlerArgs` from the `./orchestrator-types`
// leaf (a leaf->leaf type edge, acyclic). It never imports the orchestrator.

import type { Env } from "@/src/shared/types/env"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { setProviderCooldown } from "@/src/shared/adapters/model/provider-cooldown-client"
import { resolveCooldownMode } from "@/src/lib/ensemble/domain/backpressure"
import { createAstCache, type AstCache } from "@/src/features/ast-rules"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import { postReviewSkipNotice, type SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import type { IncrementalReviewPathSelection } from "@/src/lib/ensemble/domain/incremental-coverage"
import type { createRetrievalCache } from "@/src/lib/retrieval-cache"
import {
  validateForSubmission as validateForSubmissionDomain,
  type ValidateForSubmissionArgs,
  type ValidatedOutput,
} from "@/src/lib/ensemble/domain/validation"
import { finalize, type ReviewMeta } from "./session"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { EnsembleHandlerArgs, EnsembleTelemetry, EnsembleResult } from "./orchestrator-types"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// SIG-216 fix-up: inline-overview budgeting.
//
// The inline pr-overview call inside `handlePrReviewEnsemble` (added in
// SIG-216) runs an additional Ollama generate ON TOP of the ensemble's
// 895s orchestrator budget. The full review handler must finish inside
// the 900s `CF_QUEUE_CONSUMER_CEILING_MS` queue-consumer wall — a stalled
// overview can otherwise push the consumer past the platform ceiling,
// leaving the queue message in the in_progress state and triggering a
// re-delivery + duplicate review.
//
// Floor: when the remaining review budget drops below this, skip the
// inline overview entirely. The overview will fire on the next push or
// can be re-attempted via warmup. 30s reserves enough room for the
// post-overview stale-head re-check + submitReview round-trip + the
// finally cleanup paths.
export const INLINE_OVERVIEW_MIN_BUDGET_MS = 30_000

// Ceiling: even on a generous budget surplus, cap the inline overview
// wall-time at 90s so a single slow overview can never starve the rest
// of the submit pipeline. Matches the same order-of-magnitude as a
// SPECIALIST_TIMEOUT_MS attempt.
export const INLINE_OVERVIEW_MAX_BUDGET_MS = 90_000

// SIG-318 (PR 12f): the private `INLINE_OVERVIEW_SUBMIT_RESERVE_MS` (the reserved
// tail subtracted from the inline-overview budget for the submit + stale-head
// re-check) moved with the publish phase to ensemble/app/publish, which is now the
// only place the inline-overview budget math runs. The two EXPORTED thresholds
// above stay here to preserve the module's public surface.

/**
 * SIG-318 (PR 5a): resolve the typed ensemble config. The Worker edge
 * (src/index.ts) parses it once via `parseEnsembleConfig(env)` and injects it as
 * `args.ensembleConfig`; callers that omit it (tests / non-edge paths) fall back to
 * parsing `env` here. The fallback is transitional and is removed when the
 * orchestrator is thinned (PR 12). Exported so the inject-vs-parse contract is
 * unit-tested directly.
 */
export function resolveEnsembleConfig(args: Pick<EnsembleHandlerArgs, "env" | "ensembleConfig">): EnsembleConfig {
  return args.ensembleConfig ?? parseEnsembleConfig(args.env)
}

// SIG-360: thin public wrapper preserving the original `validateForSubmission`
// signature (astCache OPTIONAL). The believability core moved to
// ./ensemble/domain/validation, where `astCache` is REQUIRED (no features-barrel
// VALUE default in a domain default — the one permitted body delta). Here we
// supply the default so the orchestrator's `satisfies Parameters<typeof
// validateForSubmission>[0]` call site is unchanged. Sync, like the domain fn.
export function validateForSubmission(
  args: Omit<ValidateForSubmissionArgs, "astCache"> & { astCache?: AstCache },
): ValidatedOutput {
  return validateForSubmissionDomain({ ...args, astCache: args.astCache ?? createAstCache() })
}

/**
 * SIG-318 / SIG-366: the orchestrator's telemetry skeleton — populated as the run
 * progresses so a record can be written even on early-failure paths. Built once at
 * the top of `handlePrReviewEnsemble`; `tokenUsageByModel` is shared by reference
 * (the recorder mutates it in place from every settled model attempt). Pure factory
 * — the body is byte-identical to the prior inline literal. ZERO behavior change.
 */
export function createEnsembleTelemetrySkeleton(args: {
  mode: "shadow" | "post"
  owner: string
  repo: string
  prNumber: number
  headSha: string
  tokenUsageByModel: TokenUsageByModel
  startMs: number
}): EnsembleTelemetry {
  const { mode, owner, repo, prNumber, headSha, tokenUsageByModel, startMs } = args
  return {
    schemaVersion: 3,
    owner,
    repo,
    prNumber,
    headSha,
    mode,
    fellBackToPhase3: false,
    routerDecision: null,
    specialistVerdicts: [],
    synthesizer: null,
    postValidation: {
      droppedForInvalidLine: 0,
      remappedInvalidLineToInline: 0,
      droppedForHallucination: 0,
      demotedScore1: 0,
      droppedForVaguePrefix: 0,
      droppedForUncitedTestingEvidence: 0,
      droppedForFailedValidation: 0,
      droppedForFailedTestValidation: 0,
      droppedForFailedLogicValidation: 0,
      droppedForFailedLogicRefutation: 0,
      droppedForFailedLogicClaimRefutation: 0,
      droppedForFailedRefutationSurvival: 0,
      droppedForFailedPerfValidation: 0,
      droppedForFailedInlineGroundingValidation: 0,
      droppedForFailedAbsenceGroundingValidation: 0,
      droppedForFailedWindowBlindnessValidation: 0,
      droppedForFailedSecurityGroundingValidation: 0,
      droppedForFailedSecurityUsageValidation: 0,
    },
    retrievalCacheStats: null,
    tokenUsageByModel,
    startMs,
    totalMs: 0,
  }
}

/**
 * SIG-318 / SIG-366: the Lane-A deterministic-check-annotation `reviewMeta` slice —
 * present only when the SARIF scan produced annotations. The orchestrator wraps this
 * in a zero-arg closure over its mutable `deterministicCheckAnnotations` (the publish
 * phase consumes that closure). Pure; body byte-identical to the prior inline closure.
 */
export function buildDeterministicCheckAnnotationMeta(
  deterministicCheckAnnotations: CheckRunAnnotation[] | undefined,
): { deterministicCheckAnnotations: CheckRunAnnotation[] } | Record<string, never> {
  return deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
    ? { deterministicCheckAnnotations: [...deterministicCheckAnnotations] }
    : {}
}

/**
 * SIG-318 / SIG-366: the `errored`-path `ReviewMeta` that carries Lane-A annotations
 * through post-SARIF failures without pretending a model review posted. Pure; body
 * byte-identical to the prior inline closure (the orchestrator keeps the thin zero-arg
 * closure the publish phase + the bail paths call).
 */
export function buildDeterministicErroredReviewMeta(
  deterministicCheckAnnotations: CheckRunAnnotation[] | undefined,
): ReviewMeta | undefined {
  return deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
    ? {
        // Generic `errored` check-run rendering ignores `event` and
        // `findingsCount`; ReviewMeta requires them only for success titles.
        // These placeholders carry Lane A annotations through post-SARIF
        // failure paths without pretending a model review was posted.
        event: "REQUEST_CHANGES",
        findingsCount: 0,
        deterministicCheckAnnotations: [...deterministicCheckAnnotations],
      }
    : undefined
}

/**
 * SIG-318 / SIG-366: ARC-280 — bail with a customer-visible skip-notice comment + an
 * `errored` result. Used by the silent-skip paths that used to fall through to Phase 3
 * (router_no_specialists, specialists_all_failed, synth retry exhausted). The
 * dispatcher maps `errored` to a `failure` Check Run; the reviewMeta.surface signal
 * flips the title to "Couldn't review — see PR comment."
 *
 * CR Major / Sigilix Logic catch on PR #92: gate the `surface: "skip-notice"`
 * reviewMeta on the post actually succeeding. If `postReviewSkipNotice` returned !ok
 * (or dedupe-hit'd with no comment) we have no comment to point the user at — the
 * Check Run renders the generic "Review failed" title instead of the misleading one.
 *
 * Moved verbatim from the orchestrator's `bailWithSkipNotice` closure; the orchestrator
 * keeps a thin closure that threads the live identity + the mutable cache /
 * deterministic annotations at call time (the specialists phase consumes that closure).
 */
export async function runBailWithSkipNotice(args: {
  reason: SkipNoticeReason
  opts: { dispatchedRoles?: readonly string[] } | undefined
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  telemetry: EnsembleTelemetry
  cache: ReturnType<typeof createRetrievalCache> | null
  deterministicCheckAnnotations: CheckRunAnnotation[] | undefined
  /** SIG-304 (review CLI): dry-run — return a "skipped" result WITHOUT posting the notice. */
  dryRun?: boolean
}): Promise<EnsembleResult> {
  const { reason, opts, env, client, owner, repo, prNumber, headSha, telemetry, cache } = args
  // SIG-304: a headless/CLI dry-run never posts a skip-notice comment. The CLI reads
  // status "skipped" with no `dryRunReview` as "nothing to review".
  if (args.dryRun) {
    return finalize(telemetry, env, "skipped", cache)
  }
  const out = await postReviewSkipNotice({
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
    reason,
    ...(opts?.dispatchedRoles !== undefined ? { dispatchedRoles: opts.dispatchedRoles } : {}),
  })
  // `ok && reason === "posted"` → a fresh comment is on the PR.
  // `ok && reason === "dedupe-hit"` → a prior run already
  //   posted one for this head; safe to claim "see PR comment".
  // `!ok` → no comment; don't lie to the customer.
  if (out.ok) {
    return finalize(telemetry, env, "errored", cache, {
      event: "REQUEST_CHANGES",
      findingsCount: 0,
      surface: "skip-notice",
      ...buildDeterministicCheckAnnotationMeta(args.deterministicCheckAnnotations),
    })
  }
  return finalize(
    telemetry,
    env,
    "errored",
    cache,
    buildDeterministicErroredReviewMeta(args.deterministicCheckAnnotations),
  )
}

/**
 * SIG-304 (review CLI): the `EnsembleResult` a `dryRun` orchestrator run returns —
 * the fully-built review (final validated verdict + body-only findings) carried out
 * on `dryRunReview`, with status "skipped" because nothing was posted. Kept here (not
 * inline) so the orchestrator god-file stays under its line budget.
 */
export function dryRunResult(
  telemetry: EnsembleTelemetry,
  verdict: PrReviewVerdict,
  unanchoredFindings: readonly PrReviewFinding[],
): EnsembleResult {
  // Carry the degraded-coverage signal across the dry-run boundary so a headless
  // caller can refuse to read a PARTIAL review (a specialist was unavailable) as a
  // clean pass — the same incompleteness the prod path turns into an APPROVE→COMMENT
  // downgrade + Coverage line. Full coverage → no `incomplete` field.
  const dc = telemetry.degradedCoverage
  const incomplete = dc && dc.rolesMissing.length > 0 ? { incomplete: { rolesMissing: dc.rolesMissing } } : {}
  return { status: "skipped", telemetry, dryRunReview: { verdict, unanchoredFindings, ...incomplete } }
}

/**
 * Incremental empty-delta no-op (false-APPROVE guard). Under incremental review mode
 * "on", when EVERY changed file in the PR has already been reviewed at its current
 * blobSha (`selection.pathsToReview` is empty), there is nothing new to review. A fresh
 * ensemble run on the empty delta empties `reviewable`, so `tagOutOfPrScopeFindings`
 * tags every surviving finding out-of-PR-scope and the verdict gate returns APPROVE;
 * because GitHub uses a reviewer's LATEST review for branch protection, that same-SHA
 * APPROVE SUPERSEDES the prior CHANGES_REQUESTED — a false approval on unchanged code
 * (observed live: sigilix-monitor#36, same SHA, CHANGES_REQUESTED → APPROVED). Returns
 * a "skipped" result that posts NO review (the prior blocking review stays latest and
 * keeps blocking; no `reviewMeta` → a neutral check title, never "Approved — no issues
 * found"), or `null` when there IS new work to review. Gated on mode "on": in
 * "shadow"/"off" `reviewable` is not emptied so the bug can't occur. A changed file
 * (new blobSha) lands in `pathsToReview` → returns null (recall-safe: changed code is
 * always re-reviewed). Owner/repo/pr/headSha are read off `telemetry` (set at skeleton
 * build) to keep the call site small. Caller short-circuits on a non-null return.
 */
export async function maybeEmptyDeltaSkip(
  incrementalCoverage: { mode: "shadow" | "on"; selection: IncrementalReviewPathSelection } | undefined,
  telemetry: EnsembleTelemetry,
  env: Env,
  cache: ReturnType<typeof createRetrievalCache> | null,
): Promise<EnsembleResult | null> {
  if (incrementalCoverage?.mode !== "on" || incrementalCoverage.selection.pathsToReview.length !== 0) {
    return null
  }
  telemetry.fellBackToPhase3 = false // ARC-280: Phase 3 deleted; always false on every path
  telemetry.fellBackReason = "incremental_no_new_paths"
  console.log(
    JSON.stringify({
      event: "pr-review-skipped",
      reason: "incremental-empty-delta",
      owner: telemetry.owner,
      repo: telemetry.repo,
      prNumber: telemetry.prNumber,
      headSha: telemetry.headSha.slice(0, 7),
      skipped_unchanged_count: incrementalCoverage.selection.skippedUnchangedPaths.length,
    }),
  )
  // SIG-475: do NOT report a "Skipped" status here. The empty-delta skip posts no
  // review and the PRIOR review's overview footer (real finding count + Manage
  // commands) must remain — a "Skipped · 0 findings" terminal would clobber it and
  // mislead (the prior findings are still live + blocking).
  return finalize(telemetry, env, "skipped", cache)
}

// ─── SIG-455 (PR B Task 5): provider cooldown set-on-429 ─────────────────────

type BackgroundWaitUntil = (promise: Promise<void>) => void

/**
 * Fire-and-forget: if cooldown mode is shadow or enforce AND a positive
 * `providerRateLimitMs` was seen this run, write the cooldown to the shared DO.
 * Off mode is a no-op. Fail-open — any DO error is swallowed.
 * The promise is pinned to the Worker lifetime via `backgroundWaitUntil` when
 * provided (prevents the runtime from cutting it off before the DO write lands).
 */
export function applyCooldownFromPhase(
  env: Env,
  providerRateLimitMs: number | undefined,
  backgroundWaitUntil?: BackgroundWaitUntil,
): void {
  const mode = resolveCooldownMode(env)
  if (mode === "off" || !providerRateLimitMs || providerRateLimitMs <= 0) return
  const pending = setProviderCooldown(env, providerRateLimitMs).catch(() => {})
  if (backgroundWaitUntil) backgroundWaitUntil(pending)
  console.log(JSON.stringify({ event: "provider-cooldown-set", retryAfterMs: providerRateLimitMs, mode }))
}
