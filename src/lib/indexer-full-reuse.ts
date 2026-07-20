// SIG-604: full-index skip-unchanged reuse — decide, for a full (re)index,
// which files may reuse the prior run's content-addressed vectors instead of
// re-embedding. Extracted from indexer.ts (file-size budget).

import type { Env } from "@/src/shared/types/env"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import { effectiveChunkerVersion } from "@/src/lib/indexer-internals"
import { isManifestEmbedCompatible, readRepoIndexManifest } from "./repo-index-manifest"

/**
 * Dark flag for full-index skip-unchanged reuse. "on" enables the content-id
 * reuse in processSlice; anything else (default/unset) keeps the pre-SIG-604
 * behavior of embedding every file on a full (re)index. Narrow-typed via a cast
 * because the var is SIGILIX-native and NOT declared on `Env` (that interface is
 * at its file-size budget); normalizeEnv mirrors the OPENCLAW_ alias so either
 * name resolves at runtime.
 */
export function indexFullReuseEnabled(env: Env): boolean {
  const flags = env as unknown as { SIGILIX_INDEX_FULL_REUSE?: string; OPENCLAW_INDEX_FULL_REUSE?: string }
  const v = (flags.SIGILIX_INDEX_FULL_REUSE ?? flags.OPENCLAW_INDEX_FULL_REUSE ?? "").trim().toLowerCase()
  return v === "on"
}

/**
 * Build the reuse map (prior run's chunk ids by path) for a full (re)index of
 * `stateRepo`, or `undefined` when reuse must not fire. Two safety conditions:
 *   1. The prior manifest is EMBED-COMPATIBLE (same owner + model + embeddingDim
 *      + chunker/citation) — otherwise a model/chunker bump would keep stale
 *      vectors.
 *   2. The ids come from the manifest's MATERIALIZED active-index snapshot
 *      (`activeIndex.byPath`), NOT the delete-coverage ledger. The ledger is a
 *      write-ahead SUPERSET of live vectors (recorded BEFORE the Vectorize
 *      upsert for crash-safe GDPR delete), so an id can be in the ledger whose
 *      vector was never durably written — reusing from it could skip healing a
 *      missing vector. The active-index snapshot only holds ids that were staged
 *      AFTER a durable upsert of a completed run, so "id present" == "vector
 *      live". When there is no active index (non-default branch / active-index
 *      off), reuse simply doesn't fire (fail toward a full embed). (SIG-604
 *      code-review C1 + M1.)
 * Fail-soft: any read error, missing/incompatible manifest, or absent active
 * index returns `undefined` → a full embed (the pre-SIG-604 behavior). A partial
 * active index only reuses the paths it contains — unlisted paths embed. Never
 * throws.
 */
export async function loadReuseIdsByPath(input: {
  env: Env
  owner: string
  stateRepo: string
  astOn: boolean
}): Promise<Readonly<Record<string, string[]>> | undefined> {
  const { env, owner, stateRepo, astOn } = input
  if (!indexFullReuseEnabled(env)) return undefined
  try {
    const manifest = await readRepoIndexManifest(env, owner, stateRepo)
    if (manifest.kind !== "ok") return undefined
    const compatible = isManifestEmbedCompatible({
      manifest: manifest.manifest,
      currentOwner: owner,
      currentModelId: EMBEDDING_MODEL,
      currentEmbeddingDim: EMBEDDING_DIMENSIONS,
      currentChunkerVersion: effectiveChunkerVersion(astOn),
      currentCitationChunkVersion: CITATION_CHUNK_VERSION,
    })
    if (!compatible) return undefined
    // Source from the MATERIALIZED active index, not the write-ahead ledger.
    return manifest.manifest.activeIndex?.byPath
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-full-reuse-load-failed",
        owner,
        repo: stateRepo,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return undefined
  }
}
