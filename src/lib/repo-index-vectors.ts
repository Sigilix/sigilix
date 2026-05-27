// ARC-238 — KV bookkeeping for the per-repo Vectorize chunk-id list.
//
// One record per indexed repo, keyed `repo-index-vectors:<owner>/<repo>`
// (lowercased — same convention as `repo-index-manifest:<owner>/<repo>`
// from ARC-235, moved to `<owner>/<repo>` by SIG-132 for multi-tenant
// isolation). Without this record, `installation.deleted` and
// `installation_repositories.removed` can't enumerate which IDs to
// `deleteByIds` — the only Vectorize delete primitive on the binding.
//
// Schema includes `owner` so the uninstall delete fan-out can
// double-check the same-named-repo cross-tenant case before calling
// `deleteByIds`. Codex v1 catch on the design pass: gating only the
// Vectorize delete on `manifest.owner === owner` was insufficient —
// the vectors-record delete had to be guarded too, AND that guard
// needs owner on the vectors record itself.
//
// Path-bucketed (`byPath: Record<string, string[]>`) so a future
// ARC-237 incremental delete (currently out of scope; PR 3 commit 1
// does full re-index on push) can target removed files by path.

import type { Env } from "../index"
import { indexNamespace } from "./repo-index-manifest"

const KV_KEY_PREFIX = "repo-index-vectors:"
const TTL_SECONDS = 60 * 24 * 60 * 60 // 60 days; aligned with manifest

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

export interface RepoIndexVectorsV1 {
  v: 1
  /**
   * Lowercased BARE repo name (not the namespace). The Vectorize
   * namespace is `indexNamespace(owner, repo)` = `<owner>/<repo>`. Stored
   * bare so the uninstall delete path can reconstruct keys from owner +
   * repo.
   */
  repo: string
  /**
   * Owner at index time. The uninstall delete fan-out compares this
   * against the removal context's owner and refuses to delete vectors
   * (and the KV manifest + vectors records) on mismatch, so a
   * same-named repo under a different owner doesn't get its data
   * smashed by an unrelated uninstall.
   */
  owner: string
  /**
   * SIG-243 Phase 2b: GitHub's immutable repository ID, mirroring the
   * field added to `RepoIndexManifestV1`. Optional during the Phase 1-2
   * transition; the indexer copies it from the manifest write so the
   * vectors record carries the same canonical identifier. Phase 4
   * promotes it to the canonical KV key (`repo-vectors:{id}`).
   */
  githubRepoId?: number
  /** Stable per-run id (matches `repo-index-manifest:<owner>/<repo>`'s runId). */
  runId: string
  /** Path → ordered list of chunk ids for that path. */
  byPath: Record<string, string[]>
}

export type ReadResult =
  | { kind: "ok"; vectors: RepoIndexVectorsV1 }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "wrong-version" | "shape" | "json-parse" }

// ---------------------------------------------------------------------
// KV serdes
// ---------------------------------------------------------------------

export function repoIndexVectorsKey(owner: string, repo: string): string {
  return `${KV_KEY_PREFIX}${indexNamespace(owner, repo)}`
}

/**
 * SIG-132: the pre-migration bare-repo key shape
 * (`repo-index-vectors:<repo>`). The uninstall delete path probes this so
 * orphaned old-scheme records remain GDPR-deletable.
 */
export function legacyRepoIndexVectorsKey(repo: string): string {
  return `${KV_KEY_PREFIX}${repo.toLowerCase()}`
}

/**
 * SIG-243 Phase 2b: canonical key for the new identity layer, keyed by
 * GitHub's immutable repository ID. Mirrors `repoTenantKey` in
 * repo-index-manifest. Phase 5 cleanup deletes the legacy
 * `repo-index-vectors:<owner>/<repo>` key after the safety window;
 * until then, the indexer dual-writes to both keys.
 */
export const REPO_VECTORS_TENANT_PREFIX = "repo-vectors:"
export function repoVectorsTenantKey(githubRepoId: number): string {
  return `${REPO_VECTORS_TENANT_PREFIX}${githubRepoId}`
}

