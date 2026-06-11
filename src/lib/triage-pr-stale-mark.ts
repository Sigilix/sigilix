// ARC-184: stale-mark queue handler. Runs in parallel with the
// regular pr-review job on `synchronize` / `edited` webhooks. Reads
// the per-PR review manifest, computes current state (file list, base
// SHA, head SHA, prompt version), checks drift, and PATCHes the prior
// review or issue-comment body with a stale-notice block.
//
// No new model calls — pure GitHub-side metadata + non-destructive
// PATCH. Latency target: 1-3 s after webhook arrival, well before the
// new review (30-90 s) lands.
//
// Spec: docs/superpowers/specs/2026-05-06-arc-184-review-provenance-stale-markers-design.md
// Plan: docs/superpowers/plans/2026-05-06-arc-184-review-provenance.md

import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import {
  readReviewManifest,
  computeFileListHash,
  detectReviewStale,
  renderStaleBlock,
  applyStaleBlock,
  type ReviewManifestV1,
  type StaleReason,
} from "./review-manifest"
import type { Env } from "@/src/shared/types/env"

// ─── ARC-189 Task 11: PROMPT_VERSION stale suppression ────────

const SUPPRESSION_FAIL_SAFE_HOURS = 72
const SUPPRESSION_HEARTBEAT_WARN_HOURS = 24
/**
 * Tolerate up to 60s of clock skew between the deploy-time
 * `date +%s` and the worker's `Date.now()`.
 */
const SET_AT_FUTURE_TOLERANCE_SECONDS = 60

export type PromptVersionSuppressionReason =
  | "off"
  | "applies"
  | "set-at-missing"
  | "set-at-malformed"
  | "set-at-future"
  | "set-at-stale"

export interface PromptVersionSuppressionResult {
  /** True when the caller should filter `"prompt-version"` out of
   *  StaleResult.reasons[]. False on every other branch (off,
   *  misconfigured, fail-safe). */
  applies: boolean
  reason: PromptVersionSuppressionReason
  /** Age in hours from SET_AT to now. Negative on future-skew, NaN
   *  on missing/malformed. Used for heartbeat telemetry. */
  ageHours: number
  /** Heartbeat log level when applies=true: info < 24h, warn ≥ 24h.
   *  Undefined on every applies=false branch. */
  heartbeatLevel?: "info" | "warn"
}

/**
 * Pure evaluation of the OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE +
 * companion `_SET_AT` env pair. Spec §4.8 + plan v3 §Task 11. Never
 * throws.
 *
 * Fail-closed default: any misconfiguration (missing/malformed/
 * future SET_AT, or > 72h-stale SET_AT) returns `applies: false` so
 * stale-marking proceeds normally. Misconfiguration NEVER silently
 * disables stale-marking — the worst case is over-firing, never
 * under-firing.
 */
export function evaluatePromptVersionSuppression(env: Env, nowMs: number): PromptVersionSuppressionResult {
  if (env.OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE !== "on") {
    return { applies: false, reason: "off", ageHours: NaN }
  }
  const setAtRaw = env.OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT
  if (typeof setAtRaw !== "string" || setAtRaw.trim().length === 0) {
    return { applies: false, reason: "set-at-missing", ageHours: NaN }
  }
  const setAtSec = Number(setAtRaw)
  if (!Number.isFinite(setAtSec)) {
    return { applies: false, reason: "set-at-malformed", ageHours: NaN }
  }
  const nowSec = nowMs / 1000
  const ageSeconds = nowSec - setAtSec
  const ageHours = ageSeconds / 3600
  if (ageSeconds < -SET_AT_FUTURE_TOLERANCE_SECONDS) {
    return { applies: false, reason: "set-at-future", ageHours }
  }
  if (ageHours > SUPPRESSION_FAIL_SAFE_HOURS) {
    return { applies: false, reason: "set-at-stale", ageHours }
  }
  const heartbeatLevel: "info" | "warn" = ageHours >= SUPPRESSION_HEARTBEAT_WARN_HOURS ? "warn" : "info"
  return { applies: true, reason: "applies", ageHours, heartbeatLevel }
}

/**
 * Surgical filter: drops the `"prompt-version"` reason from a
 * StaleResult.reasons[] array when suppression applies. Other drift
 * (head/base/file-list) is preserved so legitimate stale-marking
 * still fires during the deploy window. Pure.
 */
export function filterReasonsForSuppression(
  reasons: readonly StaleReason[],
  suppressionApplies: boolean,
): StaleReason[] {
  if (!suppressionApplies) return [...reasons]
  return reasons.filter((r) => r !== "prompt-version")
}

const HEARTBEAT_THROTTLE_KEY = "prompt-version-suppress-heartbeat-emitted-at"
const HEARTBEAT_THROTTLE_TTL_SECONDS = 7 * 24 * 60 * 60
const HEARTBEAT_DEDUPE_HOURS = 24

