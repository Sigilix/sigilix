import { indexNamespace } from "./repo-index-manifest"
import { BRANCH_STATE_SEGMENT } from "../shared/domain/index-keys"

// Re-exported so existing importers of this module keep their surface; the
// canonical definition now lives in `shared/domain/index-keys` — a pure leaf
// both `lib` and the GitHub installation adapter import, so the keyspace token
// has one source of truth (SIG-380 / SIG-318).
export { BRANCH_STATE_SEGMENT }

/** Length of the hex hash suffix in encoded branch segments (64-bit truncation). */
const BRANCH_HASH_HEX_LEN = 16
/** Encoded segment shape: literal "h" + BRANCH_HASH_HEX_LEN hex chars. */
const ENCODED_BRANCH_REGEX = new RegExp(`^h[0-9a-f]{${BRANCH_HASH_HEX_LEN}}$`)

/**
 * SIG-218: bounded-length hash of the branch name. The prior implementation
 * encoded the branch as `h` + utf8-as-hex (linear length growth in branch
 * name), which blew the Vectorize 64-byte namespace cap on any branch
 * longer than ~20 chars — every PR review on such a branch crashed the
 * queue consumer with VECTOR_UPSERT_ERROR (40013).
 *
 * 64-bit SHA-256 truncation gives effectively-zero collision risk within
 * a single repo's branch space. Trade-off: irreversible — the original
 * branch name cannot be recovered from the encoded form. Callers that
 * need the branch name must carry it separately (e.g. in the KV manifest
 * — `RepoIndexManifestV1.branch` — or the message payload), not extract
 * it from the namespace.
 */
export async function encodeBranchName(branch: string): Promise<string> {
  return `h${await sha256HexPrefix(branch.trim(), BRANCH_HASH_HEX_LEN)}`
}

/**
 * Validator for the bounded-length encoded branch segment. Replaces the
 * pre-SIG-218 `decodeBranchName` which returned the recovered branch name;
 * the hash is now irreversible so only structural validity can be checked.
 */
export function isValidEncodedBranch(encoded: string): boolean {
  return ENCODED_BRANCH_REGEX.test(encoded.trim())
}

export async function branchStateRepo(repo: string, branch: string): Promise<string> {
  return `${repo}/${BRANCH_STATE_SEGMENT}/${await encodeBranchName(branch)}`
}

export function isBranchStateRepo(repo: string): boolean {
  const parts = repo.split("/")
  const segment = parts[1]
  const encodedBranch = parts[2]
  return parts.length === 3 && segment === BRANCH_STATE_SEGMENT && typeof encodedBranch === "string" && encodedBranch.length > 0
}

export interface BranchNamespace {
  owner: string
  repo: string
  /**
   * SIG-218: the encoded (hashed) branch segment, NOT the original branch
   * name. The hash is irreversible — callers that need the human branch
   * name must read it from the KV manifest (`RepoIndexManifestV1.branch`)
   * or thread it through from where the namespace was originally constructed.
   */
  encodedBranch: string
  namespace: string
}

export function parseBranchNamespace(namespace: string): BranchNamespace | null {
  const parts = namespace.trim().toLowerCase().split("/")
  if (parts.length !== 4) return null
  const [owner, repo, segment, encodedBranch] = parts
  if (!owner || !repo || segment !== BRANCH_STATE_SEGMENT || !encodedBranch) return null
  if (!isValidEncodedBranch(encodedBranch)) return null
  return {
    owner,
    repo,
    encodedBranch,
    namespace: `${owner}/${repo}/${BRANCH_STATE_SEGMENT}/${encodedBranch}`,
  }
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

export async function resolveIndexTarget(args: {
  owner: string
  repo: string
  defaultBranch: string
  branch?: string | undefined
}): Promise<IndexTarget> {
  const branch = (args.branch?.trim() || args.defaultBranch).trim()
  const isDefault = branch === args.defaultBranch
  const stateRepo = isDefault ? args.repo : await branchStateRepo(args.repo, branch)
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

// Local SHA-256 hex helper — mirrors `sha256HexPrefix` in `indexer.ts` and
// `security-evidence-manifest.ts`. Inlined here (rather than imported) to
// avoid a circular dep with `indexer.ts`, which already imports this file.
async function sha256HexPrefix(input: string, length: number): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return hex.slice(0, length)
}
