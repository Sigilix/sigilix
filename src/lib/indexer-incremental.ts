import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import type { RepoIndexManifestV1, ReadResult as ManifestReadResult } from "@/src/lib/repo-index-manifest"
import { graphIndexEnabled } from "@/src/lib/graph-flags"
import type { IndexTarget } from "@/src/lib/index-branch"
import { readActiveRunId, shouldFinalize, writeActiveRun } from "@/src/lib/repo-index-active-run"
import { debugActiveGraphVersion } from "@/src/lib/repo-graph-client"
import { deleteLexicalIds } from "@/src/lib/lexical-index"
import { processSlice } from "@/src/lib/indexer-slice"
import { persistManifest } from "@/src/lib/indexer-persist"
import { type IndexableFile, walkIndexableFiles } from "@/src/lib/indexer-internals"
import { readRepoIndexVectors, writeRepoIndexVectors, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"

const MAX_INCREMENTAL_CHANGED_PATHS = 200
const VECTORIZE_DELETE_BATCH = 100

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

interface IncrementalArgs {
  job: IndexRepoMessage
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  githubRepoId: number | undefined
  installationId: number
  target: IndexTarget
  headSha: string
  treeSha: string
  runId: string
  astChunking: boolean
  existingManifest: ManifestReadResult
  chunkerVersion: number
}

export async function maybeHandleIncrementalPushIndex(args: IncrementalArgs): Promise<boolean> {
  const changed = normalizeChangedPaths(args.job.changedPaths)
  if (args.job.reason !== "push" || args.job.shard !== undefined || changed === null) return false
  if (args.existingManifest.kind !== "ok") return false

  const prior = args.existingManifest.manifest
  if (!canIncrementFromManifest(prior, args.owner, args.chunkerVersion)) return false
  if (prior.headSha !== args.job.before) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-before-mismatch",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        manifest_head_sha: prior.headSha,
        push_before_sha: args.job.before ?? null,
      }),
    )
    return false
  }

  const vectorsRead = await readRepoIndexVectors(args.env, args.owner, args.target.stateRepo)
  if (vectorsRead.kind !== "ok") return false
  if (!canIncrementFromVectors(vectorsRead.vectors, args.owner, args.target.stateRepo)) return false

  const graphRunId = await preservedGraphRunId(args, prior)
  if (graphRunId === null) return false

  const tree = await args.client.getRepoTree(args.owner, args.repo, args.treeSha)
  if (!tree || tree.truncated) return false

  const indexableFiles = walkIndexableFiles(tree.tree)
  const indexableByPath = new Map(indexableFiles.map((file) => [file.path, file]))
  const filesToProcess = selectFilesToProcess(changed.upsert, indexableByPath)
  const pathsToDelete = unique([...changed.upsert, ...changed.remove])
  const idsToReplace = idsForPaths(vectorsRead.vectors, pathsToDelete)

  await writeActiveRun(args.env, args.owner, args.target.stateRepo, args.runId)

  const activeBeforeProcess = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeProcess, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-process",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
      }),
    )
    return true
  }

  const { idsByPath } = await processSlice({
    client: args.client,
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    stateRepo: args.target.stateRepo,
    namespace: args.target.namespace,
    headSha: args.headSha,
    runId: args.runId,
    files: filesToProcess,
    astChunking: args.astChunking,
  })

  const newIds = idsFromByPath(idsByPath)
  const activeBeforeDelete = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeDelete, args.runId)) {
    await bestEffortDeleteNewIds(args.env, newIds)
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-delete",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
      }),
    )
    return true
  }

  const missingEmbeddedPaths = filesToProcess
    .filter((file) => idsByPath[file.path] === undefined)
    .map((file) => file.path)
  if (missingEmbeddedPaths.length > 0) {
    await bestEffortDeleteNewIds(args.env, newIds)
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-partial-embed",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        missing_paths: missingEmbeddedPaths,
      }),
    )
    return false
  }

  const idsToKeep = new Set(newIds)
  const idsToDelete = idsToReplace.filter((id) => !idsToKeep.has(id))
  await deleteVectorIds(args.env, idsToDelete)
  await deleteLexicalRows(args.env, idsToDelete)

  const vectorsResult = await writeIncrementalVectorIds({
    env: args.env,
    owner: args.owner,
    stateRepo: args.target.stateRepo,
    githubRepoId: args.githubRepoId,
    runId: args.runId,
    existing: vectorsRead.vectors,
    pathsToDelete,
    idsByPath,
  })

  await persistManifest({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    githubRepoId: args.githubRepoId,
    stateRepo: args.target.stateRepo,
    namespace: args.target.namespace,
    branch: args.target.isDefault ? null : args.target.branch,
    defaultBranch: args.target.defaultBranch,
    headSha: args.headSha,
    runId: args.runId,
    graphRunId: graphRunId ?? undefined,
    fileCount: indexableFiles.length,
    chunkCount: vectorsResult.chunkCount,
    shardCount: 1,
    chunkerVersion: args.chunkerVersion,
  })

  console.log(
    JSON.stringify({
      event: "index-incremental-completed",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      run_id: args.runId,
      changed_upsert_paths: changed.upsert.length,
      changed_remove_paths: changed.remove.length,
      embedded_files: filesToProcess.length,
      deleted_vector_ids: idsToDelete.length,
    }),
  )
  return true
}

