// SIG-419: operator-triggered purge of stale index records.
//
// Two classes of record are now dead weight and only cost Vectorize storage +
// KV:
//   - BRANCH OVERLAYS (`<owner>/<repo>/__branch__/<hash>`) — SIG-413 gated
//     per-PR branch full-indexing OFF (review retrieval leans on the SIG-129
//     branch-aware overlay + the default-branch index), so the persisted
//     per-branch indexes are never read again.
//   - DEAD-ORG records — every record under an owner that no longer exists
//     (e.g. the pre-rename `arc-and-anchor` org → now `Sigilix`).
//
// We reuse the vetted `deleteRepoIndex(owner, repo)` per (owner, repo) tuple:
// it deletes Vectorize embeddings BEFORE the KV records (so nothing strands),
// carries the cross-tenant owner guard, cleans the graph DO (a CLI sweep
// can't), and — for a branch overlay — SKIPS the default-branch tenant keys, so
// the live default-branch index is preserved.
//
// Why this shape (not a CLI `wrangler kv` sweep):
//   1. The Vectorize chunk-ids live INSIDE each `repo-index-vectors` record's
//      `byPath`; deleting the KV record first would strand the embeddings with
//      no id-list left to delete them by. `deleteRepoIndex` orders it correctly.
//   2. Enumeration classifies from the KEY NAME (no GET) — `/__branch__/` for
//      overlays, the first path-segment for dead-org — so a full scan is a
//      couple of `list` calls, not 600+ GETs.
//   3. `deleteRepoIndex`'s cross-tenant guard compares the record body's owner
//      with `!==`, so we must hand it the body's ORIGINAL-CASE owner. The KEY is
//      lowercased, so for each tuple we actually delete we GET one body to read
//      the real owner/repo. That GET is bounded by `maxDeletesPerCall`.
//   4. Each `deleteRepoIndex` fans out to ~12-16 subrequests; ~350 tuples would
//      blow the Worker's 1000-subrequest cap. So a call processes a BOUNDED,
//      idempotent batch and reports `remaining`; the operator loops until 0.
//   5. We scan BOTH the manifest and vectors keyspaces and dedupe by namespace
//      — a partial prior delete can leave an orphan vectors record whose
//      manifest is already gone, which a manifest-only scan would miss.

import type { Env } from "@/src/shared/types/env"
import { deleteRepoIndex } from "./index-delete"
import { parseRepoIndexManifest, REPO_INDEX_MANIFEST_PREFIX } from "./repo-index-manifest"
import { parseRepoIndexVectors, REPO_INDEX_VECTORS_PREFIX } from "./repo-index-vectors"

const KV_LIST_PAGE_LIMIT = 1000

/** Conservative per-call delete cap. Each `deleteRepoIndex` fans out to ~12-16
 *  subrequests; 40 keeps the worst case well under the 1000 subrequest limit
 *  with headroom for the scan's `list` calls. The route clamps an override. */
export const DEFAULT_MAX_DELETES_PER_CALL = 40

export interface StaleIndexPurgeSummary {
  dryRun: boolean
  /** Owners (lowercased) treated as dead-org — ALL their records are purged. */
  deadOrgs: string[]
  scannedManifestKeys: number
  scannedVectorKeys: number
  /** Unique namespaces matched as branch overlays (`/__branch__/`). */
  branchOverlayTuples: number
  /** Unique namespaces matched as dead-org default-branch records (no overlay). */
  deadOrgTuples: number
  /** branchOverlayTuples + deadOrgTuples — the full work set at scan time. */
  totalCandidateTuples: number
  /** Grouped by base repo (`owner/repo`, overlay hash stripped) for verification. */
  byBaseRepo: Record<string, { branchOverlay: number; deadOrg: number }>
  /** Tuples attempted this call (≤ maxDeletesPerCall). 0 on a dry run. */
  processed: number
  /** Tuples whose delete returned a non-error status this call. */
  deleted: number
  /** Vector embeddings deleted this call (summed `DeleteResult.vectorIds`). */
  vectorIdsDeleted: number
  /** totalCandidateTuples − deleted. Re-scan is authoritative; loop until 0. */
  remaining: number
  /** Bounded list of per-tuple delete errors (partial deletes). */
  deleteErrors: string[]
  /** A `list` page errored or returned no cursor — coverage may be partial. */
  enumerationIncomplete: boolean
}

