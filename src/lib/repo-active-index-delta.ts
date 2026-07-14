import {
  parseRepoActiveIndexSnapshot,
  type RepoActiveIndexBuiltMode,
  type RepoActiveIndexMode,
  type RepoActiveIndexSnapshotV1,
} from "@/src/lib/repo-active-index"

export type IncrementalActiveIndexFailureReason =
  | "invalid-live-repo-id"
  | "missing-snapshot"
  | "malformed-snapshot"
  | "wrong-repo-id"
  | "wrong-provenance"

export type IncrementalActiveIndexDecision =
  | { kind: "disabled" }
  | { kind: "reuse"; snapshot: RepoActiveIndexSnapshotV1; builtMode: RepoActiveIndexBuiltMode }
  | { kind: "full-fallback"; reason: IncrementalActiveIndexFailureReason }

export type RepoActiveIndexDeltaBuildResult =
  | { kind: "ready"; snapshot: RepoActiveIndexSnapshotV1 }
  | { kind: "omit" }
  | { kind: "shadow-skip"; reason: "delta-invalid" }

export function decideIncrementalActiveIndex(args: {
  mode: RepoActiveIndexMode
  isDefaultBranch: boolean
  liveGithubRepoId: number | undefined
  priorManifestGithubRepoId: number | undefined
  priorActiveIndex: unknown
}): IncrementalActiveIndexDecision {
  if (args.mode === "off" || !args.isDefaultBranch) return { kind: "disabled" }

  if (!isPositiveSafeInteger(args.liveGithubRepoId)) {
    return failedDecision("invalid-live-repo-id")
  }
  if (args.priorActiveIndex === undefined) {
    return failedDecision("missing-snapshot")
  }

  const snapshot = parseRepoActiveIndexSnapshot(args.priorActiveIndex)
  if (snapshot === null) {
    return failedDecision("malformed-snapshot")
  }
  if (args.priorManifestGithubRepoId !== args.liveGithubRepoId || snapshot.githubRepoId !== args.liveGithubRepoId) {
    return failedDecision("wrong-repo-id")
  }
  if (args.mode === "on" && snapshot.builtMode !== "on") {
    return { kind: "full-fallback", reason: "wrong-provenance" }
  }
  return { kind: "reuse", snapshot, builtMode: args.mode }
}

export function applyRepoActiveIndexDelta(args: {
  prior: RepoActiveIndexSnapshotV1
  builtMode: RepoActiveIndexBuiltMode
  changedPaths: { upsert: readonly string[]; remove: readonly string[] }
  idsByPath: Readonly<Record<string, readonly string[]>>
}): RepoActiveIndexSnapshotV1 {
  const byPath = Object.create(null) as Record<string, string[]>
  for (const [path, ids] of Object.entries(args.prior.byPath)) {
    byPath[path] = [...ids]
  }

  for (const path of new Set([...args.changedPaths.upsert, ...args.changedPaths.remove])) {
    delete byPath[path]
  }
  for (const path of new Set(args.changedPaths.upsert)) {
    if (!Object.prototype.hasOwnProperty.call(args.idsByPath, path)) continue
    const ids = args.idsByPath[path]
    if (ids === undefined || ids.length === 0) continue
    byPath[path] = [...ids]
  }

  const next = parseRepoActiveIndexSnapshot({
    version: 1,
    githubRepoId: args.prior.githubRepoId,
    builtMode: args.builtMode,
    byPath,
  })
  if (next === null) {
    throw new Error("incremental active index delta produced an invalid snapshot")
  }
  return next
}

export function buildRepoActiveIndexDelta(args: {
  decision: IncrementalActiveIndexDecision
  changedPaths: { upsert: readonly string[]; remove: readonly string[] }
  idsByPath: Readonly<Record<string, readonly string[]>>
}): RepoActiveIndexDeltaBuildResult {
  if (args.decision.kind !== "reuse") return { kind: "omit" }
  try {
    return {
      kind: "ready",
      snapshot: applyRepoActiveIndexDelta({
        prior: args.decision.snapshot,
        builtMode: args.decision.builtMode,
        changedPaths: args.changedPaths,
        idsByPath: args.idsByPath,
      }),
    }
  } catch (err) {
    if (args.decision.builtMode === "on") throw err
    return { kind: "shadow-skip", reason: "delta-invalid" }
  }
}

function failedDecision(reason: IncrementalActiveIndexFailureReason): IncrementalActiveIndexDecision {
  return { kind: "full-fallback", reason }
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
