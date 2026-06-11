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

import type { Env } from "@/src/shared/types/env"
import { isRepoSensitive } from "./repo-policy"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import { readRepoIndexManifest } from "./repo-index-manifest"
import { isTrackedLongLivedBranch } from "./index-branch"

export type IndexJobReason =
  | "install"
  | "install-repos-added"
  | "manual"
  /** ARC-237 / SIG-35: push to a refresh-worthy branch fired the re-index. */
  | "push"
  | "pull-request"
  | "merged-pr"

export interface InstallRepoEntry {
  /** May be `null` / missing when GitHub's webhook payload omits the field. */
  name?: string | undefined
  /** "owner/repo" form. The producer extracts owner from this rather than
   *  trusting any `payload.repository.owner.login` (installation-scoped
   *  events have no top-level repository field). */
  full_name?: string | undefined
  /**
   * SIG-243 Phase 1: GitHub's immutable repository ID from the
   * `installation` / `installation_repositories` webhook payload
   * (`repositories[].id` / `repositories_added[].id`). Forwarded onto
   * the queue message so bootstrap manifests carry the canonical ID
   * from their first write. Optional during the transition: legacy
   * paths that build `InstallRepoEntry` synthetically (e.g. the
   * reconciliation cron parsing a `full_name` from a KV scan) leave
   * it undefined, in which case Phase 3's backfill resolves it via a
   * single GitHub API call.
   */
  id?: number | undefined
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
      console.warn(
        JSON.stringify({
          event: "index-job-skip-invalid-payload",
          installation_id: installationId,
          full_name: typeof entry.full_name === "string" ? entry.full_name : null,
          reason,
        }),
      )
      continue
    }
    const { owner, repo } = parsed
    result.attempted += 1

    if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
      result.sensitiveSkipped += 1
      console.log(
        JSON.stringify({
          event: "index-job-skip-sensitive-producer",
          owner,
          repo,
          installation_id: installationId,
          reason,
        }),
      )
      continue
    }

    try {
      // SIG-243 Phase 1: forward repo_id when the install /
      // installation_repositories webhook carried it. Legacy
      // synthetic entries (cron parsing full_name from a KV scan)
      // omit the field; consumer treats it as undefined and skips
      // the manifest field, which Phase 3 backfills. Positive-integer
      // guard matches every other producer site — rejects 0 / negative
      // / non-integer.
      const repoEntryId = entry.id
      await env.OPENCLAW_JOBS.send({
        type: "index-repo",
        owner,
        repo,
        ...(typeof repoEntryId === "number" && Number.isInteger(repoEntryId) && repoEntryId > 0
          ? { githubRepoId: repoEntryId }
          : {}),
        installationId,
        reason,
      })
      result.succeeded += 1
      console.log(
        JSON.stringify({
          event: "index-job-enqueued",
          owner,
          repo,
          installation_id: installationId,
          reason,
        }),
      )
    } catch (err) {
      result.perRepoFailed += 1
      console.error(
        JSON.stringify({
          event: "index-job-enqueue-failed",
          owner,
          repo,
          installation_id: installationId,
          reason,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  return result
}

// ---------------------------------------------------------------------
// ARC-237 — push-driven re-index producer
// ---------------------------------------------------------------------

export type PushEnqueueOutcome =
  | { enqueued: true; reason: "push" }
  | { enqueued: true; reason: "branch-delete" }
  | { skipped: "non-branch" }
  | { skipped: "default-branch-delete" }
  | { skipped: "sensitive" }
  | { skipped: "no-prior-index" }
  | { skipped: "owner-mismatch" }
  | { skipped: "untracked-branch" }
  | { skipped: "missing-default-branch" }
  | { skipped: "missing-creds" }
  | { failed: "enqueue-throw"; reason: string }

export interface MaybeEnqueuePushIndexJobArgs {
  env: Env
  owner: string
  repo: string
  /**
   * SIG-243 Phase 1: GitHub's immutable repository ID from
   * `payload.repository.id` on the push webhook. Optional during the
   * Phase 1 + 2 transition so older callers (manual reconciliation
   * paths) still compile; the consumer falls back gracefully when the
   * field is absent.
   */
  repoId: number | undefined
  installationId: number
  /** `payload.ref` from the push webhook (e.g. `"refs/heads/main"`). */
  ref: string | undefined
  /** `payload.after` — tip commit SHA. `"000…"` indicates branch delete. */
  after: string | undefined
}

const ZERO_SHA = "0000000000000000000000000000000000000000"
const BRANCH_REF_PREFIX = "refs/heads/"

/**
 * ARC-237 / SIG-35: producer for the push-driven re-index. Called from
 * the `event === "push"` branch in `handleGitHubWebhook`. Enqueues a
 * refresh job only when:
 *   - the push is on a branch ref (`refs/heads/…`)
 *   - the repo is NOT in the sensitive denylist
 *   - the repo already has an `repo-index-manifest:<repo>` record
 *     (bootstrap is exclusively install-driven; we don't sneak-bootstrap
 *     via a push event from an unauthorized repo)
 *   - `manifest.owner === owner` (Codex v1 B2: same-name repos under
 *     different owners must not accidentally re-index each other)
 *   - the push branch is the default branch, a configured long-lived branch,
 *     or an active same-repo PR branch. Branch deletes enqueue isolated
 *     branch-state cleanup instead.
 *
 * Push storm coalescing falls out naturally: 10 pushes in 60s enqueue
 * 10 jobs. The first job to process wins the freshness check (writes
 * the manifest pointing at the current branch SHA); the
 * remaining 9 hit `index-job-skip-fresh` and ack. No special primitive
 * required — ARC-235's existing freshness gate is the coalescer.
 */
export async function maybeEnqueuePushIndexJob(args: MaybeEnqueuePushIndexJobArgs): Promise<PushEnqueueOutcome> {
  const { env, owner, repo, repoId, installationId, ref, after } = args

  if (typeof ref !== "string" || !ref.startsWith(BRANCH_REF_PREFIX)) {
    console.log(
      JSON.stringify({
        event: "index-push-skip-non-branch",
        owner,
        repo,
        installation_id: installationId,
        ref,
      }),
    )
    return { skipped: "non-branch" }
  }

  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(
      JSON.stringify({
        event: "index-push-skip-sensitive",
        owner,
        repo,
        installation_id: installationId,
      }),
    )
    return { skipped: "sensitive" }
  }

  const branchName = ref.slice(BRANCH_REF_PREFIX.length)
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(
      JSON.stringify({
        event: "index-push-skip-missing-creds",
        owner,
        repo,
        installation_id: installationId,
      }),
    )
    return { skipped: "missing-creds" }
  }

  const manifest = await readRepoIndexManifest(env, owner, repo)
  if (manifest.kind !== "ok") {
    // No prior default index → don't use push as the bootstrap path.
    // Install / repos-added / reconciliation remain the authorized
    // bootstrap flow; branch indexes depend on a default manifest.
    console.log(
      JSON.stringify({
        event: "index-push-skip-no-prior-index",
        owner,
        repo,
        installation_id: installationId,
        manifest_kind: manifest.kind,
      }),
    )
    return { skipped: "no-prior-index" }
  }
  if (manifest.manifest.owner !== owner) {
    console.warn(
      JSON.stringify({
        event: "index-push-skip-owner-mismatch",
        owner,
        repo,
        installation_id: installationId,
        manifest_owner: manifest.manifest.owner,
      }),
    )
    return { skipped: "owner-mismatch" }
  }

  let defaultBranch: string | null = null
  let branchPolicyLookupFailed = false
  let client: GitHubClient | null = null
  // SIG-243 Phase 1 / CR Major: prefer the webhook payload's
  // `repository.id` if it landed, but fall back to the API result
  // below when the webhook field was missing. The API lookup happens
  // anyway for the default-branch policy check, so this is a
  // zero-cost fallback that prevents push-driven refreshes from
  // silently dropping `githubRepoId`.
  let effectiveRepoId = typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0 ? repoId : undefined
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    client = new GitHubClient({ token })
    const repoMeta = await client.getRepository(owner, repo)
    if (repoMeta) {
      defaultBranch = repoMeta.default_branch
      // SIG-243 Phase 1 / CR Major fallback: if the webhook payload
      // omitted `repository.id` (legacy delivery), use the API
      // result. Positive-integer guard is already applied inside
      // `getRepository`.
      if (effectiveRepoId === undefined && typeof repoMeta.id === "number") {
        effectiveRepoId = repoMeta.id
      }
    } else {
      // 404 → repo gone. Don't enqueue; the consumer would fail too
      // and the push doesn't represent live state worth indexing.
      console.warn(
        JSON.stringify({
          event: "index-push-skip-missing-default-branch",
          owner,
          repo,
          installation_id: installationId,
        }),
      )
      return { skipped: "missing-default-branch" }
    }
  } catch (err) {
    // Transient lookup failure (auth, rate limit, GH 5xx). GitHub does not
    // guarantee automatic redelivery for failed webhook deliveries, so do not
    // silently drop the push. Fall through and enqueue the pushed branch; the
    // consumer fetches repo metadata again and maps it to the default namespace
    // if this branch is the repo default.
    branchPolicyLookupFailed = true
    console.warn(
      JSON.stringify({
        event: "index-push-default-branch-lookup-failed",
        owner,
        repo,
        installation_id: installationId,
        err: err instanceof Error ? err.message : String(err),
        note: "falling through to enqueue; consumer will revalidate",
      }),
    )
  }

  if (after === ZERO_SHA) {
    if (defaultBranch !== null && branchName === defaultBranch) {
      console.log(
        JSON.stringify({
          event: "index-push-skip-default-branch-delete",
          owner,
          repo,
          installation_id: installationId,
          ref,
        }),
      )
      return { skipped: "default-branch-delete" }
    }
    try {
      await env.OPENCLAW_JOBS.send({
        type: "delete-repo-index",
        owner,
        repo,
        branch: branchName,
        reason: "branch-deleted",
      })
      console.log(
        JSON.stringify({
          event: "index-branch-delete-enqueued",
          owner,
          repo,
          installation_id: installationId,
          branch: branchName,
        }),
      )
      return { enqueued: true, reason: "branch-delete" }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          event: "index-branch-delete-enqueue-failed",
          owner,
          repo,
          installation_id: installationId,
          branch: branchName,
          err: reason,
        }),
      )
      return { failed: "enqueue-throw", reason }
    }
  }

  let branchToIndex: string | undefined
  if (defaultBranch === null) {
    branchToIndex = branchPolicyLookupFailed ? branchName : undefined
  } else if (branchName === defaultBranch) {
    branchToIndex = undefined
  } else if (isTrackedLongLivedBranch(branchName, env.OPENCLAW_INDEX_BRANCHES)) {
    branchToIndex = branchName
  } else if (client !== null && (await branchHasOpenSameRepoPr(client, owner, repo, branchName))) {
    branchToIndex = branchName
  } else {
    console.log(
      JSON.stringify({
        event: "index-push-skip-untracked-branch",
        owner,
        repo,
        installation_id: installationId,
        branch: branchName,
        default_branch: defaultBranch,
      }),
    )
    return { skipped: "untracked-branch" }
  }

  try {
    const message: {
      type: "index-repo"
      owner: string
      repo: string
      githubRepoId?: number
      installationId: number
      reason: "push"
      branch?: string
    } = {
      type: "index-repo",
      owner,
      repo,
      installationId,
      reason: "push",
    }
    // SIG-243 Phase 1: include the immutable repo ID. Prefer the
    // webhook payload's value (captured at handler entry) but fall
    // back to the GitHub API result above when the webhook field was
    // missing (CR Major: legacy deliveries dropping `githubRepoId`
    // silently). Already validated as positive integer above; this
    // is the spread under exactOptionalPropertyTypes.
    if (effectiveRepoId !== undefined) {
      message.githubRepoId = effectiveRepoId
    }
    if (branchToIndex) message.branch = branchToIndex
    await env.OPENCLAW_JOBS.send(message)
    console.log(
      JSON.stringify({
        event: "index-push-enqueued",
        owner,
        repo,
        installation_id: installationId,
        branch: branchName,
        index_branch: branchToIndex ?? null,
        after_sha: typeof after === "string" ? after : null,
      }),
    )
    return { enqueued: true, reason: "push" }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(
      JSON.stringify({
        event: "index-push-enqueue-failed",
        owner,
        repo,
        installation_id: installationId,
        err: reason,
      }),
    )
    return { failed: "enqueue-throw", reason }
  }
}

