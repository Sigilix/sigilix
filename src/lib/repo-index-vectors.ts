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

function isRepoIndexVectorsV1(value: unknown): value is RepoIndexVectorsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.repo !== "string" || o.repo.length === 0) return false
  if (typeof o.owner !== "string" || o.owner.length === 0) return false
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
  const { existing, owner, repo, runId, idsByPathSlice, activeRunId } = args
  const sliceByPath = normalizeByPath(idsByPathSlice)

  // SIG-136: a lease owned by a DIFFERENT run supersedes this slice — reject
  // BEFORE create/overwrite so a stale run can't clobber a newer run's data.
  if (activeRunId !== null && activeRunId !== runId) {
    return { action: "stale-skip", existingRunId: existing.kind === "ok" ? existing.vectors.runId : "" }
  }

  if (existing.kind === "missing") {
    return {
      action: "created",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath },
    }
  }
  if (existing.kind === "invalid") {
    return {
      action: "invalid-overwrite",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath },
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
        runId,
        byPath: setUnion(cur.byPath, sliceByPath),
      },
    }
  }

  // Different stored run; this run holds the lease (mismatch already
  // rejected) ⇒ authoritative ⇒ supersede.
  if (activeRunId === runId) {
    return {
      action: "superseded",
      vectors: { v: 1, owner, repo: repo.toLowerCase(), runId, byPath: sliceByPath },
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
