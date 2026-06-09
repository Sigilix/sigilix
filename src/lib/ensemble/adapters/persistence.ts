// SIG-363 (PR 11) — the persistence adapter (adapters layer): owns the three KV
// write obligations the ensemble finalize path runs — the review-provenance
// manifest, the per-day budget counter, and the SLO/FP-rate telemetry record —
// all moved VERBATIM out of the god-file. Each closes over `env` (the manifest
// helper also over the `GitHubClient`). `writeReviewManifestForEnsemble` /
// `incrementDailyBudget` / `writeTelemetry` were private in the god-file and are
// EXPORTED here (permitted deltas — the god-file imports them back; public surface
// unchanged). `writeTelemetry`'s param is the ONE permitted non-export delta:
// retyped from the orchestrator-private `EnsembleTelemetry` interface to the
// port's `EnsembleTelemetrySummary` (the `{ owner; repo; prNumber }` routing
// shape — see the SIG-363 DEVIATION note on the port) — runtime-identical (it
// stringifies the whole object and only reads owner/repo/prNumber to build the
// reverse-ts key; the caller passes the same full object). The KV key string +
// TTL stay BYTE-IDENTICAL (contract-tested in fp-rate / metrics-fp-rate-route /
// metrics-graph-expansion-ab).

import type { Env } from "@/shared/types/env"
import { GitHubClient } from "@/shared/adapters/github"
import {
  computeFileListHash,
  writeReviewManifest,
  type ReviewManifestFinding,
  type ReviewManifestV1,
} from "@/lib/review-manifest"
import { PROMPT_VERSION } from "@/prompts/pr-review"
import { TELEMETRY_TTL_DAYS } from "@/lib/fp-rate/attribute"
import type {
  EnsemblePersistencePort,
  EnsembleTelemetrySummary,
} from "../ports/persistence"

/**
 * Best-effort write of the review-provenance manifest from the
 * ensemble post-mode submit paths. Captures the full manifest shape
 * required by Linear AC #1 (head/base/merge-base SHAs, file-list hash,
 * prompt version, model id, target id). KV write failures degrade
 * gracefully — never block the review flow.
 *
 * Skipped when the kill-switch is set: `OPENCLAW_REVIEW_MANIFEST_ENABLED=off`.
 */
export async function writeReviewManifestForEnsemble(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  modelId: string
  reviewId: number
  /** ARC-271: per-finding snapshot for the next push's delta
   *  computation. Optional — when absent or empty, the manifest
   *  omits the `findings` field and the next review surfaces no
   *  delta (e.g., the review had zero findings to record). */
  findings?: ReviewManifestFinding[]
}): Promise<void> {
  const { env, client, owner, repo, prNumber, headSha, baseSha, modelId, reviewId, findings } = args
  if (env.OPENCLAW_REVIEW_MANIFEST_ENABLED === "off") return
  try {
    const [files, mergeBaseSha] = await Promise.all([
      client.listPullFilesForManifest(owner, repo, prNumber),
      baseSha ? client.getMergeBase(owner, repo, baseSha, headSha) : Promise.resolve(null),
    ])
    const fileListHash = await computeFileListHash(files)
    const manifest: ReviewManifestV1 = {
      v: 1,
      prNumber,
      baseSha,
      headSha,
      mergeBaseSha,
      fileListHash,
      promptVersion: PROMPT_VERSION,
      modelId,
      target: { kind: "review", reviewId },
      reviewedAt: Date.now(),
      // CodeRabbit MAJOR catch on PR #83: include `findings` whenever
      // the caller passed an array (even empty), so "previous review
      // had zero findings" is distinguishable from "no ARC-271
      // snapshot exists". The next push reads the empty array and
      // correctly classifies all current findings as `new`.
      ...(findings !== undefined ? { findings } : {}),
    }
    const ok = await writeReviewManifest(env, owner, repo, prNumber, manifest)
    if (ok) {
      console.log(JSON.stringify({
        event: "review-manifest-written",
        owner, repo, prNumber,
        headSha, baseSha, modelId,
        promptVersion: PROMPT_VERSION,
        target: { kind: "review", id: reviewId },
      }))
    } else {
      console.error(JSON.stringify({
        event: "review-manifest-write-failed",
        owner, repo, prNumber,
        err: "writeReviewManifest returned false",
      }))
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "review-manifest-write-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

export async function incrementDailyBudget(env: Env, by: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `ensemble-budget:${today}`
  const raw = await env.OPENCLAW_STATE.get(key)
  const used = raw ? Number.parseInt(raw, 10) : 0
  await env.OPENCLAW_STATE.put(key, String(used + by), { expirationTtl: 48 * 60 * 60 })
}

export async function writeTelemetry(env: Env, telemetry: EnsembleTelemetrySummary): Promise<void> {
  const reverseTs = String(9_999_999_999_999 - Date.now()).padStart(13, "0")
  const key = `ensemble-review-telemetry:${reverseTs}:${telemetry.owner}/${telemetry.repo}#${telemetry.prNumber}`
  // TTL sourced from TELEMETRY_TTL_DAYS so the write expiry and the fp-rate
  // unmatched-dismissal classification can't drift (SIG-306).
  await env.OPENCLAW_STATE.put(key, JSON.stringify(telemetry), {
    expirationTtl: TELEMETRY_TTL_DAYS * 24 * 60 * 60,
  })
}

/**
 * SIG-363: the dormant persistence seam PR 12 wires. Wraps the three helpers,
 * closing over `env` (and, for the manifest, a `GitHubClient`). Today the
 * orchestrator calls the bare functions directly; PR 12 swaps those for this
 * port-typed handle.
 */
export function makePersistenceAdapter(env: Env, client: GitHubClient): EnsemblePersistencePort {
  return {
    writeReviewManifest(args) {
      return writeReviewManifestForEnsemble({ env, client, ...args })
    },
    incrementDailyBudget(by) {
      return incrementDailyBudget(env, by)
    },
    writeTelemetry(telemetry) {
      return writeTelemetry(env, telemetry)
    },
  }
}
