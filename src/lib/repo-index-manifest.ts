// ARC-235 — KV manifest for the customer-ready indexing pipeline.
//
// One record per indexed repo, keyed `repo-index-manifest:<owner>/<repo>`
// (lowercased — matching the Vectorize namespace contract used at
// retrieval time in `src/lib/retrieval.ts` and the agent loop's
// `retrieve_codebase` tool). SIG-132 moved the key + namespace from the
// bare `<repo>` to `<owner>/<repo>` for multi-tenant isolation.
//
// Distinct from `pr-review-manifest:<owner>/<repo>#<prNumber>` (ARC-184,
// per-PR review provenance). Per Codex v2 BLOCKING: a repo-level key
// with the same prefix as ARC-184's per-PR key would be confusing even
// if it doesn't byte-collide; `repo-index-manifest:` is the clean
// namespace boundary.
//
// Consumer-side revalidation policy (Codex v1 MAJOR): the ARC-235
// consumer reads this record at the START of every job and skips
// (logs `index-job-skip-fresh`) when:
//   manifest.headSha === currentHeadSha &&
//   manifest.modelId === EMBEDDING_MODEL &&
//   manifest.chunkerVersion === CHUNKER_VERSION &&
//   manifest.embeddingDim === EMBEDDING_DIMENSIONS &&
//   manifest.owner === owner
//
// Any mismatch → re-index. TTL is just a backstop for stuck/abandoned
// manifests — revalidation does the real freshness work.

import type { Env } from "../index"

