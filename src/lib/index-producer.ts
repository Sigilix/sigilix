// ARC-234 — install / repos-added webhook producer for the
// customer-ready indexing pipeline.
//
// Before this module, `src/index.ts:1112+` dropped `installation` and
// `installation_repositories` events with a 200 + "app-level event
// ignored" — meaning every customer install left their repos
// un-indexed and the agent loop's `retrieve_codebase` tool returned
// zero matches against them. This producer is the entry point of the
// ARC-233 epic: it fans out one `index-repo` queue job per added repo,
// and the ARC-235 consumer (in `src/lib/indexer.ts`) walks the tree,
// chunks, embeds, and upserts to Vectorize.
//
// Feature flag: `OPENCLAW_INDEXER_ENABLED === "on"`. Anything else
// (including unset) short-circuits to the legacy drop so commit 1
// (ARC-234) can ship dark and only fire once commit 2's consumer is
// also live. Flip is a runtime config change:
//   wrangler secret put OPENCLAW_INDEXER_ENABLED on
//
// Idempotency is NOT producer-side. Re-install of an already-indexed
// repo always enqueues; the consumer revalidates the manifest's
// `{headSha, modelId, chunkerVersion, embeddingDim}` against the
// current values and short-circuits if fresh. (Codex v1 MAJOR — a
// producer-side skip-gate based on manifest TTL didn't actually force
// re-indexing, just permitted it after expiry.)

import type { Env } from "../index"
import { isRepoSensitive } from "./repo-policy"

export type IndexJobReason = "install" | "install-repos-added" | "manual"

export interface InstallRepoEntry {
  /** May be `null` / missing when GitHub's webhook payload omits the field. */
  name?: string | undefined
  /** "owner/repo" form. The producer extracts owner from this rather than
   *  trusting any `payload.repository.owner.login` (installation-scoped
   *  events have no top-level repository field). */
  full_name?: string | undefined
}

export interface EnqueueIndexJobsResult {
  /** How many entries we attempted to enqueue (after filtering invalid full_name shapes). */
  attempted: number
  /** Enqueues that returned without throwing. */
  succeeded: number
  /** Per-repo errors that fell into the per-repo try/catch. */
  perRepoFailed: number
  /** Repos skipped by `isRepoSensitive`. */
  sensitiveSkipped: number
}

/**
 * Whether the indexer feature flag is on. Helper so other call sites
 * (queue consumer guards, dispatchJob telemetry) read the env var the
 * same way the producer does.
 */
export function isIndexerEnabled(env: Pick<Env, "OPENCLAW_INDEXER_ENABLED">): boolean {
  return env.OPENCLAW_INDEXER_ENABLED === "on"
}

/**
 * Producer for ARC-234. Iterates `repositories` and enqueues one
 * `index-repo` job per entry that passes `parseFullName` + sensitive-
 * repo gate. Per-repo failures (queue send rejections, etc.) are
 * counted but do not abort the fanout — one bad repo shouldn't deny
 * the rest of the install. The caller decides the outer HTTP status
 * based on the aggregate counts (see Codex v2 N5: if 100% of enqueues
 * fail, return 503 so GitHub redelivers).
 *
 * Awaited (NOT `ctx.waitUntil`) so a systemic queue failure surfaces
 * up to the webhook handler.
 */
export async function enqueueIndexJobsForRepos(args: {
  env: Env
  installationId: number
  repositories: ReadonlyArray<InstallRepoEntry>
  reason: IndexJobReason
}): Promise<EnqueueIndexJobsResult> {
  const { env, installationId, repositories, reason } = args
  const result: EnqueueIndexJobsResult = {
    attempted: 0,
    succeeded: 0,
    perRepoFailed: 0,
    sensitiveSkipped: 0,
  }

  for (const entry of repositories) {
    const parsed = parseFullName(entry)
    if (!parsed) {
      console.warn(JSON.stringify({
        event: "index-job-skip-invalid-payload",
        installation_id: installationId,
        full_name: typeof entry.full_name === "string" ? entry.full_name : null,
        reason,
      }))
      continue
    }
    const { owner, repo } = parsed
    result.attempted += 1

    if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
      result.sensitiveSkipped += 1
      console.log(JSON.stringify({
        event: "index-job-skip-sensitive-producer",
        owner, repo, installation_id: installationId, reason,
      }))
      continue
    }

    try {
      await env.OPENCLAW_JOBS.send({
        type: "index-repo",
        owner,
        repo,
        installationId,
        reason,
      })
      result.succeeded += 1
      console.log(JSON.stringify({
        event: "index-job-enqueued",
        owner, repo, installation_id: installationId, reason,
      }))
    } catch (err) {
      result.perRepoFailed += 1
      console.error(JSON.stringify({
        event: "index-job-enqueue-failed",
        owner, repo, installation_id: installationId, reason,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  return result
}

/**
 * Extract `{owner, repo}` from a GitHub install payload `full_name`.
 * Rejects shapes that don't match exactly one `/` separator or have
 * empty halves. GitHub-side validation guarantees the format, but the
 * type is `string | undefined` and we don't want a malformed payload
 * to enqueue a junk job.
 */
export function parseFullName(entry: InstallRepoEntry): { owner: string; repo: string } | null {
  if (typeof entry.full_name !== "string") return null
  const trimmed = entry.full_name.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return null
  if (trimmed.indexOf("/", slash + 1) !== -1) return null
  const owner = trimmed.slice(0, slash)
  const repo = trimmed.slice(slash + 1)
  if (owner.length === 0 || repo.length === 0) return null
  return { owner, repo }
}
