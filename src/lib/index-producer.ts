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
import { getInstallationToken } from "./github-app"
import { GitHubClient } from "./github"
import { readRepoIndexManifest } from "./repo-index-manifest"

export type IndexJobReason =
  | "install"
  | "install-repos-added"
  | "manual"
  /** ARC-237: push to the default branch fired the re-index. */
  | "push"

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

// ---------------------------------------------------------------------
// ARC-237 — push-driven re-index producer
// ---------------------------------------------------------------------

export type PushEnqueueOutcome =
  | { enqueued: true; reason: "push" }
  | { skipped: "non-branch" }
  | { skipped: "branch-delete" }
  | { skipped: "sensitive" }
  | { skipped: "no-prior-index" }
  | { skipped: "owner-mismatch" }
  | { skipped: "non-default-branch" }
  | { skipped: "missing-default-branch" }
  | { skipped: "missing-creds" }
  | { failed: "enqueue-throw"; reason: string }

export interface MaybeEnqueuePushIndexJobArgs {
  env: Env
  owner: string
  repo: string
  installationId: number
  /** `payload.ref` from the push webhook (e.g. `"refs/heads/main"`). */
  ref: string | undefined
  /** `payload.after` — tip commit SHA. `"000…"` indicates branch delete. */
  after: string | undefined
}

const ZERO_SHA = "0000000000000000000000000000000000000000"
const BRANCH_REF_PREFIX = "refs/heads/"

/**
 * ARC-237: producer for the push-driven re-index. Called from the
 * `event === "push"` branch in `handleGitHubWebhook`. Enqueues an
 * `index-repo` job with `reason: "push"` only when:
 *   - the push is on a branch ref (`refs/heads/…`)
 *   - the push is NOT a branch delete (after !== "000…")
 *   - the repo is NOT in the sensitive denylist
 *   - the repo already has an `repo-index-manifest:<repo>` record
 *     (bootstrap is exclusively install-driven; we don't sneak-bootstrap
 *     via a push event from an unauthorized repo)
 *   - `manifest.owner === owner` (Codex v1 B2: same-name repos under
 *     different owners must not accidentally re-index each other)
 *   - the push branch matches the current default branch
 *
 * Push storm coalescing falls out naturally: 10 pushes in 60s enqueue
 * 10 jobs. The first job to process wins the freshness check (writes
 * the manifest pointing at the current default-branch SHA); the
 * remaining 9 hit `index-job-skip-fresh` and ack. No special primitive
 * required — ARC-235's existing freshness gate is the coalescer.
 */
export async function maybeEnqueuePushIndexJob(
  args: MaybeEnqueuePushIndexJobArgs,
): Promise<PushEnqueueOutcome> {
  const { env, owner, repo, installationId, ref, after } = args

  if (typeof ref !== "string" || !ref.startsWith(BRANCH_REF_PREFIX)) {
    console.log(JSON.stringify({
      event: "index-push-skip-non-branch",
      owner, repo, installation_id: installationId, ref,
    }))
    return { skipped: "non-branch" }
  }

  if (after === ZERO_SHA) {
    console.log(JSON.stringify({
      event: "index-push-skip-branch-delete",
      owner, repo, installation_id: installationId, ref,
    }))
    return { skipped: "branch-delete" }
  }

  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(JSON.stringify({
      event: "index-push-skip-sensitive",
      owner, repo, installation_id: installationId,
    }))
    return { skipped: "sensitive" }
  }

  const manifest = await readRepoIndexManifest(env, repo)
  if (manifest.kind !== "ok") {
    // No prior index → don't sneak-bootstrap via push. Install /
    // repos-added is the only authorized bootstrap path.
    console.log(JSON.stringify({
      event: "index-push-skip-no-prior-index",
      owner, repo, installation_id: installationId,
      manifest_kind: manifest.kind,
    }))
    return { skipped: "no-prior-index" }
  }
  if (manifest.manifest.owner !== owner) {
    // Codex v1 B2: same-name repo under a different owner; don't
    // accidentally re-index someone else's namespace.
    console.warn(JSON.stringify({
      event: "index-push-skip-owner-mismatch",
      owner, repo, installation_id: installationId,
      manifest_owner: manifest.manifest.owner,
    }))
    return { skipped: "owner-mismatch" }
  }

  // Compare the push branch against the current default branch. The
  // ARC-235 consumer always uses the current default branch, so a
  // push to a non-default branch would just trigger a no-op
  // freshness skip — but we save a queue message + a getRepository
  // call by short-circuiting at the producer when the lookup is
  // available.
  //
  // CR Major #3 on PR #77: GitHub does NOT auto-redeliver failed
  // webhooks. The previous version converted `getInstallationToken`
  // / `getRepository` errors into `skipped: "missing-default-branch"`
  // which permanently lost the push on a transient failure. Since
  // the default-branch check here is purely an optimization (the
  // consumer revalidates on every job per ARC-235's freshness gate),
  // a lookup failure should fall through to enqueue rather than skip
  // — the consumer will resolve the current default branch itself
  // and short-circuit if the push wasn't on it.
  const branchName = ref.slice(BRANCH_REF_PREFIX.length)
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(JSON.stringify({
      event: "index-push-skip-missing-creds",
      owner, repo, installation_id: installationId,
    }))
    return { skipped: "missing-creds" }
  }
  let defaultBranch: string | null = null
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const repoMeta = await client.getRepository(owner, repo)
    if (repoMeta) {
      defaultBranch = repoMeta.default_branch
    } else {
      // 404 → repo gone. Don't enqueue; the consumer would fail too
      // and the push doesn't represent live state worth indexing.
      console.warn(JSON.stringify({
        event: "index-push-skip-missing-default-branch",
        owner, repo, installation_id: installationId,
      }))
      return { skipped: "missing-default-branch" }
    }
  } catch (err) {
    // Transient lookup failure (auth, rate limit, GH 5xx). Fall
    // through to enqueue — the consumer's freshness check is
    // authoritative; if the push wasn't on the default branch,
    // ARC-235's `index-job-skip-fresh` covers the no-op cheaply.
    // Better than silently dropping a real push.
    console.warn(JSON.stringify({
      event: "index-push-default-branch-lookup-failed",
      owner, repo, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
      note: "falling through to enqueue; consumer will revalidate",
    }))
  }

  if (defaultBranch !== null && branchName !== defaultBranch) {
    console.log(JSON.stringify({
      event: "index-push-skip-non-default-branch",
      owner, repo, installation_id: installationId,
      branch: branchName, default_branch: defaultBranch,
    }))
    return { skipped: "non-default-branch" }
  }

  try {
    await env.OPENCLAW_JOBS.send({
      type: "index-repo",
      owner,
      repo,
      installationId,
      reason: "push",
    })
    console.log(JSON.stringify({
      event: "index-push-enqueued",
      owner, repo, installation_id: installationId,
      branch: branchName,
      after_sha: typeof after === "string" ? after : null,
    }))
    return { enqueued: true, reason: "push" }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "index-push-enqueue-failed",
      owner, repo, installation_id: installationId,
      err: reason,
    }))
    return { failed: "enqueue-throw", reason }
  }
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