interface Candidate {
  manifestKey?: string
  vectorsKey?: string
  isBranch: boolean
  isDeadOrg: boolean
}

/** Strip the overlay segment so overlays group under their base repo. */
function baseRepoOf(ns: string): string {
  const i = ns.indexOf("/__branch__/")
  return i === -1 ? ns : ns.slice(0, i)
}

/**
 * Classify a KV key by NAME alone (no GET). Returns the namespace + flags, or
 * `null` when the record is neither a branch overlay nor a dead-org record (a
 * live default-branch index — must be preserved).
 */
function classifyKey(
  keyName: string,
  prefix: string,
  deadOrgs: Set<string>,
): { ns: string; isBranch: boolean; isDeadOrg: boolean } | null {
  const ns = keyName.slice(prefix.length)
  if (ns.length === 0) return null
  const isBranch = ns.includes("/__branch__/")
  const owner = ns.slice(0, ns.indexOf("/") === -1 ? ns.length : ns.indexOf("/"))
  const isDeadOrg = deadOrgs.has(owner.toLowerCase())
  if (!isBranch && !isDeadOrg) return null
  return { ns, isBranch, isDeadOrg }
}

/**
 * Paginate a KV `list({prefix})` and invoke `onKey` per key name. Returns
 * `incomplete` when a page errored or an incomplete page had no cursor (so the
 * caller surfaces partial coverage rather than reporting a falsely-complete
 * scan). List returns key NAMES only — no value reads here.
 */
