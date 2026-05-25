import { indexNamespace } from "./repo-index-manifest"

export const BRANCH_STATE_SEGMENT = "__branch__"

/**
 * Encode a Git branch into a stable KV / namespace path segment. The
 * wider repo-index namespace is lowercased for tenant isolation, so the
 * branch segment must use a lowercase collision-free encoding rather
 * than a case-sensitive URL encoding.
 */
export function encodeBranchName(branch: string): string {
  const bytes = new TextEncoder().encode(branch.trim())
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `h${hex}`
}

export function branchStateRepo(repo: string, branch: string): string {
  return `${repo}/${BRANCH_STATE_SEGMENT}/${encodeBranchName(branch)}`
}

export function isBranchStateRepo(repo: string): boolean {
  const parts = repo.split("/")
  const segment = parts[1]
  const encodedBranch = parts[2]
  return parts.length === 3 && segment === BRANCH_STATE_SEGMENT && typeof encodedBranch === "string" && encodedBranch.length > 0
}

export interface IndexTarget {
  /** Actual GitHub repo name used for API calls. */
  repo: string
  /** Current repo default branch from GitHub metadata. */
  defaultBranch: string
  /** Branch to read from GitHub. */
  branch: string
  /** Repo identity used for KV ledgers, manifests, leases, and chunk ids. */
  stateRepo: string
  /** Vectorize namespace for this target. */
  namespace: string
  /** True when this target is the default branch compatibility namespace. */
  isDefault: boolean
}

export function resolveIndexTarget(args: {
  owner: string
  repo: string
  defaultBranch: string
  branch?: string | undefined
}): IndexTarget {
  const branch = (args.branch?.trim() || args.defaultBranch).trim()
  const isDefault = branch === args.defaultBranch
  const stateRepo = isDefault ? args.repo : branchStateRepo(args.repo, branch)
  return {
    repo: args.repo,
    defaultBranch: args.defaultBranch,
    branch,
    stateRepo,
    namespace: indexNamespace(args.owner, stateRepo),
    isDefault,
  }
}

const DEFAULT_TRACKED_BRANCHES = new Set([
  "dev",
  "develop",
  "development",
  "staging",
  "stage",
])

export function parseTrackedBranches(value: string | undefined): Set<string> {
  const out = new Set(DEFAULT_TRACKED_BRANCHES)
  if (!value) return out
  for (const raw of value.split(",")) {
    const branch = raw.trim().toLowerCase()
    if (branch.length > 0) out.add(branch)
  }
  return out
}

export function isTrackedLongLivedBranch(
  branch: string,
  configuredBranches: string | undefined,
): boolean {
  return parseTrackedBranches(configuredBranches).has(branch.trim().toLowerCase())
}
