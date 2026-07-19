import type { Env } from "@/src/shared/types/env"
import {
  parseRepoIndexManifest,
  repoIndexManifestKey,
  repoTenantKey,
  type RepoIndexManifestV1,
} from "@/src/lib/repo-index-manifest"
import {
  materializeRepoActiveIndex,
  parseRepoActiveIndexMode,
  parseRepoActiveIndexSnapshot,
  readRepoActiveIndexProgress,
  RepoActiveIndexSealedReplayMismatchError,
  stageRepoActiveIndexSlice,
  type RepoActiveIndexMode,
  type RepoActiveIndexSnapshotV1,
} from "@/src/lib/repo-active-index"

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** Resolve the immutable GitHub identity before any index side effect. */
export function resolveLiveGithubRepoId(args: {
  liveGithubRepoId: number | undefined
  queuedGithubRepoId?: number | undefined
  priorManifest?: RepoIndexManifestV1 | undefined
}): number {
  const { liveGithubRepoId, queuedGithubRepoId, priorManifest } = args
  if (!isPositiveSafeInteger(liveGithubRepoId)) {
    throw new Error("indexer: live repository id missing or unsafe")
  }
  if (queuedGithubRepoId !== undefined && queuedGithubRepoId !== liveGithubRepoId) {
    throw new Error("indexer: repository id mismatch between queue and live GitHub metadata")
  }
  const storedGithubRepoId = priorManifest?.githubRepoId
  if (storedGithubRepoId !== undefined && storedGithubRepoId !== liveGithubRepoId) {
    throw new Error("indexer: repository id mismatch between manifest and live GitHub metadata")
  }
  return liveGithubRepoId
}

export function activeIndexModeForBootstrap(env: Env, isDefaultBranch: boolean): RepoActiveIndexMode {
  return isDefaultBranch ? parseRepoActiveIndexMode(env.OPENCLAW_REPO_ACTIVE_INDEX_MODE) : "off"
}

export function activeIndexModeForContinuation(value: unknown, isDefaultBranch: boolean): RepoActiveIndexMode {
  return isDefaultBranch ? parseRepoActiveIndexMode(value) : "off"
}

function snapshotSupportsMode(
  snapshot: unknown,
  mode: RepoActiveIndexMode,
  githubRepoId: number,
): snapshot is RepoActiveIndexSnapshotV1 {
  const parsed = parseRepoActiveIndexSnapshot(snapshot)
  return (
    parsed !== null &&
    parsed.githubRepoId === githubRepoId &&
    (mode === "shadow" || (mode === "on" && parsed.builtMode === "on"))
  )
}

/** A staged rollout may freshness-skip only when both manifest copies are exact. */
export async function activeIndexAllowsFreshSkip(args: {
  env: Env
  mode: RepoActiveIndexMode
  isDefaultBranch: boolean
  githubRepoId: number
  manifest: RepoIndexManifestV1
}): Promise<boolean> {
  if (!args.isDefaultBranch || args.mode === "off") return true
  if (args.mode === "shadow" && args.env.SIGILIX_PLATFORM_DB === undefined) return true
  if (!snapshotSupportsMode(args.manifest.activeIndex, args.mode, args.githubRepoId)) return false
  const tenantRaw = await args.env.OPENCLAW_STATE.get(repoTenantKey(args.githubRepoId))
  if (tenantRaw === null || tenantRaw !== JSON.stringify(args.manifest)) return false
  const tenant = parseRepoIndexManifest(tenantRaw)
  return (
    tenant.kind === "ok" &&
    tenant.manifest.runId === args.manifest.runId &&
    snapshotSupportsMode(tenant.manifest.activeIndex, args.mode, args.githubRepoId)
  )
}

/** Detect a fully dual-written finalizer replay before repeating vector work. */
export async function activeIndexRunAlreadyPublished(args: {
  env: Env
  mode: RepoActiveIndexMode
  owner: string
  stateRepo: string
  isDefaultBranch: boolean
  githubRepoId: number
  runId: string
}): Promise<boolean> {
  if (!args.isDefaultBranch || args.mode === "off") return false
  const [legacyRaw, tenantRaw] = await Promise.all([
    args.env.OPENCLAW_STATE.get(repoIndexManifestKey(args.owner, args.stateRepo)),
    args.env.OPENCLAW_STATE.get(repoTenantKey(args.githubRepoId)),
  ])
  if (legacyRaw === null || legacyRaw !== tenantRaw) return false
  const parsed = parseRepoIndexManifest(legacyRaw)
  return (
    parsed.kind === "ok" &&
    parsed.manifest.runId === args.runId &&
    snapshotSupportsMode(parsed.manifest.activeIndex, args.mode, args.githubRepoId)
  )
}

export interface StageActiveIndexResult {
  bookmark?: string
  chunkCount?: number
  completedThrough?: number
  shardCount?: number
  activeIndex?: RepoActiveIndexSnapshotV1
  /** A divergent late replay found a complete canonical run and must stop. */
  runSealed?: true
}

/** Manifest counts must follow the canonical membership on replay repair. */
export function repoActiveIndexChunkCount(snapshot: RepoActiveIndexSnapshotV1): number {
  return Object.values(snapshot.byPath).reduce((total, ids) => total + ids.length, 0)
}