function isRepoIndexVectorsV1(value: unknown): value is RepoIndexVectorsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.repo !== "string" || o.repo.length === 0) return false
  if (typeof o.owner !== "string" || o.owner.length === 0) return false
  if (o.githubRepoId !== undefined && (typeof o.githubRepoId !== "number" || !Number.isFinite(o.githubRepoId))) return false
  if (typeof o.runId !== "string" || o.runId.length === 0) return false
  if (!o.byPath || typeof o.byPath !== "object" || Array.isArray(o.byPath)) return false
  for (const [path, ids] of Object.entries(o.byPath as Record<string, unknown>)) {
    if (typeof path !== "string" || path.length === 0) return false
    if (!Array.isArray(ids)) return false
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) return false
    }
  }
  return true
}

export async function readRepoIndexVectors(
  env: Env,
  owner: string,
  repo: string,
): Promise<ReadResult> {
  const raw = await env.OPENCLAW_STATE.get(repoIndexVectorsKey(owner, repo))
  if (raw === null) return { kind: "missing" }
  return parseRepoIndexVectors(raw)
}

/**
 * Parse + validate a raw vectors JSON string. Extracted so SIG-132's
 * uninstall delete path can validate a record read from the LEGACY
 * bare-repo key shape. Never returns `missing`.
 */
