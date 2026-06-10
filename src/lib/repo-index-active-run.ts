// SIG-136: per-repo run LEASE for the indexer. Claimed at bootstrap BEFORE
// persistVectorIds so a re-index (new runId) is recognized as authoritative
// instead of stale-skipped, and a redelivered/superseded run is rejected at
// every write point. Lease semantics: claim-required (writeActiveRun THROWS on
// KV failure → queue retry), NEVER explicitly cleared (a slow old run must not
// delete a newer run's lease), reclaimed by overwrite (next bootstrap) + TTL.

import type { Env } from "@/src/shared/types/env"
import { indexNamespace } from "./repo-index-manifest"

const KV_KEY_PREFIX = "repo-index-active-run:"
// A run is capped at the queue's 15-min wall-clock; 1h covers a multi-shard
// chain (refreshed per shard) and self-heals a crashed run via the next
// bootstrap's overwrite. TTL is the ONLY reclaim path.
const TTL_SECONDS = 60 * 60

export interface RepoIndexActiveRunV1 {
  v: 1
  runId: string
  startedAt: string
}

export function activeRunKey(owner: string, repo: string): string {
  return `${KV_KEY_PREFIX}${indexNamespace(owner, repo)}`
}

/**
 * Claim/refresh the lease. THROWS on KV write failure so the caller can
 * distinguish "couldn't claim → retry the job" from "yielded to a newer run →
 * ack-skip". Overwrites unconditionally (last-writer-at-claim wins); the
 * caller is responsible for only claiming when it still owns / is starting the
 * run.
 */
export async function writeActiveRun(
  env: Env,
  owner: string,
  repo: string,
  runId: string,
): Promise<void> {
  const record: RepoIndexActiveRunV1 = { v: 1, runId, startedAt: new Date().toISOString() }
  await env.OPENCLAW_STATE.put(activeRunKey(owner, repo), JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  })
}

/** The current lease holder's runId, or null (missing / invalid / wrong-version). */
export async function readActiveRunId(env: Env, owner: string, repo: string): Promise<string | null> {
  const raw = await env.OPENCLAW_STATE.get(activeRunKey(owner, repo))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o.v !== 1 || typeof o.runId !== "string" || o.runId.length === 0) return null
  return o.runId
}

/**
 * The finalization-guard predicate: a run may persist its merge / write the
 * manifest / enqueue the next shard only when the lease is absent (TTL-expired,
 * treated as "no competing owner") or names this run. A lease owned by a
 * DIFFERENT run means this run was superseded → must abort.
 */
export function shouldFinalize(activeRunId: string | null, runId: string): boolean {
  return activeRunId === null || activeRunId === runId
}
