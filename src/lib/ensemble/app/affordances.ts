// SIG-318 (PR 12e) — the submission-affordance cluster of the PR-review
// orchestrator (app layer). Relocated verbatim from `handlePrReviewEnsemble`:
// the REQUEST_CHANGES review-counter + retrigger-URL affordance
// (`prepareSubmissionAffordance`, the thin KV-glue over `pr-review-counter`),
// the helper that merges it into a fallback submission
// (`withSubmissionAffordance`), and the suggestion-emission log builder
// (`buildSuggestionEmissionLogEvents`). These are called by BOTH the carved
// verify-and-build phase AND the orchestrator's later submit/fallback section,
// so they live in their own tiny app module rather than inside verify-and-build.
// The bodies are byte-identical; ZERO behavior change.
//
// Dependency rule: this module imports only the lib leaves (pr-review-counter)
// + the verdict domain (ReviewEvent) + a render-layer type (ReviewSuggestionEmission,
// from its canonical `../render/finding-comment` home — SIG-365 PR 13 removed the
// former god-file lateral). It never imports the orchestrator god-file. The
// god-file re-exports the exported members so existing importers (tests) are
// unaffected.

import type { Env } from "@/src/shared/types/env"
import type { ReviewEvent } from "@/src/lib/ensemble/domain/verdict"
import type { ReviewSuggestionEmission } from "@/src/lib/ensemble/render/finding-comment"
import { buildPrUrl, preparePrReviewCounter } from "@/src/lib/pr-review-counter"

export interface SubmissionAffordance {
  reviewCounter?: number
  retriggerUrl?: string
  persistReviewCounter: () => Promise<void>
}

export function withSubmissionAffordance<T extends object>(
  value: T,
  affordance: SubmissionAffordance,
): T & { reviewCounter?: number; retriggerUrl?: string } {
  return {
    ...value,
    ...(affordance.reviewCounter !== undefined ? { reviewCounter: affordance.reviewCounter } : {}),
    ...(affordance.retriggerUrl !== undefined ? { retriggerUrl: affordance.retriggerUrl } : {}),
  }
}

export interface SuggestionEmissionLogContext {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  commentsSubmitted: boolean
}

export interface SuggestionEmissionLogEvent {
  event: "pr-review-suggestion-emitted"
  owner: string
  repo: string
  prNumber: number
  headSha: string
  path: string
  line: number
  startLine?: number
}

export function buildSuggestionEmissionLogEvents(
  context: SuggestionEmissionLogContext,
  suggestions: readonly ReviewSuggestionEmission[],
): SuggestionEmissionLogEvent[] {
  if (!context.commentsSubmitted) return []
  return suggestions.map((suggestion) => ({
    event: "pr-review-suggestion-emitted",
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
    headSha: context.headSha.slice(0, 7),
    path: suggestion.path,
    line: suggestion.line,
    ...(suggestion.startLine !== undefined ? { startLine: suggestion.startLine } : {}),
  }))
}

export async function prepareSubmissionAffordance(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  event: ReviewEvent
}): Promise<SubmissionAffordance> {
  if (args.event !== "REQUEST_CHANGES") {
    return { persistReviewCounter: async () => undefined }
  }
  const counter = await preparePrReviewCounter(args.env, args.owner, args.repo, args.prNumber)
  return {
    reviewCounter: counter.value,
    retriggerUrl: buildPrUrl(args.owner, args.repo, args.prNumber),
    persistReviewCounter: counter.persist,
  }
}