export function parseRepoIndexVectors(raw: string): ReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid", reason: "json-parse" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  if ((parsed as { v?: unknown }).v !== 1) {
    return { kind: "invalid", reason: "wrong-version" }
  }
  if (!isRepoIndexVectorsV1(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  return { kind: "ok", vectors: parsed }
}

/**
 * Write the vectors record. Codex v1 B3: this is NOT best-effort —
 * the caller (indexer) must check the result and refuse to write a
 * fresh manifest if the vectors write failed. Otherwise the manifest
 * makes the repo look fully indexed while future uninstall can't
 * locate the vectors to delete (silent retention bug).
 *
 * SIG-243 Phase 2b: ALSO write to the new `repo-vectors:{id}` key
 * when TWO gates pass — DEFAULT-BRANCH state (the `repo` field
 * doesn't include the `/__branch__/` marker that branch-scoped state
 * repos use) AND `githubRepoId` is a positive integer. Branch-scoped
 * vectors stay legacy-only because the new key has no branch
 * differentiation; Phase 4 adds branch-aware keying. Positive-integer
 * guard mirrors `writeRepoIndexManifest` (rejects 0 / negative /
 * non-integer) so a spoofed payload can't land an invalid
 * `repo-vectors:0` key.
 *
 * The two writes are serial: legacy first, new second. If the new
 * write throws, the function returns false (same contract as before),
 * the caller refuses to write a fresh manifest, and the queue retries
 * the shard idempotently. The Vectorize embeddings themselves are
 * NOT duplicated; they continue to live under the legacy `<owner>/
 * <repo>` namespace (set in chunk metadata at upsert time). Phase 4
 * adds the namespace-by-repo_id read path; Phase 5 cleanup deletes
 * the legacy KV key.
 */
export async function writeRepoIndexVectors(
  env: Env,
  vectors: RepoIndexVectorsV1,
): Promise<boolean> {
  try {
    await env.OPENCLAW_STATE.put(
      repoIndexVectorsKey(vectors.owner, vectors.repo),
      JSON.stringify(vectors),
      { expirationTtl: TTL_SECONDS },
    )
    const isDefaultBranchState = !vectors.repo.includes("/__branch__/")
    if (
      isDefaultBranchState &&
      typeof vectors.githubRepoId === "number" &&
      Number.isInteger(vectors.githubRepoId) &&
      vectors.githubRepoId > 0
    ) {
      await env.OPENCLAW_STATE.put(
        repoVectorsTenantKey(vectors.githubRepoId),
        JSON.stringify(vectors),
        { expirationTtl: TTL_SECONDS },
      )
      console.log(JSON.stringify({
        event: "dual-write-succeeded-vectors",
        key_legacy: repoIndexVectorsKey(vectors.owner, vectors.repo),
        key_new: repoVectorsTenantKey(vectors.githubRepoId),
        github_repo_id: vectors.githubRepoId,
      }))
    }
    return true
  } catch {
    return false
  }
}

export async function deleteRepoIndexVectors(
  env: Env,
  owner: string,
  repo: string,
): Promise<void> {
  await env.OPENCLAW_STATE.delete(repoIndexVectorsKey(owner, repo))
}

/**
 * SIG-137: append chunk ids to the delete-coverage ledger BEFORE the
 * corresponding vectors are upserted to Vectorize. The ledger is a monotonic
 * UNION (it only grows) and is lease-AGNOSTIC — its sole job is delete
 * completeness, so a run that gets superseded mid-slice still has its
 * already-upserted ids recorded and therefore deletable by the GDPR uninstall
 * path. The separate lease-gated `computeMerge`/`persistVectorIds` path still
 * owns the "may this run write the manifest / enqueue the next shard" decision.
 *
 * Preserves the existing record's runId/owner (coverage doesn't claim
 * ownership); creates the record with `runId` when none exists. Throws on KV
 * write failure so the caller aborts BEFORE the Vectorize upsert — guaranteeing
 * no vector is ever written without its id already in the ledger.
 *
 * MVP caveat: a single KV key read-union-write is not atomic across concurrent
 * runs (last-writer-wins), so a narrow concurrent-write race can still strand a
 * few ids. Accepted for v1; per-batch append-only keys or a DO serializer would
 * close it (tracked follow-up).
 */
export async function appendVectorCoverage(
  env: Env,
  owner: string,
  repo: string,
  runId: string,
  byPathSlice: Record<string, string[]>,
): Promise<void> {
  const slice = normalizeByPath(byPathSlice)
  if (Object.keys(slice).length === 0) return

  const existing = await readRepoIndexVectors(env, owner, repo)
  if (existing.kind === "invalid") {
    // Fail closed: a corrupt ledger may already hold earlier batches' ids.
    // Recreating it from only this slice would silently drop that coverage and
    // reintroduce the orphan gap. Throw so the indexer aborts BEFORE upserting
    // and the queue retries — mirrors persistVectorIds' mid-chain corruption
    // handling.
    throw new Error(`repo-index-vectors coverage write failed for ${repo}: existing record invalid (${existing.reason})`)
  }
  const record: RepoIndexVectorsV1 =
    existing.kind === "ok"
      ? { ...existing.vectors, byPath: setUnion(existing.vectors.byPath, slice) }
      : { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: slice }

  const ok = await writeRepoIndexVectors(env, record)
  if (!ok) {
    throw new Error(`repo-index-vectors coverage write failed for ${repo}`)
  }
}

// ---------------------------------------------------------------------
// Run-aware merge
// ---------------------------------------------------------------------

export type MergeOutcome =
  | { action: "created"; vectors: RepoIndexVectorsV1 }
  | { action: "extended"; vectors: RepoIndexVectorsV1 }
  | { action: "superseded"; vectors: RepoIndexVectorsV1 }
  | { action: "stale-skip"; existingRunId: string }
  | { action: "invalid-overwrite"; vectors: RepoIndexVectorsV1 }

export interface MergeArgs {
  existing: ReadResult
  owner: string
  repo: string
  /**
   * SIG-243 Phase 2b: immutable GitHub repo ID copied from the queue
   * message / manifest. Threaded through the merge so the resulting
   * `RepoIndexVectorsV1` carries the canonical ID and the writer
   * dual-writes to the new `repo-vectors:{id}` key. Optional during
   * the Phase 1+2 transition; absent on legacy in-flight shard runs.
   */
  githubRepoId: number | undefined
  runId: string
  idsByPathSlice: Record<string, string[]>
  /**
   * SIG-136: the current run-lease holder's runId (from `readActiveRunId`),
   * or null. Authoritative tiebreaker: a lease owned by a DIFFERENT run means
   * this slice is from a superseded/redelivered run and must be rejected.
   */
  activeRunId: string | null
}

/**
 * Pure merge logic. Returns the new `RepoIndexVectorsV1` to write (or
 * a stale-skip signal). Single-writer continuation chain semantics
 * within one run, plus a tie-breaker against stale-run shards that
 * arrive after the chain has been superseded.
 *
 * Decision table (SIG-136: lease is the tiebreaker, checked FIRST):
 *   - lease held by a DIFFERENT run                 → stale-skip
 *     (gates create/overwrite; a superseded/redelivered
 *     run can't clobber a newer run's data)
 *   - existing missing                              → create
 *   - existing ok, runId matches incoming           → set-union (extend)
 *   - existing ok, runId differs, lease is the
 *     incoming run                                  → supersede (overwrite)
 *   - existing ok, runId differs, no lease          → stale-skip
 *   - existing invalid                              → overwrite
 *     (treat as corrupt; we have to write something
 *     so future deletes have an id list to walk)
 */
export function computeMerge(args: MergeArgs): MergeOutcome {
  const { existing, owner, repo, githubRepoId, runId, idsByPathSlice, activeRunId } = args
  const sliceByPath = normalizeByPath(idsByPathSlice)
  // SIG-243 Phase 2b: build the optional repo-ID spread once so every
  // branch below carries the field consistently under
  // exactOptionalPropertyTypes.
  const repoIdSpread: { githubRepoId?: number } =
    typeof githubRepoId === "number" && Number.isFinite(githubRepoId)
      ? { githubRepoId }
      : {}

  // SIG-136: a lease owned by a DIFFERENT run supersedes this slice — reject
  // BEFORE create/overwrite so a stale run can't clobber a newer run's data.
  if (activeRunId !== null && activeRunId !== runId) {
    return { action: "stale-skip", existingRunId: existing.kind === "ok" ? existing.vectors.runId : "" }
  }

  if (existing.kind === "missing") {
    return {
      action: "created",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), ...repoIdSpread, runId, byPath: sliceByPath },
    }
  }
  if (existing.kind === "invalid") {
    return {
      action: "invalid-overwrite",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), ...repoIdSpread, runId, byPath: sliceByPath },
    }
  }

  // existing.kind === "ok"
  const cur = existing.vectors
  if (cur.runId === runId) {
    // Same run — continuation shard extending the existing record.
    return {
      action: "extended",
      vectors: {
        v: 1,
        owner,
        repo: repo.toLowerCase(),
        ...repoIdSpread,
        runId,
        byPath: setUnion(cur.byPath, sliceByPath),
      },
    }
  }

  // Different stored run; this run holds the lease (mismatch already
  // rejected) ⇒ authoritative ⇒ supersede. SIG-137: UNION the stored run's
  // ids rather than overwriting — the id-list is a delete-coverage ledger, so
  // the superseded run's already-upserted Vectorize entries must stay
  // deletable (otherwise they orphan and escape the GDPR uninstall delete).
  if (activeRunId === runId) {
    return {
      action: "superseded",
      vectors: {
        v: 1, owner, repo: repo.toLowerCase(), ...repoIdSpread, runId,
        byPath: setUnion(cur.byPath, sliceByPath),
      },
    }
  }
  // No lease names either run (activeRunId === null) and the stored run
  // differs → don't overwrite.
  return { action: "stale-skip", existingRunId: cur.runId }
}

function normalizeByPath(input: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [path, ids] of Object.entries(input)) {
    if (ids.length === 0) continue
    // Dedupe + preserve insertion order. Same chunk written twice in
    // one slice is rare (would mean two identical chunkIds) but the
    // dedupe is cheap.
    out[path] = Array.from(new Set(ids))
  }
  return out
}

function setUnion(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [path, ids] of Object.entries(a)) {
    out[path] = [...ids]
  }
  for (const [path, ids] of Object.entries(b)) {
    if (out[path]) {
      const merged = new Set(out[path])
      for (const id of ids) merged.add(id)
      out[path] = Array.from(merged)
    } else {
      out[path] = [...ids]
    }
  }
  return out
}

/**
 * Flatten a vectors record's `byPath` to a deduped array of chunk
 * ids. Used by `deleteRepoIndex` to call `deleteByIds` in batches of
 * up to 1000 (Cloudflare's documented Vectorize delete batch limit).
 */
export function flattenIds(vectors: RepoIndexVectorsV1): string[] {
  const set = new Set<string>()
  for (const ids of Object.values(vectors.byPath)) {
    for (const id of ids) set.add(id)
  }
  return Array.from(set)
}