/**
 * KV-backed best-effort heartbeat throttle. Emits the heartbeat
 * event at most once per 24h GLOBAL (singleton key — env-driven, so
 * not per-repo). Workers KV has no CAS so concurrent stale-mark
 * checks crossing the 24h boundary may both emit; spec §4.8 documents
 * this as acceptable. Alert pipelines should de-dupe on
 * `(deployVersion, ageHours)` if exact-once is required.
 */
async function emitSuppressionHeartbeatIfDue(
  env: Env,
  nowMs: number,
  result: PromptVersionSuppressionResult,
  ctx: { owner: string; repo: string; prNumber: number },
): Promise<void> {
  if (!result.applies || !result.heartbeatLevel) return
  const nowSec = Math.floor(nowMs / 1000)
  let lastEmitSec = 0
  try {
    const raw = await env.OPENCLAW_STATE.get(HEARTBEAT_THROTTLE_KEY)
    if (typeof raw === "string") {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) lastEmitSec = parsed
    }
  } catch {
    // Best-effort: if we can't read the throttle, just emit (worst
    // case: a duplicate heartbeat).
  }
  if (nowSec - lastEmitSec < HEARTBEAT_DEDUPE_HOURS * 3600) return
  console.log(
    JSON.stringify({
      event: "review-stale-prompt-version-suppressed-heartbeat",
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      ageHours: result.ageHours,
      level: result.heartbeatLevel,
    }),
  )
  try {
    await env.OPENCLAW_STATE.put(HEARTBEAT_THROTTLE_KEY, String(nowSec), {
      expirationTtl: HEARTBEAT_THROTTLE_TTL_SECONDS,
    })
  } catch {
    // Best-effort: if write fails, the next check may double-emit.
  }
}

export interface PrStaleMarkArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  /** Snapshot of the manifest taken at webhook arrival; the consumer
   * also re-reads to detect concurrent overwrites. */
  manifestSnapshot: ReviewManifestV1
  newHeadSha: string
  newBaseSha: string
  /** Pinned at webhook time so a concurrent prompt deploy between
   * enqueue and consume doesn't smuggle a different value into
   * drift detection. */
  currentPromptVersion: string
}

const MAX_EMPTY_FILELIST_RETRIES = 3
const EMPTY_FILELIST_BACKOFF_MS = 1000

