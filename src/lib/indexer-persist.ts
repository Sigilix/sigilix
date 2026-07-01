// SIG-376 (SIG-318 Tier-1 7/8): the persistence + continuation-enqueue
// cluster lifted out of `indexer.ts` so that file stays under the
// 1,000-line budget. `enqueueNextShard`, `persistManifest`,
// `persistVectorIds`, and `persistScopedRulesManifest` relocate verbatim —
// bodies are byte-identical to their prior in-file definitions; only the
// surrounding `export` keywords + the import paths differ.
//
// `persistScopedRulesManifest` calls `leaseAllows`, which the consumer
// handlers in core ALSO call. To keep this leaf from value-importing the
// core (which would close a cycle), `leaseAllows` was relocated INTO
// `indexer-internals.ts`; both core and this leaf import it from there — a
// one-directional leaf → leaf edge (internals ← persist).
//
// `IndexRepoMessage` is a core-private type alias derived from the shared
// `JobMessage` union. `EnqueueNextShardArgs.reason` references its `reason`
// member; rather than `import type` from the core, this leaf re-derives the
// identical alias from `@/shared/types/job` so the moved body stays
// byte-identical and the dependency graph stays acyclic.
//
// Leaf module: imports the manifest / vectors / scoped-rules adapters and
// the shared `leaseAllows` + `TreeEntry` from `indexer-internals.ts`. It
// does NOT value-import the core `indexer.ts`.

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { GitHubClient } from "@/src/shared/adapters/github"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import { writeRepoIndexManifest, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { computeMerge, readRepoIndexVectors, writeRepoIndexVectors } from "@/src/lib/repo-index-vectors"
import { readActiveRunId } from "@/src/lib/repo-index-active-run"
import { CHUNK_LINES, CHUNK_OVERLAP } from "@/src/lib/chunk-core"
import { walkScopedRuleFiles } from "@/src/lib/scoped-rules"
import { writeScopedRulesManifest } from "@/src/lib/scoped-rules-kv"
import { type TreeEntry, leaseAllows, repoRoleClassifyEnabled } from "@/src/lib/indexer-internals"
import { computeRepoRole, type RepoRole } from "@/src/features/repo-role"

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

// ---------------------------------------------------------------------
// Continuation enqueue + manifest write
// ---------------------------------------------------------------------

interface EnqueueNextShardArgs {
  owner: string
  repo: string
  /**
   * SIG-243 Phase 1: parent run's immutable GitHub repo ID. Forwarded
   * onto every shard continuation so the manifest write at the end of
   * the chain stamps the field correctly. Optional during the
   * transition — undefined for legacy bootstrap runs that predate
   * Phase 1.
   */
  githubRepoId: number | undefined
  installationId: number
  reason: IndexRepoMessage["reason"]
  branch?: string
  lo: number
  hi: number
  headSha: string
  treeSha: string
  defaultBranch: string
  totalFiles: number
  filesDone: number
  chunksDone: number
  runId: string
}

export async function enqueueNextShard(env: Env, args: EnqueueNextShardArgs): Promise<void> {
  await env.OPENCLAW_JOBS.send({
    type: "index-repo",
    owner: args.owner,
    repo: args.repo,
    // SIG-243 Phase 1: forward the parent run's GitHub repo ID onto
    // every shard. Conditional spread keeps the queue message tight
    // under exactOptionalPropertyTypes. Positive-integer guard matches
    // every other producer site.
    ...(typeof args.githubRepoId === "number" && Number.isInteger(args.githubRepoId) && args.githubRepoId > 0
      ? { githubRepoId: args.githubRepoId }
      : {}),
    installationId: args.installationId,
    reason: args.reason,
    ...(args.branch ? { branch: args.branch } : {}),
    shard: {
      lo: args.lo,
      hi: args.hi,
      headSha: args.headSha,
      treeSha: args.treeSha,
      defaultBranch: args.defaultBranch,
      totalFiles: args.totalFiles,
      filesDone: args.filesDone,
      chunksDone: args.chunksDone,
      runId: args.runId,
    },
  })
  console.log(
    JSON.stringify({
      event: "index-shard-enqueued",
      owner: args.owner,
      repo: args.repo,
      installation_id: args.installationId,
      run_id: args.runId,
      lo: args.lo,
      hi: args.hi,
      total_files: args.totalFiles,
    }),
  )
}

interface PersistManifestArgs {
  env: Env
  owner: string
  /** Actual GitHub repo name. */
  repo: string
  /**
   * SIG-243 Phase 1: immutable GitHub repository ID, captured at the
   * webhook entry point and threaded through the queue message + the
   * indexer pipeline. Optional during Phases 1 and 2 — legacy queue
   * messages predating Phase 1 omit the field, and bootstrap / install
   * / reconciliation paths that haven't been wired yet pass it as
   * undefined. The manifest persists it when present so Phase 3's
   * backfill knows which records still need the lookup. Phase 4
   * promotes it to the canonical KV key.
   */
  githubRepoId: number | undefined
  /** State repo used for KV manifests/vectors. Branch indexes use repo/__branch__/... */
  stateRepo: string
  namespace: string
  branch: string | null
  defaultBranch: string
  headSha: string
  runId: string
  graphRunId?: string | undefined
  fileCount: number
  chunkCount: number
  shardCount: number
  chunkerVersion: number
  /**
   * A precomputed repo role to carry forward (the incremental push path passes
   * the prior manifest's role so a delta refresh doesn't erase it). Takes
   * precedence over `roleClassify` when set.
   */
  repoRole?: RepoRole | undefined
  /**
   * Full-index inputs for classifying the repo role on this write. When
   * provided (and `repoRole` is not), `persistManifest` runs
   * `computeRepoRoleForIndex` — which self-gates on the feature flag +
   * default-branch and NEVER throws. OPTIONAL + purely ADDITIVE: absent = no
   * classification, no extra fetch. Nothing reads the role yet.
   */
  roleClassify?: { client: GitHubClient; treeEntries: ReadonlyArray<TreeEntry> } | undefined
}

/**
 * Classify the repo's role from cheap index-time signals and return it, or
 * `undefined` when the feature is off / this is not the default-branch run.
 *
 * NEVER throws and NEVER fails the index job: when the flag is off (default) it
 * returns immediately with no package.json fetch; when on it fetches
 * `package.json` best-effort (a fetch error just degrades signals) and any
 * unexpected error is caught and reported as `unknown`. The classification is
 * additive metadata — nothing reads it yet, so this cannot change behavior.
 */
export async function computeRepoRoleForIndex(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  ref: string
  treeEntries: ReadonlyArray<TreeEntry>
  isDefaultBranch: boolean
}): Promise<RepoRole | undefined> {
  if (!args.isDefaultBranch || !repoRoleClassifyEnabled(args.env)) return undefined
  try {
    // Blob-only, matching `walkIndexableFiles`: directory (`type: "tree"`)
    // entries have no extension and would dilute the file-ratio denominator.
    const treePaths: string[] = []
    let hasRootPackageJson = false
    for (const entry of args.treeEntries) {
      if (entry.type !== "blob") continue
      if (typeof entry.path !== "string" || entry.path.length === 0) continue
      treePaths.push(entry.path)
      if (entry.path === "package.json") hasRootPackageJson = true
    }
    // Only fetch package.json when the tree actually has one — skips a
    // guaranteed 404 round-trip for non-JS repos (Go/Rust/Python/infra).
    let packageJsonRaw: string | null = null
    if (hasRootPackageJson) {
      try {
        packageJsonRaw = await args.client.getFileContent(args.owner, args.repo, "package.json", args.ref)
      } catch {
        // A package.json fetch failure just means fewer signals — the
        // classifier still works from the tree paths. Never fail the index job.
        packageJsonRaw = null
      }
    }
    return computeRepoRole({ treePaths, packageJsonRaw })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "repo-role-classify-failed",
        owner: args.owner,
        repo: args.repo,
        ref: args.ref,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return "unknown"
  }
}