async function scanPrefix(env: Env, prefix: string, onKey: (name: string) => void): Promise<{ incomplete: boolean }> {
  let cursor: string | undefined
  for (;;) {
    let page: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    try {
      page = (await env.OPENCLAW_STATE.list({
        prefix,
        limit: KV_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      })) as { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "stale-index-purge-list-failed",
          prefix,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      return { incomplete: true }
    }
    for (const key of page.keys) onKey(key.name)
    if (page.list_complete) return { incomplete: false }
    if (!page.cursor) {
      console.error(JSON.stringify({ event: "stale-index-purge-list-no-cursor", prefix }))
      return { incomplete: true }
    }
    cursor = page.cursor
  }
}

/**
 * Enumerate stale index records across BOTH keyspaces, dedupe by namespace, and
 * (unless `dryRun`) delete a bounded batch via `deleteRepoIndex`. Idempotent:
 * re-running drains the remainder, so the operator loops until `remaining === 0`.
 */
export async function runStaleIndexPurge(
  env: Env,
  opts: { dryRun: boolean; deadOrgs: string[]; maxDeletesPerCall?: number },
): Promise<StaleIndexPurgeSummary> {
  const deadOrgs = new Set(opts.deadOrgs.map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0))
  const max =
    opts.maxDeletesPerCall && opts.maxDeletesPerCall > 0 ? opts.maxDeletesPerCall : DEFAULT_MAX_DELETES_PER_CALL

  const candidates = new Map<string, Candidate>()
  let scannedManifestKeys = 0
  let scannedVectorKeys = 0
  let enumerationIncomplete = false

  const record = (
    ns: string,
    isBranch: boolean,
    isDeadOrg: boolean,
    which: "manifest" | "vectors",
    keyName: string,
  ): void => {
    const existing = candidates.get(ns) ?? { isBranch: false, isDeadOrg: false }
    existing.isBranch = existing.isBranch || isBranch
    existing.isDeadOrg = existing.isDeadOrg || isDeadOrg
    if (which === "manifest") existing.manifestKey = keyName
    else existing.vectorsKey = keyName
    candidates.set(ns, existing)
  }

  const m = await scanPrefix(env, REPO_INDEX_MANIFEST_PREFIX, (name) => {
    scannedManifestKeys += 1
    const c = classifyKey(name, REPO_INDEX_MANIFEST_PREFIX, deadOrgs)
    if (c) record(c.ns, c.isBranch, c.isDeadOrg, "manifest", name)
  })
  if (m.incomplete) enumerationIncomplete = true

  const v = await scanPrefix(env, REPO_INDEX_VECTORS_PREFIX, (name) => {
    scannedVectorKeys += 1
    const c = classifyKey(name, REPO_INDEX_VECTORS_PREFIX, deadOrgs)
    if (c) record(c.ns, c.isBranch, c.isDeadOrg, "vectors", name)
  })
  if (v.incomplete) enumerationIncomplete = true

  // Tally + group.
  const byBaseRepo: Record<string, { branchOverlay: number; deadOrg: number }> = {}
  let branchOverlayTuples = 0
  let deadOrgTuples = 0
  for (const [ns, c] of candidates) {
    const base = baseRepoOf(ns)
    const bucket = (byBaseRepo[base] ??= { branchOverlay: 0, deadOrg: 0 })
    if (c.isBranch) {
      branchOverlayTuples += 1
      bucket.branchOverlay += 1
    } else {
      // isDeadOrg && !isBranch (classifyKey guarantees one flag is set).
      deadOrgTuples += 1
      bucket.deadOrg += 1
    }
  }
  const totalCandidateTuples = candidates.size

  const summary: StaleIndexPurgeSummary = {
    dryRun: opts.dryRun,
    deadOrgs: [...deadOrgs],
    scannedManifestKeys,
    scannedVectorKeys,
    branchOverlayTuples,
    deadOrgTuples,
    totalCandidateTuples,
    byBaseRepo,
    processed: 0,
    deleted: 0,
    vectorIdsDeleted: 0,
    remaining: totalCandidateTuples,
    deleteErrors: [],
    enumerationIncomplete,
  }

  console.log(
    JSON.stringify({
      event: "stale-index-purge-scan",
      dry_run: opts.dryRun,
      dead_orgs: summary.deadOrgs,
      branch_overlay_tuples: branchOverlayTuples,
      dead_org_tuples: deadOrgTuples,
      total: totalCandidateTuples,
    }),
  )

  if (opts.dryRun) return summary

  // Live: delete a bounded, idempotent batch. Insertion order (manifest scan
  // then vectors-only) is stable across re-runs because KV `list` is ordered.
  let deleted = 0
  let processed = 0
  let vectorIdsDeleted = 0
  const deleteErrors: string[] = []
  for (const [ns, c] of candidates) {
    if (processed >= max) break
    processed += 1
    // GET one body for the ORIGINAL-CASE owner/repo the delete guard requires.
    // Prefer the manifest body; fall back to the vectors body for an orphan.
    const bodyKey = c.manifestKey ?? c.vectorsKey
    if (!bodyKey) {
      deleteErrors.push(`${ns}: no key`)
      continue
    }
    let raw: string | null
    try {
      raw = await env.OPENCLAW_STATE.get(bodyKey)
    } catch (err) {
      deleteErrors.push(`${ns}: get ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (raw === null) continue // raced/already gone — counts as processed, not an error.

    let owner: string | undefined
    let repo: string | undefined
    if (c.manifestKey === bodyKey) {
      const parsed = parseRepoIndexManifest(raw)
      if (parsed.kind === "ok") {
        owner = parsed.manifest.owner
        repo = parsed.manifest.repo
      }
    } else {
      const parsed = parseRepoIndexVectors(raw)
      if (parsed.kind === "ok") {
        owner = parsed.vectors.owner
        repo = parsed.vectors.repo
      }
    }
    if (!owner || !repo) {
      deleteErrors.push(`${ns}: unparseable body`)
      continue
    }

    const res = await deleteRepoIndex({ env, owner, repo, reason: "stale-index-purge" })
    vectorIdsDeleted += res.vectorIds
    if (res.status === "partial") {
      deleteErrors.push(`${ns}: ${res.errors.slice(0, 2).join("; ")}`)
    } else {
      deleted += 1
    }
  }

  summary.processed = processed
  summary.deleted = deleted
  summary.vectorIdsDeleted = vectorIdsDeleted
  summary.remaining = totalCandidateTuples - deleted
  summary.deleteErrors = deleteErrors.slice(0, 20)

  console.log(
    JSON.stringify({
      event: "stale-index-purge-batch",
      processed,
      deleted,
      vector_ids_deleted: vectorIdsDeleted,
      remaining: summary.remaining,
      error_count: deleteErrors.length,
    }),
  )

  return summary
}