export async function handlePrStaleMark(args: PrStaleMarkArgs): Promise<void> {
  const { env, owner, repo, prNumber, installationId, manifestSnapshot, newHeadSha, newBaseSha, currentPromptVersion } =
    args

  if (env.OPENCLAW_REVIEW_MANIFEST_ENABLED === "off") {
    console.log(JSON.stringify({ event: "review-stale-skipped-disabled", owner, repo, prNumber }))
    return
  }

  // Re-read the manifest. Between enqueue and consume the regular
  // pr-review handler may have just landed a fresh manifest for the
  // new head SHA — that's the up-to-date one and we MUST NOT mark it
  // stale.
  const result = await readReviewManifest(env, owner, repo, prNumber)
  if (result.kind === "missing") {
    console.log(JSON.stringify({ event: "review-manifest-missing", owner, repo, prNumber }))
    return
  }
  if (result.kind === "invalid") {
    console.log(
      JSON.stringify({
        event: "review-manifest-invalid",
        owner,
        repo,
        prNumber,
        reason: result.reason,
      }),
    )
    return
  }
  const manifest = result.manifest
  if (manifest.reviewedAt > manifestSnapshot.reviewedAt) {
    console.log(
      JSON.stringify({
        event: "review-stale-superseded",
        dedupe_system: "kv",
        owner,
        repo,
        prNumber,
      }),
    )
    return
  }

  // Build a GitHub client. Token fetch is best-effort; on failure we
  // log and exit since no further work is possible.
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(
      JSON.stringify({
        event: "review-stale-mark-failed",
        owner,
        repo,
        prNumber,
        err: "missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY",
      }),
    )
    return
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  const client = new GitHubClient({ token })

  // Compute current state. The file-list endpoint can return an empty
  // page on the leading edge of a fresh push (eventual consistency);
  // retry up to MAX_EMPTY_FILELIST_RETRIES times before aborting.
  let files: Awaited<ReturnType<GitHubClient["listPullFilesForManifest"]>> | null = null
  for (let attempt = 1; attempt <= MAX_EMPTY_FILELIST_RETRIES; attempt += 1) {
    files = await client.listPullFilesForManifest(owner, repo, prNumber)
    if (files.entries.length > 0) break
    console.log(
      JSON.stringify({
        event: "review-stale-current-state-empty-retry",
        owner,
        repo,
        prNumber,
        attempt,
      }),
    )
    if (attempt < MAX_EMPTY_FILELIST_RETRIES) {
      await new Promise((r) => setTimeout(r, EMPTY_FILELIST_BACKOFF_MS))
    }
  }
  if (!files || files.entries.length === 0) {
    console.error(
      JSON.stringify({
        event: "review-stale-mark-failed",
        owner,
        repo,
        prNumber,
        err: "empty-files-after-retry",
      }),
    )
    return
  }
  const fileListHash = await computeFileListHash(files)

  const staleResult = detectReviewStale(manifest, {
    headSha: newHeadSha,
    baseSha: newBaseSha,
    fileListHash,
    promptVersion: currentPromptVersion,
  })
  if (!staleResult.stale) {
    console.log(JSON.stringify({ event: "review-stale-not-detected", owner, repo, prNumber }))
    return
  }

  // ARC-189 Task 11: prompt-version suppression. Inserted AFTER
  // detectReviewStale (so the underlying drift detector stays pure)
  // and BEFORE any side-effects (no PATCHes yet emitted). Filters
  // ONLY the "prompt-version" reason out of staleResult.reasons[];
  // other drift (head/base/file-list) is preserved.
  const suppression = evaluatePromptVersionSuppression(env, Date.now())
  if (
    suppression.reason === "set-at-missing" ||
    suppression.reason === "set-at-malformed" ||
    suppression.reason === "set-at-future"
  ) {
    console.log(
      JSON.stringify({
        event: "review-stale-prompt-version-suppress-misconfig",
        owner,
        repo,
        prNumber,
        reason: suppression.reason,
      }),
    )
  } else if (suppression.reason === "set-at-stale") {
    console.log(
      JSON.stringify({
        event: "review-stale-prompt-version-suppressed-stale",
        owner,
        repo,
        prNumber,
        ageHours: suppression.ageHours,
      }),
    )
  }
  if (suppression.applies) {
    await emitSuppressionHeartbeatIfDue(env, Date.now(), suppression, {
      owner,
      repo,
      prNumber,
    })
  }
  const filteredReasons = filterReasonsForSuppression(staleResult.reasons, suppression.applies)
  if (filteredReasons.length === 0) {
    // Only "prompt-version" was the reason and suppression applies →
    // skip stale-mark entirely. Other branches (env off, misconfig,
    // fail-safe) leave the original reasons in place.
    console.log(
      JSON.stringify({
        event: "review-stale-prompt-version-suppressed",
        owner,
        repo,
        prNumber,
      }),
    )
    return
  }
  console.log(
    JSON.stringify({
      event: "review-stale-detected",
      owner,
      repo,
      prNumber,
      reasons: filteredReasons,
      manifestHeadSha: manifest.headSha,
      currentHeadSha: newHeadSha,
      manifestBaseSha: manifest.baseSha,
      currentBaseSha: newBaseSha,
      manifestPromptVersion: manifest.promptVersion,
      currentPromptVersion,
    }),
  )

  // Fetch the prior body, locate / replace the stale block, PATCH.
  const target = manifest.target
  const block = renderStaleBlock(manifest, {
    headSha: newHeadSha,
    baseSha: newBaseSha,
    fileListHash,
    promptVersion: currentPromptVersion,
  })

  try {
    if (target.kind === "review") {
      const review = await client.getReview(owner, repo, prNumber, target.reviewId)
      if (review === null) {
        console.log(
          JSON.stringify({
            event: "review-stale-target-missing",
            owner,
            repo,
            prNumber,
            target: { kind: "review", id: target.reviewId },
          }),
        )
        return
      }
      const newBody = applyStaleBlock(review.body, block)
      await client.updateReviewBody(owner, repo, prNumber, target.reviewId, newBody)
      console.log(
        JSON.stringify({
          event: "review-stale-marked",
          owner,
          repo,
          prNumber,
          target: { kind: "review", id: target.reviewId },
          reasons: filteredReasons,
        }),
      )
    } else {
      const comment = await client.getIssueComment(owner, repo, target.commentId)
      if (comment === null) {
        console.log(
          JSON.stringify({
            event: "review-stale-target-missing",
            owner,
            repo,
            prNumber,
            target: { kind: "issue-comment", id: target.commentId },
          }),
        )
        return
      }
      const newBody = applyStaleBlock(comment.body, block)
      await client.updateIssueComment(owner, repo, target.commentId, newBody)
      console.log(
        JSON.stringify({
          event: "review-stale-marked",
          owner,
          repo,
          prNumber,
          target: { kind: "issue-comment", id: target.commentId },
          reasons: filteredReasons,
        }),
      )
    }
  } catch (err) {
    const status = err instanceof GitHubHttpError ? err.status : undefined
    console.error(
      JSON.stringify({
        event: "review-stale-mark-failed",
        owner,
        repo,
        prNumber,
        target:
          target.kind === "review"
            ? { kind: "review", id: target.reviewId }
            : { kind: "issue-comment", id: target.commentId },
        err: err instanceof Error ? err.message : String(err),
        ...(status !== undefined ? { status } : {}),
      }),
    )
    // 5xx → bubble for queue retry. Anything else (4xx, including
    // 403 permission gap) → swallow; retry won't help.
    if (status !== undefined && status >= 500) throw err
  }
}
