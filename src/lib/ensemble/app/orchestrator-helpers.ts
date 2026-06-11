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
import { createAstCache, type AstCache } from "@/src/features/ast-rules"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import { postReviewSkipNotice, type SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import type { createRetrievalCache } from "@/src/lib/retrieval-cache"
import {
  validateForSubmission as validateForSubmissionDomain,
  type ValidateForSubmissionArgs,
  type ValidatedOutput,
} from "@/src/lib/ensemble/domain/validation"
import { finalize, type ReviewMeta } from "./session"
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
}): Promise<EnsembleResult> {
  const { reason, opts, env, client, owner, repo, prNumber, headSha, telemetry, cache } = args
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