export async function computeRepoActiveStageRunId(
  sourceRunId: string,
  mode: Exclude<RepoActiveIndexMode, "off">,
  installationId: number,
): Promise<string> {
  if (!isPositiveSafeInteger(installationId)) throw new Error("invalid installation id")
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${sourceRunId}\0${mode}\0${installationId}`),
  )
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Resume the canonical D1 high-water before repeating queue work. */
export async function readActiveIndexProgress(args: {
  env: Env
  mode: RepoActiveIndexMode
  isDefaultBranch: boolean
  githubRepoId: number
  installationId: number
  runId: string
  totalFiles: number
}): Promise<StageActiveIndexResult | null> {
  if (!args.isDefaultBranch || args.mode === "off") return null
  const db = args.env.SIGILIX_PLATFORM_DB
  if (db === undefined) {
    if (args.mode === "on") throw new Error("SIGILIX_PLATFORM_DB is unavailable")
    return null
  }
  const stageRunId = await computeRepoActiveStageRunId(args.runId, args.mode, args.installationId)
  try {
    const progress = await readRepoActiveIndexProgress({
      db,
      githubRepoId: args.githubRepoId,
      installationId: args.installationId,
      runId: stageRunId,
      totalFiles: args.totalFiles,
      mode: args.mode,
    })
    if (progress === null) return null
    const base = {
      chunkCount: progress.chunkCount,
      completedThrough: progress.completedThrough,
      shardCount: progress.shardCount,
      ...(progress.bookmark === null ? {} : { bookmark: progress.bookmark }),
    }
    if (progress.completedThrough < args.totalFiles) return base
    const materialized = await materializeRepoActiveIndex({
      db,
      githubRepoId: args.githubRepoId,
      runId: stageRunId,
      bookmark: progress.bookmark,
    })
    return {
      ...base,
      ...(materialized.bookmark === null ? {} : { bookmark: materialized.bookmark }),
      activeIndex: materialized.snapshot,
    }
  } catch (error) {
    if (args.mode === "on") throw error
    console.warn(
      JSON.stringify({
        event: "repo-active-index-shadow-resume-failed",
        github_repo_id: args.githubRepoId,
        run_id: args.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/** Stage one default-branch slice; shadow failures preserve legacy indexing. */
export async function stageActiveIndexSlice(args: {
  env: Env
  mode: RepoActiveIndexMode
  isDefaultBranch: boolean
  githubRepoId: number
  installationId: number
  runId: string
  totalFiles: number
  lo: number
  hi: number
  idsByPath: Readonly<Record<string, readonly string[]>>
  bookmark?: string | undefined
  finalize: boolean
}): Promise<StageActiveIndexResult> {
  if (!args.isDefaultBranch || args.mode === "off") return {}
  const db = args.env.SIGILIX_PLATFORM_DB
  if (db === undefined) return activeIndexFailure(args, new Error("SIGILIX_PLATFORM_DB is unavailable"))
  const stageRunId = await computeRepoActiveStageRunId(args.runId, args.mode, args.installationId)
  try {
    const staged = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: args.githubRepoId,
      installationId: args.installationId,
      runId: stageRunId,
      totalFiles: args.totalFiles,
      lo: args.lo,
      hi: args.hi,
      mode: args.mode,
      idsByPath: args.idsByPath,
      ...(args.bookmark !== undefined ? { bookmark: args.bookmark } : {}),
    })
    const replayed =
      staged.completedThrough === args.hi
        ? null
        : await readRepoActiveIndexProgress({
            db,
            githubRepoId: args.githubRepoId,
            installationId: args.installationId,
            runId: stageRunId,
            totalFiles: args.totalFiles,
            mode: args.mode,
          })
    const base = {
      ...(replayed === null ? {} : { chunkCount: replayed.chunkCount }),
      completedThrough: staged.completedThrough,
      shardCount: staged.shardCount,
      ...(staged.bookmark === null ? {} : { bookmark: staged.bookmark }),
    }
    if (staged.completedThrough < args.totalFiles) return base
    const materialized = await materializeRepoActiveIndex({
      db,
      githubRepoId: args.githubRepoId,
      runId: stageRunId,
      bookmark: staged.bookmark,
    })
    return {
      ...base,
      ...(materialized.bookmark === null ? {} : { bookmark: materialized.bookmark }),
      activeIndex: materialized.snapshot,
    }
  } catch (error) {
    if (error instanceof RepoActiveIndexSealedReplayMismatchError) {
      if (!args.finalize) return { runSealed: true }
      try {
        const materialized = await materializeRepoActiveIndex({
          db,
          githubRepoId: args.githubRepoId,
          runId: stageRunId,
          ...(args.bookmark !== undefined ? { bookmark: args.bookmark } : {}),
        })
        return {
          ...(materialized.bookmark === null ? {} : { bookmark: materialized.bookmark }),
          activeIndex: materialized.snapshot,
          runSealed: true,
        }
      } catch (materializeError) {
        return activeIndexFailure(args, materializeError)
      }
    }
    return activeIndexFailure(args, error)
  }
}

function activeIndexFailure(
  args: { mode: RepoActiveIndexMode; githubRepoId: number; runId: string; lo: number; hi: number },
  error: unknown,
): StageActiveIndexResult {
  if (args.mode === "on") throw error
  console.warn(
    JSON.stringify({
      event: "repo-active-index-shadow-failed",
      github_repo_id: args.githubRepoId,
      run_id: args.runId,
      lo: args.lo,
      hi: args.hi,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return {}
}
