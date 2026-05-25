import { indexNamespace } from "./repo-index-manifest"

const BRANCH_STATE_SEGMENT = "__branch__"

/**
 * Encode a Git branch into a stable KV / namespace path segment. GitHub
 * branch names can contain slashes; KV keys and Vectorize namespaces can
 * too, but using one escaped segment keeps branch-state keys easy to
 * recognize and keeps `listIndexedRepos` from mistaking them for default
 * repo manifests.
 */
export function encodeBranchName(branch: string): string {
  return encodeURIComponent(branch.trim()).replace(/%/g, "~").toLowerCase()
}

export function branchStateRepo(repo: string, branch: string): string {
  return `${repo}/${BRANCH_STATE_SEGMENT}/${encodeBranchName(branch)}`
}

export function isBranchStateRepo(repo: string): boolean {
  return repo.toLowerCase().includes(`/${BRANCH_STATE_SEGMENT}/`)
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