// SIG-132 (2026-05-20) — multi-tenant isolation. The index namespace
// (Vectorize namespace + the suffix of the manifest/vectors KV keys) is
// now `<owner>/<repo>` lowercased, NOT the bare `<repo>`. Two orgs with a
// repo named `api` previously collided in one Vectorize namespace + KV
// keyspace (retrieval queries `namespace = repo` with no owner gate),
// leaking chunks across tenants.
//
// Migration: existing bare-namespace data (`repo-index-manifest:<repo>`,
// `repo-index-vectors:<repo>`, Vectorize namespace `<repo>`) is orphaned
// by this change. Repos re-index on next push under the new namespace —
// the freshness gate self-heals because the new-key manifest won't be
// found. The indexer was enabled in prod only minutes before this change
// so effectively no data exists yet; the migration cost is near-zero.
// Orphaned old-scheme records remain GDPR-deletable on uninstall via the
// `manifest.owner === ownerLogin` match in `index-delete.ts` (the delete
// path probes BOTH the new `<owner>/<repo>` and the old bare `<repo>` key
// shapes so no customer data is stranded).
export function indexNamespace(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`
}

const KV_KEY_PREFIX = "repo-index-manifest:"
// ARC-238 Codex v1 catch (TTL alignment): bumped 30d → 60d to match
// the sibling `repo-index-vectors:` TTL so an uninstall right after
// the prior 30d expiry can still find both records. The consumer-
// side freshness revalidation makes the TTL mostly a backstop, but
// alignment keeps the lifecycle bookkeeping simple.
const TTL_SECONDS = 60 * 24 * 60 * 60 // 60 days

// ---------------------------------------------------------------------
// Schema (v1)
// ---------------------------------------------------------------------

export interface RepoIndexManifestV1 {
  v: 1
  /**
   * Lowercased BARE repo name (not the namespace). The Vectorize
   * namespace this manifest gates is `indexNamespace(owner, repo)` =
   * `<owner>/<repo>`. Stored as the bare repo so the uninstall delete
   * path can reconstruct the namespace + KV keys from `owner` + `repo`.
   */
  repo: string
  /**
   * SIG-35: actual GitHub repo name for branch-scoped manifests whose `repo`
   * field stores a state identity such as `sigilix/__branch__/h646576`.
   * Default-branch manifests may omit this because `repo` already is the
   * GitHub repo.
   */
  actualRepo?: string
  /** Git branch indexed by this manifest. Omitted for the default branch. */
  branch?: string
  /** Repo default branch observed at index time. */
  defaultBranch?: string
  /** Vectorize namespace written by this index run. */
  namespace?: string
  /**
   * Owner at index time. SIG-132 made `<owner>/<repo>` the namespace, so
   * same-named repos under different owners no longer collide. Owner is
   * still stored: the freshness check uses it (`manifest.owner === owner`
   * guard in the consumer) and the uninstall delete path matches on it to
   * find + purge BOTH new (`<owner>/<repo>`) and orphaned old (`<repo>`)
   * pre-migration records.
   */
  owner: string
  /** Default-branch commit SHA at index time. */
  headSha: string
  /** Stable per-run id — sha256(owner|repo|headSha|modelId|chunkerVersion).slice(0,16). */
  runId: string
  /** Filtered indexable file count (after extension + skip-dirs + size). */
  fileCount: number
  /** Total chunks upserted to Vectorize. */
  chunkCount: number
  /** Number of shards used in the chain (1 for single-shard runs). */
  shardCount: number
  /** ISO-8601 timestamp when the final shard completed. */
  indexedAt: string
  /** Embedding model id. Mismatch → re-index. */
  modelId: string
  /** Embedding vector dimensions. Mismatch → re-index. */
  embeddingDim: number
  /** Chunker config version. Mismatch → re-index. */
  chunkerVersion: number
  /** Chunker window line count. Captured for forensics. */
  windowLines: number
  /** Chunker overlap line count. Captured for forensics. */
  overlapLines: number
}

export type ReadResult =
  | { kind: "ok"; manifest: RepoIndexManifestV1 }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "wrong-version" | "shape" | "json-parse" }

// ---------------------------------------------------------------------
// KV serdes
// ---------------------------------------------------------------------

export function repoIndexManifestKey(owner: string, repo: string): string {
  return `${KV_KEY_PREFIX}${indexNamespace(owner, repo)}`
}

/** The shared `repo-index-manifest:` prefix. Exported for KV-scan callers. */
export const REPO_INDEX_MANIFEST_PREFIX = KV_KEY_PREFIX

/**
 * SIG-132: the pre-migration bare-repo key shape
 * (`repo-index-manifest:<repo>`). The uninstall delete path probes this
 * so orphaned old-scheme records remain GDPR-deletable.
 */
export function legacyRepoIndexManifestKey(repo: string): string {
  return `${KV_KEY_PREFIX}${repo.toLowerCase()}`
}

function isRepoIndexManifestV1(value: unknown): value is RepoIndexManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.repo !== "string" || o.repo.length === 0) return false
  if (o.actualRepo !== undefined && (typeof o.actualRepo !== "string" || o.actualRepo.length === 0)) return false
  if (o.branch !== undefined && (typeof o.branch !== "string" || o.branch.length === 0)) return false
  if (o.defaultBranch !== undefined && (typeof o.defaultBranch !== "string" || o.defaultBranch.length === 0)) return false
  if (o.namespace !== undefined && (typeof o.namespace !== "string" || o.namespace.length === 0)) return false
  if (typeof o.owner !== "string" || o.owner.length === 0) return false
  if (typeof o.headSha !== "string" || o.headSha.length === 0) return false
  if (typeof o.runId !== "string" || o.runId.length === 0) return false
  if (typeof o.fileCount !== "number") return false
  if (typeof o.chunkCount !== "number") return false
  if (typeof o.shardCount !== "number") return false
  if (typeof o.indexedAt !== "string" || o.indexedAt.length === 0) return false
  if (typeof o.modelId !== "string" || o.modelId.length === 0) return false
  if (typeof o.embeddingDim !== "number") return false
  if (typeof o.chunkerVersion !== "number") return false
  if (typeof o.windowLines !== "number") return false
  if (typeof o.overlapLines !== "number") return false
  return true
}

/**
 * Read + validate the manifest. Tagged result so the consumer can
 * emit `repo-index-manifest-invalid` telemetry with the reason and
 * fall through to a fresh re-index when the stored shape is unusable.
 */
export async function readRepoIndexManifest(
  env: Env,
  owner: string,
  repo: string,
): Promise<ReadResult> {
  const raw = await env.OPENCLAW_STATE.get(repoIndexManifestKey(owner, repo))
  if (raw === null) return { kind: "missing" }
  return parseRepoIndexManifest(raw)
}

/**
 * Parse + validate a raw manifest JSON string into a tagged ReadResult.
 * Extracted so SIG-132's uninstall delete path can validate a record it
 * read from the LEGACY bare-repo key shape without re-implementing the
 * validation. Never returns `missing` (the caller already has the raw).
 */
export function parseRepoIndexManifest(raw: string): ReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid", reason: "json-parse" }
  }
  // Code-reviewer L1: differentiate "wrong shape" (array / primitive)
  // from "wrong version" (well-formed object with a non-1 `v` field).
  // Previously a JSON array hit the `.v !== 1` branch and reported as
  // "wrong-version" — misleading telemetry.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  if ((parsed as { v?: unknown }).v !== 1) {
    return { kind: "invalid", reason: "wrong-version" }
  }
  if (!isRepoIndexManifestV1(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  return { kind: "ok", manifest: parsed }
}

/**
 * Write the manifest. SIG-156 PR3: fail loudly on KV error — propagate the
 * throw so the consumer requeues the shard. Prior best-effort behavior left
 * vectors written but no manifest, which made the repo undiscoverable AND
 * skipped the push-webhook bootstrap path (which requires a prior manifest).
 * Retry is safe: bootstrap freshness-skips on the next attempt if everything
 * already landed, and vector chunk ids are content-addressed.
 */
export async function writeRepoIndexManifest(
  env: Env,
  manifest: RepoIndexManifestV1,
): Promise<void> {
  await env.OPENCLAW_STATE.put(
    repoIndexManifestKey(manifest.owner, manifest.repo),
    JSON.stringify(manifest),
    { expirationTtl: TTL_SECONDS },
  )
}

/**
 * Pure freshness check. Consumer calls this AFTER reading the manifest
 * to decide whether to skip (return early with `index-job-skip-fresh`)
 * or proceed with re-indexing.
 */
export function isManifestFresh(args: {
  manifest: RepoIndexManifestV1
  currentHeadSha: string
  currentOwner: string
  currentModelId: string
  currentEmbeddingDim: number
  currentChunkerVersion: number
}): boolean {
  const m = args.manifest
  return (
    m.headSha === args.currentHeadSha &&
    m.owner === args.currentOwner &&
    m.modelId === args.currentModelId &&
    m.embeddingDim === args.currentEmbeddingDim &&
    m.chunkerVersion === args.currentChunkerVersion
  )
}