function canIncrementFromManifest(manifest: RepoIndexManifestV1, owner: string, chunkerVersion: number): boolean {
  return (
    manifest.owner === owner &&
    manifest.modelId === EMBEDDING_MODEL &&
    manifest.embeddingDim === EMBEDDING_DIMENSIONS &&
    manifest.chunkerVersion === chunkerVersion
  )
}

function canIncrementFromVectors(vectors: RepoIndexVectorsV1, owner: string, stateRepo: string): boolean {
  return vectors.owner === owner && vectors.repo === stateRepo.toLowerCase()
}

async function preservedGraphRunId(
  args: IncrementalArgs,
  prior: RepoIndexManifestV1,
): Promise<string | null | undefined> {
  if (!args.target.isDefault || !graphIndexEnabled(args.env)) return undefined
  const expected = prior.graphRunId ?? prior.runId
  let active: string | null = null
  try {
    active = await debugActiveGraphVersion(args.env, args.owner, args.repo)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-graph-version-read-failed",
        owner: args.owner,
        repo: args.repo,
        run_id: args.runId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
  return active === expected ? active : null
}

function normalizeChangedPaths(value: IndexRepoMessage["changedPaths"]): { upsert: string[]; remove: string[] } | null {
  if (value === undefined) return null
  const upsert = new Set(cleanPaths(value.upsert))
  const remove = new Set(cleanPaths(value.remove))
  for (const path of upsert) remove.delete(path)
  if (upsert.size + remove.size === 0 || upsert.size + remove.size > MAX_INCREMENTAL_CHANGED_PATHS) return null
  return { upsert: [...upsert].sort(), remove: [...remove].sort() }
}

function cleanPaths(paths: ReadonlyArray<string>): string[] {
  return paths.filter((path) => path.length > 0 && !path.includes("\0"))
}

function selectFilesToProcess(
  paths: readonly string[],
  indexableByPath: ReadonlyMap<string, IndexableFile>,
): IndexableFile[] {
  const files: IndexableFile[] = []
  for (const path of paths) {
    const file = indexableByPath.get(path)
    if (file) files.push(file)
  }
  return files
}

function idsForPaths(vectors: RepoIndexVectorsV1, paths: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const path of paths) {
    for (const id of vectors.byPath[path] ?? []) ids.add(id)
  }
  return [...ids]
}

function idsFromByPath(byPath: Record<string, string[]>): string[] {
  const ids = new Set<string>()
  for (const pathIds of Object.values(byPath)) {
    for (const id of pathIds) ids.add(id)
  }
  return [...ids]
}

interface WriteIncrementalVectorIdsArgs {
  env: Env
  owner: string
  stateRepo: string
  githubRepoId: number | undefined
  runId: string
  existing: RepoIndexVectorsV1
  pathsToDelete: readonly string[]
  idsByPath: Record<string, string[]>
}

async function writeIncrementalVectorIds(args: WriteIncrementalVectorIdsArgs): Promise<{ chunkCount: number }> {
  const byPath: Record<string, string[]> = {}
  for (const [path, ids] of Object.entries(args.existing.byPath)) {
    byPath[path] = [...ids]
  }
  for (const path of args.pathsToDelete) {
    delete byPath[path]
  }
  for (const [path, ids] of Object.entries(args.idsByPath)) {
    const clean = unique(ids.filter((id) => id.length > 0))
    if (clean.length > 0) byPath[path] = clean
  }

  const vectors: RepoIndexVectorsV1 = {
    v: 1,
    owner: args.owner,
    repo: args.stateRepo.toLowerCase(),
    runId: args.runId,
    byPath,
  }
  const repoId = effectiveGithubRepoId(args.githubRepoId, args.existing.githubRepoId)
  if (repoId !== undefined) vectors.githubRepoId = repoId

  const ok = await writeRepoIndexVectors(args.env, vectors)
  if (!ok) throw new Error(`repo-index-vectors incremental write failed for ${args.stateRepo}`)
  return { chunkCount: idsFromByPath(byPath).length }
}

function effectiveGithubRepoId(incoming: number | undefined, existing: number | undefined): number | undefined {
  if (typeof incoming === "number" && Number.isInteger(incoming) && incoming > 0) return incoming
  if (typeof existing === "number" && Number.isInteger(existing) && existing > 0) return existing
  return undefined
}

async function deleteVectorIds(env: Env, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_BATCH) {
    await env.OPENCLAW_CODE_INDEX.deleteByIds(ids.slice(i, i + VECTORIZE_DELETE_BATCH))
  }
}

async function deleteLexicalRows(env: Env, ids: readonly string[]): Promise<void> {
  if (env.OPENCLAW_LEXICAL_INDEX == null) return
  await deleteLexicalIds(env.OPENCLAW_LEXICAL_INDEX, ids)
}

async function bestEffortDeleteNewIds(env: Env, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await deleteVectorIds(env, ids)
    await deleteLexicalRows(env, ids)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-new-id-cleanup-failed",
        count: ids.length,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