async function branchHasOpenSameRepoPr(
  client: GitHubClient,
  owner: string,
  repo: string,
  branchName: string,
): Promise<boolean> {
  try {
    const expectedFullName = `${owner}/${repo}`.toLowerCase()
    const open = await client.listOpenPullRequests(owner, repo, {
      perPage: 100,
      maxItems: 200,
    })
    return open.some(
      (pr) => pr.head.ref === branchName && (pr.head.repo?.full_name ?? "").toLowerCase() === expectedFullName,
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-push-open-pr-lookup-failed",
        owner,
        repo,
        branch: branchName,
        err: err instanceof Error ? err.message : String(err),
        note: "falling through to enqueue branch index; consumer will revalidate",
      }),
    )
    return true
  }
}

export async function maybeEnqueuePullRequestBranchIndexJobs(args: {
  env: Env
  owner: string
  repo: string
  installationId: number
  action: string | undefined
  draft: boolean | undefined
  headRef: string | undefined
  baseRef: string | undefined
  merged: boolean | undefined
}): Promise<void> {
  const { env, owner, repo, installationId, action, draft, headRef, baseRef, merged } = args
  if (!isIndexerEnabled(env)) return
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) return
  const enqueueFailures: string[] = []

  const isBranchIndexAction =
    action === "opened" || action === "synchronize" || action === "reopened" || action === "ready_for_review"
  if (draft !== true && isBranchIndexAction && headRef && headRef !== baseRef) {
    try {
      await env.OPENCLAW_JOBS.send({
        type: "index-repo",
        owner,
        repo,
        installationId,
        reason: "pull-request",
        branch: headRef,
      })
      console.log(
        JSON.stringify({
          event: "index-pr-branch-enqueued",
          owner,
          repo,
          installation_id: installationId,
          branch: headRef,
          action,
        }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          event: "index-pr-branch-enqueue-failed",
          owner,
          repo,
          installation_id: installationId,
          branch: headRef,
          action,
          err: message,
        }),
      )
      enqueueFailures.push(`index-pr-branch:${message}`)
    }
  }

  if (
    action === "closed" &&
    headRef &&
    headRef !== baseRef &&
    !isTrackedLongLivedBranch(headRef, env.OPENCLAW_INDEX_BRANCHES)
  ) {
    try {
      await env.OPENCLAW_JOBS.send({
        type: "delete-repo-index",
        owner,
        repo,
        branch: headRef,
        reason: "pr-branch-closed",
      })
      console.log(
        JSON.stringify({
          event: "index-pr-branch-delete-enqueued",
          owner,
          repo,
          installation_id: installationId,
          branch: headRef,
          merged: merged === true,
        }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          event: "index-pr-branch-delete-enqueue-failed",
          owner,
          repo,
          installation_id: installationId,
          branch: headRef,
          merged: merged === true,
          err: message,
        }),
      )
      enqueueFailures.push(`index-pr-branch-delete:${message}`)
    }
  } else if (
    action === "closed" &&
    headRef &&
    headRef !== baseRef &&
    isTrackedLongLivedBranch(headRef, env.OPENCLAW_INDEX_BRANCHES)
  ) {
    console.log(
      JSON.stringify({
        event: "index-pr-branch-delete-skipped-tracked",
        owner,
        repo,
        installation_id: installationId,
        branch: headRef,
        merged: merged === true,
      }),
    )
  }

  if (action === "closed" && merged === true && baseRef) {
    try {
      await env.OPENCLAW_JOBS.send({
        type: "index-repo",
        owner,
        repo,
        installationId,
        reason: "merged-pr",
        branch: baseRef,
      })
      console.log(
        JSON.stringify({
          event: "index-pr-merged-base-enqueued",
          owner,
          repo,
          installation_id: installationId,
          branch: baseRef,
        }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          event: "index-pr-merged-base-enqueue-failed",
          owner,
          repo,
          installation_id: installationId,
          branch: baseRef,
          err: message,
        }),
      )
      enqueueFailures.push(`index-pr-merged-base:${message}`)
    }
  }

  if (enqueueFailures.length > 0) {
    throw new Error(`pull-request branch enqueue failures: ${enqueueFailures.join("; ")}`)
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
