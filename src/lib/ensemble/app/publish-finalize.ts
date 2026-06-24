// SIG-318 / SIG-507 — the shared post-submit persistence tail, extracted from publish.ts so that
// (a) the file stays under the 1000-line COMPLIANCE cap, (b) the inline-anchored primary path and
// the anchorless-422-fallback path share ONE copy (they were byte-identical except the confirmed
// GitHub reviewId), and (c) the fleet contribution (SIG-507) has a single home. A verbatim move of
// best-effort, control-flow-free side effects parameterized by `reviewId`; behavior unchanged.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PullRequestMeta } from "@/src/shared/types/github"
import type { ReviewManifestFinding } from "@/src/lib/review-manifest"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { SigilixConfig } from "@/src/lib/sigilix-config"
import { writeReviewManifestForEnsemble } from "@/src/lib/ensemble/adapters/persistence"
import { writeLastReviewedSha } from "@/src/lib/incremental-review"
import { recordReviewedDiffHash } from "@/src/lib/noop-merge-detect"
import {
  writeIncrementalReviewCoverage,
  type IncrementalReviewCoverageWriteEntry,
} from "@/src/lib/ensemble/adapters/incremental-coverage"
import { contributeFindingsToFleet } from "@/src/lib/fleet/fleet-contribute"

export interface PersistSubmittedReviewDeps {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  repoId: number | undefined
  meta: PullRequestMeta
  reviewManifestEnabled: EnsembleConfig["flags"]["reviewManifestEnabled"]
  currentFindingsForManifest: ReviewManifestFinding[]
  incrementalCoverageEntries?: IncrementalReviewCoverageWriteEntry[]
  fullPrDiff: string
  sigilixConfig: SigilixConfig
  maybePostAstAutoInline: () => Promise<void>
}

/**
 * Run the shared post-submit persistence tail after a CONFIRMED GitHub review submit. Identical on
 * the inline-anchored primary path and the anchorless-422-fallback path except for the confirmed
 * `reviewId` (the only value that varied). All side effects are best-effort; there is no control
 * flow (no return/throw) in this sequence.
 *
 * Recall-safety preserved verbatim: `writeLastReviewedSha` keeps its swallow-and-log try/catch — a
 * KV failure must NOT bubble out as `errored`, which would make the dispatcher post a SECOND
 * Phase-3 review on the same head (CR PR #75). `recordReviewedDiffHash` swallows internally; the
 * manifest/coverage writes keep their original (un-try/caught) semantics so an unexpected throw
 * still surfaces exactly as before.
 */
export async function persistSubmittedReview(deps: PersistSubmittedReviewDeps, reviewId: number): Promise<void> {
  const {
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
    repoId,
    meta,
    reviewManifestEnabled,
    currentFindingsForManifest,
    incrementalCoverageEntries,
    fullPrDiff,
    sigilixConfig,
    maybePostAstAutoInline,
  } = deps
  // ARC-184: write review-provenance manifest. Best-effort.
  // ARC-271: also persist the per-finding snapshot so the next push's review can compute a
  // new/still-open/likely-fixed delta against this run.
  await writeReviewManifestForEnsemble({
    env,
    client,
    enabled: reviewManifestEnabled,
    owner,
    repo,
    prNumber,
    headSha,
    baseSha: meta.base?.sha ?? "",
    modelId: "ensemble-synth",
    reviewId,
    findings: currentFindingsForManifest,
  })
  // ARC-194 / ARC-250: record `lastReviewedSha` only AFTER a confirmed submit. CR PR #75: a KV
  // failure here MUST NOT bubble as `errored` — the customer review already shipped, and an errored
  // result would make the dispatcher post a SECOND review on the same head. Best-effort: swallow + log.
  try {
    await writeLastReviewedSha(env, owner, repo, prNumber, headSha)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-review-last-reviewed-sha-write-failed",
        owner,
        repo,
        prNumber,
        headSha,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  if (incrementalCoverageEntries !== undefined) {
    await writeIncrementalReviewCoverage(env, {
      owner,
      repo,
      prNumber,
      ...(repoId !== undefined ? { repoId } : {}),
      headSha,
      entries: incrementalCoverageEntries,
    })
  }
  // SIG-89: stash the diff hash so the next synchronize push can detect no-op merges and skip
  // dispatch. Best-effort (the helper swallows internally).
  await recordReviewedDiffHash(env, owner, repo, prNumber, fullPrDiff, headSha)
  await maybePostAstAutoInline()
  // SIG-507: contribute these findings' anonymized patterns to the cross-repo fleet aggregate,
  // keyed by the org (the k-anonymity unit). Best-effort + never throws; gated by the per-repo
  // opt-out. Only an abstract signature is stored — never code, paths, or identity.
  // DELIBERATE: contribute from `currentFindingsForManifest` (the post-gate, post-synthesis set the
  // customer actually saw), NOT the richer pre-gate `submissionVerdict.findings` — suppressed/refuted
  // findings must not seed cross-repo patterns. Don't "fix" this toward the verdict.
  await contributeFindingsToFleet(
    env,
    owner,
    currentFindingsForManifest.map((f) => ({
      category: f.category,
      headline: f.headline,
      score: f.score,
      trust: f.trustTier ? { tier: f.trustTier } : undefined,
    })),
    sigilixConfig,
  )
}
