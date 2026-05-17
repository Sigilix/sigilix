// ARC-235 — KV manifest for the customer-ready indexing pipeline.
//
// One record per indexed repo, keyed `repo-index-manifest:<repo>`
// (lowercased — matching the Vectorize namespace contract used at
// retrieval time in `src/lib/retrieval.ts` and the agent loop's
// `retrieve_codebase` tool).
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

const KV_KEY_PREFIX = "repo-index-manifest:"
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

// ---------------------------------------------------------------------
// Schema (v1)
// ---------------------------------------------------------------------

export interface RepoIndexManifestV1 {
  v: 1
  /** Lowercased repo name — the Vectorize namespace this manifest gates. */
  repo: string
  /**
   * Owner at index time. Two installs of differently-owned repos with
   * the same name will share a Vectorize namespace + manifest under
   * today's contract; storing owner here lets the freshness check
   * detect that case and re-index (the `manifest.owner === owner`
   * guard in the consumer). A real fix is a future namespace migration
   * to `<owner>/<repo>` across retrieval, prompts, and allowlists.
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

export function repoIndexManifestKey(repo: string): string {
  return `${KV_KEY_PREFIX}${repo.toLowerCase()}`
}

function isRepoIndexManifestV1(value: unknown): value is RepoIndexManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.repo !== "string" || o.repo.length === 0) return false
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
  repo: string,
): Promise<ReadResult> {
  const raw = await env.OPENCLAW_STATE.get(repoIndexManifestKey(repo))
  if (raw === null) return { kind: "missing" }
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
 * Write the manifest. Best-effort: returns false on write error so the
 * consumer can log without failing the whole indexing run (the
 * Vectorize upserts are the user-facing artifact; missing the manifest
 * just means the next webhook will re-walk + re-upsert idempotently).
 */
export async function writeRepoIndexManifest(
  env: Env,
  manifest: RepoIndexManifestV1,
): Promise<boolean> {
  try {
    await env.OPENCLAW_STATE.put(
      repoIndexManifestKey(manifest.repo),
      JSON.stringify(manifest),
      { expirationTtl: TTL_SECONDS },
    )
    return true
  } catch {
    return false
  }
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
