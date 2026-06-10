// SIG-376 (SIG-318 Tier-1 1/8): the per-(owner, repo) state-resolution +
// legacy-orphan-purge IO cluster lifted out of `index-delete.ts` so that
// god-file stays under the 1,000-line budget. These helpers are pure
// relocations — bodies are byte-identical to their prior in-file
// definitions; only the surrounding `export` keywords (so the core can
// import them) differ.
//
// The shared result/arg types and the Vectorize batch constant live here
// too (the resolution helpers and the core both reference them); the core
// re-exports the public types so every existing importer of
// `@/lib/index-delete` is unchanged.
//
// Leaf module: depends only on the repo-index-manifest / repo-index-vectors
// readers — it does NOT import the core `index-delete.ts`, so there is no
// cycle.

import type { Env } from "../shared/types/env"
import {
  legacyRepoIndexManifestKey,
  parseRepoIndexManifest,
  readRepoIndexManifest,
  repoIndexManifestKey,
  type ReadResult as ManifestReadResult,
} from "./repo-index-manifest"
import {
  flattenIds,
  legacyRepoIndexVectorsKey,
  parseRepoIndexVectors,
  readRepoIndexVectors,
  repoIndexVectorsKey,
  type ReadResult as VectorsReadResult,
} from "./repo-index-vectors"

// Vectorize `deleteByIds` caps at 100 ids per call — above that the API
// throws VECTOR_DELETE_ERROR 40007 ("too many ids in payload; max id count
// is 100"), which was silently failing every branch-index cleanup whose
// id-list exceeded 100. Batch at the documented limit.
export const VECTORIZE_DELETE_BATCH = 100

export type DeleteReason =
  | "install-deleted"
  | "install-repos-removed"
  | "branch-deleted"
  | "pr-branch-closed"

export interface DeleteResult {
  /** Summary status — drives the webhook HTTP response. */
  status: "complete" | "partial" | "owner-mismatch-skip" | "no-state"
  /** Vector ids actually deleted (0 if no vectors record or owner mismatch). */
  vectorIds: number
  /** Per-PR review manifests deleted. */
  prReviewManifests: number
  /** Per-(PR, headSha) dedupe locks deleted. */
  prReviewDedupeKeys: number
  /** Whether the repo-index-manifest:* KV record was deleted (new or legacy key). */
  manifestDeleted: boolean
  /** Whether the repo-index-vectors:* KV record was deleted (new or legacy key). */
  vectorsKvDeleted: boolean
  /**
   * SIG-247 Phase 1 PR B: count of review-memory:* keys deleted across
   * BOTH the legacy `<owner>/<repo>` keyspace and the new `repo:<id>`
   * keyspace. Both prefixes are owner-qualified (legacy by string,
   * new by immutable id) — safe to delete unguarded by the owner
   * probe that protects shared repo-only state.
   */
  reviewMemoryKeys: number
  /**
   * SIG-45: count of lexical (D1 FTS5) rows deleted for the repo's
   * namespace. 0 when the OPENCLAW_LEXICAL_INDEX binding is absent (hybrid
   * never provisioned) — the lexical purge is GDPR cleanup that runs
   * unguarded for the requested owner/repo, same as the graph delete.
   */
  lexicalRows: number
  /** Non-fatal errors (per-step) that should make the webhook return 5xx. */
  errors: string[]
}

export interface DeleteRepoIndexArgs {
  env: Env
  owner: string
  repo: string
  reason: DeleteReason
}

/**
 * SIG-132: read the manifest, probing the new `<owner>/<repo>` key first
 * and falling back to the legacy bare `<repo>` key. Returns the read
 * result, the ACTUAL key name the record was found under (null when
 * neither shape exists), and — when the NEW key was the one found — an
 * `extraOwnerSafeKey` pointing at a same-owner legacy orphan that should
 * ALSO be purged. This covers the (narrow) case where a repo was indexed
 * both pre- and post-migration: both key shapes coexist for the same
 * owner and BOTH must be deleted so no customer data is stranded.
 */
export async function resolveManifest(
  env: Env,
  owner: string,
  repo: string,
): Promise<{
  read: ManifestReadResult
  keyName: string | null
  extraOwnerSafeKey: string | null
}> {
  const newKey = repoIndexManifestKey(owner, repo)
  const legacyKey = legacyRepoIndexManifestKey(repo)
  const newRead = await readRepoIndexManifest(env, owner, repo)
  if (newRead.kind !== "missing") {
    // New record found. Probe the legacy key for a same-owner orphan to
    // sweep alongside it (different-owner orphans are someone else's).
    const extra = newKey !== legacyKey
      ? await probeLegacyManifestOrphanKey(env, legacyKey, owner)
      : null
    return { read: newRead, keyName: newKey, extraOwnerSafeKey: extra }
  }
  if (legacyKey === newKey) {
    // Defensive: only equal if owner were empty; nothing more to probe.
    return { read: newRead, keyName: null, extraOwnerSafeKey: null }
  }
  const legacyRaw = await env.OPENCLAW_STATE.get(legacyKey)
  if (legacyRaw === null) {
    return { read: { kind: "missing" }, keyName: null, extraOwnerSafeKey: null }
  }
  return {
    read: parseRepoIndexManifest(legacyRaw),
    keyName: legacyKey,
    extraOwnerSafeKey: null,
  }
}