export async function persistManifest(args: PersistManifestArgs): Promise<void> {
  const manifest: RepoIndexManifestV1 = {
    v: 1,
    // SIG-35: default-branch manifests keep the historical bare repo
    // value. Branch manifests store a branch-state repo such as
    // `sigilix/__branch__/h646576`, which keeps branch KV/vector state
    // isolated and prevents `listIndexedRepos` from advertising it as
    // another default repo.
    repo: args.stateRepo.toLowerCase(),
    owner: args.owner,
    actualRepo: args.repo.toLowerCase(),
    defaultBranch: args.defaultBranch,
    namespace: args.namespace,
    headSha: args.headSha,
    runId: args.runId,
    fileCount: args.fileCount,
    chunkCount: args.chunkCount,
    shardCount: args.shardCount,
    indexedAt: new Date().toISOString(),
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: args.chunkerVersion,
    windowLines: CHUNK_LINES,
    overlapLines: CHUNK_OVERLAP,
  }
  if (args.branch !== null) {
    manifest.branch = args.branch
  }
  if (args.graphRunId !== undefined) {
    manifest.graphRunId = args.graphRunId
  }
  // SIG-243 Phase 1: persist the immutable repo ID when the queue
  // message carried it. Conditional spread keeps the manifest shape
  // tight under exactOptionalPropertyTypes. Positive-integer guard
  // matches the type-guard in repo-index-manifest.ts.
  if (typeof args.githubRepoId === "number" && Number.isInteger(args.githubRepoId) && args.githubRepoId > 0) {
    manifest.githubRepoId = args.githubRepoId
  }
  // Additive: stamp the detected repo role. A carried-forward role
  // (`args.repoRole`, from an incremental refresh) wins; otherwise classify
  // from the full-index inputs when supplied. Both paths are feature-gated +
  // default-branch only and NEVER throw, so this cannot fail the index job.
  // Nothing reads the role yet — purely additive metadata.
  const repoRole =
    args.repoRole ??
    (args.roleClassify !== undefined
      ? await computeRepoRoleForIndex({
          env: args.env,
          client: args.roleClassify.client,
          owner: args.owner,
          repo: args.repo,
          ref: args.headSha,
          treeEntries: args.roleClassify.treeEntries,
          isDefaultBranch: args.branch === null,
        })
      : undefined)
  if (repoRole !== undefined) {
    manifest.repoRole = repoRole
  }
  try {
    await writeRepoIndexManifest(args.env, manifest)
  } catch (err) {
    // SIG-156 PR3: log + propagate. The throw aborts the consumer and
    // the queue retries — bootstrap is idempotent (freshness-skips on
    // the next attempt if data already landed; otherwise re-runs the
    // slice with content-addressed vector ids).
    console.error(
      JSON.stringify({
        event: "repo-index-manifest-write-failed",
        owner: args.owner,
        repo: args.repo,
        run_id: args.runId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    throw err
  }
}

interface PersistVectorIdsArgs {
  env: Env
  owner: string
  repo: string
  /**
   * SIG-243 Phase 2b: immutable GitHub repo ID from the queue
   * message. Forwarded into the merge so the resulting vectors
   * record carries the field and `writeRepoIndexVectors` dual-writes
   * to `repo-vectors:{id}`. Optional during the Phase 1+2
   * transition — undefined on legacy in-flight shard runs.
   */
  githubRepoId: number | undefined
  runId: string
  idsByPathSlice: Record<string, string[]>
  /**
   * Continuation-shard vs. bootstrap. code-reviewer MED-1: an
   * `invalid-overwrite` outcome on a continuation shard would silently
   * lose prior shards' ids → Vectorize orphans. Throwing here makes
   * the queue retry the shard; if the corruption persists, the queue
   * drops the message after `max_retries` and the operator sees a
   * loud failure. Acceptable trade vs. silent retention.
   */
  isBootstrap: boolean
}

/**
 * ARC-238 Codex v1 B3: run-aware merge + non-best-effort write of the
 * `repo-index-vectors:<repo>` record. Called by every shard BEFORE
 * the manifest write so a write failure prevents the manifest from
 * marking the repo "indexed" while uninstall has no ids to enumerate.
 *
 * code-reviewer MED-2: return a discriminator so callers can guard
 * the manifest-write + next-shard-enqueue on a clean `proceed`. A
 * `stale-skip` result MUST NOT proceed to a manifest write that would
 * overwrite the currently-authoritative manifest with a stale runId.
 *
 * Reads the prior manifest's runId (if any) to disambiguate the
 * run-aware merge decision: a shard whose runId differs from the
 * current manifest's runId is treated as stale and refuses to write.
 *
 * Throws on KV-write failure so the queue retries the shard. Re-runs
 * are idempotent (content-addressed chunk ids).
 */
export async function persistVectorIds(args: PersistVectorIdsArgs): Promise<{ proceed: boolean }> {
  const { env, owner, repo, githubRepoId, runId, idsByPathSlice, isBootstrap } = args
  const existing = await readRepoIndexVectors(env, owner, repo)
  const activeRunId = await readActiveRunId(env, owner, repo)

  const outcome = computeMerge({
    existing,
    owner,
    repo,
    githubRepoId,
    runId,
    idsByPathSlice,
    activeRunId,
  })

  if (outcome.action === "stale-skip") {
    // Different run is the current one. Refuse to write — don't
    // corrupt the live vectors record with stale slice data — and
    // signal the caller to skip the manifest/next-shard write.
    console.warn(
      JSON.stringify({
        event: "repo-index-vectors-stale-skip",
        owner,
        repo,
        run_id: runId,
        existing_run_id: outcome.existingRunId,
        active_run_id: activeRunId,
      }),
    )
    return { proceed: false }
  }

  // code-reviewer MED-1: on a continuation shard, `invalid-overwrite`
  // means we're about to clobber a corrupt record with ONLY this
  // slice's ids — the earlier shards' ids would be lost from the
  // vectors record while their vectors persist in Vectorize. Refuse +
  // throw so the queue retries; if the corruption persists, the
  // operator sees the drop instead of silent leak.
  if (outcome.action === "invalid-overwrite" && !isBootstrap) {
    console.error(
      JSON.stringify({
        event: "repo-index-vectors-invalid-mid-chain",
        owner,
        repo,
        run_id: runId,
        note: "refusing to clobber corrupt record with partial slice; queue retry",
      }),
    )
    throw new Error(`repo-index-vectors corrupt mid-chain for ${repo}`)
  }

  const ok = await writeRepoIndexVectors(env, outcome.vectors)
  if (!ok) {
    console.error(
      JSON.stringify({
        event: "repo-index-vectors-write-failed",
        owner,
        repo,
        run_id: runId,
        action: outcome.action,
      }),
    )
    throw new Error(`repo-index-vectors write failed for ${repo}`)
  }
  console.log(
    JSON.stringify({
      event: "repo-index-vectors-write-ok",
      owner,
      repo,
      run_id: runId,
      action: outcome.action,
      path_count: Object.keys(outcome.vectors.byPath).length,
    }),
  )
  return { proceed: true }
}

// ---------------------------------------------------------------------
// SIG-172: scoped-rules manifest discovery + persistence
// ---------------------------------------------------------------------

interface PersistScopedRulesArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  /** Run id from the bootstrap context — gated by `leaseAllows`
   *  before the KV write so an older run can't clobber a newer one. */
  runId: string
  /** Branch-scoped repo key for the lease check — matches what
   *  `writeActiveRun` keyed on (i.e. `target.stateRepo`). */
  stateRepo: string
  headSha: string
  treeEntries: ReadonlyArray<TreeEntry>
}

/**
 * Enumerate SIGILIX.md + .sigilix/rules/*.md at any depth from the
 * already-fetched repo tree, fetch their content via the same
 * installation token used for indexing, and persist the manifest to
 * KV under `repo-index-rules:<owner>/<repo>`.
 *
 * Best-effort per file fetch: a single failed file is dropped + logged
 * rather than failing the whole manifest. The KV write itself does
 * throw on failure so the caller's try/catch records it as a non-
 * fatal indexer event.
 *
 * Empty rule set still writes the manifest — gives the orchestrator a
 * clean "no rules configured" signal vs. "indexer hasn't run yet"
 * (KV-missing).
 *
 * SIG-172 M2 (fix-up): the KV write is gated by the active-run lease
 * (same `shouldFinalize(activeRunId, runId)` check the manifest +
 * vectors writes use). The fetch loop still runs — small in absolute
 * cost, and the lease may flip between fetch and write — but the
 * write itself is suppressed when this run has been superseded. An
 * older overlapping run completing its rule walk after a newer run
 * had already finalised its scoped-rules manifest would otherwise
 * overwrite the newer rules with stale content.
 */
export async function persistScopedRulesManifest(args: PersistScopedRulesArgs): Promise<void> {
  const { env, client, owner, repo, runId, stateRepo, headSha, treeEntries } = args
  const ruleFiles = walkScopedRuleFiles(treeEntries)
  const entries: Array<{ path: string; content: string }> = []
  for (const file of ruleFiles) {
    let content: string | null = null
    try {
      content = await client.getFileContent(owner, repo, file.path, headSha)
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "scoped-rules-file-fetch-failed",
          owner,
          repo,
          path: file.path,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      continue
    }
    if (content === null) continue
    entries.push({ path: file.path, content })
  }
  // SIG-172 M2 (fix-up): lease check immediately before the write so
  // a slow rule-file walk can't outlive its run-id ownership.
  if (!(await leaseAllows(env, owner, stateRepo, runId))) {
    console.warn(
      JSON.stringify({
        event: "scoped-rules-manifest-skip-superseded",
        owner,
        repo,
        run_id: runId,
        file_count: entries.length,
      }),
    )
    return
  }
  const manifest = await writeScopedRulesManifest(env, owner, repo, entries)
  console.log(
    JSON.stringify({
      event: "scoped-rules-manifest-written",
      owner,
      repo,
      head_sha: headSha,
      file_count: entries.length,
      per_directory_rules: manifest.perDirectoryRules.length,
      glob_rules: manifest.globRules.length,
    }),
  )
}