/**
 * SIG-132: vectors-record equivalent of `resolveManifest`. Probes new
 * key then legacy bare-repo key, and reports a same-owner legacy orphan
 * to sweep when the new key was the one found.
 */
export async function resolveVectors(
  env: Env,
  owner: string,
  repo: string,
): Promise<{
  read: VectorsReadResult
  keyName: string | null
  extraOwnerSafeKey: string | null
}> {
  const newKey = repoIndexVectorsKey(owner, repo)
  const legacyKey = legacyRepoIndexVectorsKey(repo)
  const newRead = await readRepoIndexVectors(env, owner, repo)
  if (newRead.kind !== "missing") {
    const extra = newKey !== legacyKey
      ? await probeLegacyVectorsOrphanKey(env, legacyKey, owner)
      : null
    return { read: newRead, keyName: newKey, extraOwnerSafeKey: extra }
  }
  if (legacyKey === newKey) {
    return { read: newRead, keyName: null, extraOwnerSafeKey: null }
  }
  const legacyRaw = await env.OPENCLAW_STATE.get(legacyKey)
  if (legacyRaw === null) {
    return { read: { kind: "missing" }, keyName: null, extraOwnerSafeKey: null }
  }
  return {
    read: parseRepoIndexVectors(legacyRaw),
    keyName: legacyKey,
    extraOwnerSafeKey: null,
  }
}

/**
 * Return `legacyKey` IFF a manifest record exists there AND its owner
 * matches `owner`. Used to opportunistically sweep a same-owner legacy
 * orphan that coexists with a new-shape record. A record owned by a
 * DIFFERENT tenant (or an unparseable one) is left untouched.
 */
async function probeLegacyManifestOrphanKey(
  env: Env,
  legacyKey: string,
  owner: string,
): Promise<string | null> {
  const raw = await env.OPENCLAW_STATE.get(legacyKey)
  if (raw === null) return null
  const parsed = parseRepoIndexManifest(raw)
  if (parsed.kind !== "ok") return null
  return parsed.manifest.owner === owner ? legacyKey : null
}

/** Vectors-record equivalent of `probeLegacyManifestOrphanKey`. */
async function probeLegacyVectorsOrphanKey(
  env: Env,
  legacyKey: string,
  owner: string,
): Promise<string | null> {
  const raw = await env.OPENCLAW_STATE.get(legacyKey)
  if (raw === null) return null
  const parsed = parseRepoIndexVectors(raw)
  if (parsed.kind !== "ok") return null
  return parsed.vectors.owner === owner ? legacyKey : null
}

/**
 * SIG-132: deleteByIds the embeddings of a same-owner legacy vectors
 * orphan (ids are content-addressed under the OLD namespace, so they
 * differ from the new record's), then delete its KV key. Errors are
 * captured in `result.errors` to drive the webhook 503; the KV key is
 * kept on Vectorize-delete failure so redelivery can retry.
 */
export async function purgeLegacyVectorsOrphan(
  env: Env,
  legacyKey: string,
  owner: string,
  repo: string,
  result: DeleteResult,
): Promise<void> {
  const raw = await env.OPENCLAW_STATE.get(legacyKey)
  if (raw === null) return
  const parsed = parseRepoIndexVectors(raw)
  if (parsed.kind !== "ok") {
    // Unparseable orphan — just drop the key.
    try {
      await env.OPENCLAW_STATE.delete(legacyKey)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`kv.delete(legacy-vectors-orphan): ${message}`)
    }
    return
  }
  let vectorizeFailed = false
  const uniq = Array.from(new Set(flattenIds(parsed.vectors)))
  for (let i = 0; i < uniq.length; i += VECTORIZE_DELETE_BATCH) {
    const batch = uniq.slice(i, i + VECTORIZE_DELETE_BATCH)
    try {
      await env.OPENCLAW_CODE_INDEX.deleteByIds(batch)
      result.vectorIds += batch.length
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`vectorize.deleteByIds(legacy-orphan): ${message}`)
      vectorizeFailed = true
      console.error(JSON.stringify({
        event: "index-delete-legacy-orphan-vectorize-failed",
        owner, repo, batch_start: i, batch_size: batch.length, err: message,
      }))
    }
  }
  if (vectorizeFailed) return // keep the KV id-list for redelivery retry
  try {
    await env.OPENCLAW_STATE.delete(legacyKey)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors.push(`kv.delete(legacy-vectors-orphan): ${message}`)
  }
}
