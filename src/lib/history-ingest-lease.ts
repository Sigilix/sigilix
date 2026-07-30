// D1 lease adapter for the repo-history backfill. Schema DDL is owned by
// migration 0039 — read its header for WHY this is a D1 lease and not the KV
// run-once guard (short version: sharded run needs a cursor; KV isn't a lock;
// history must be run-until-complete because a hole in it never refills).
//
// Contract at a glance:
//   claim    → atomic winner election (fresh, takeover-of-expired, model-migration
//              restart, or force). Loser gets a reason; winner gets a fenced token
//              and the RESUME cursor.
//   advance  → persist cursor + renew the lease, fenced on the token. `false`
//              means the lease was lost — the shard must stop writing and NOT
//              re-enqueue (its successor already owns the run).
//   expire   → set the lease to expired (keeping the cursor!) before rethrowing on
//              failure, so the queue's IMMEDIATE retry can take over and resume.
//              This is the release-on-throw lesson from the PR-backfill guard,
//              adapted: delete would lose the cursor; expiry keeps it.
//   complete → terminal, fenced.

import type { Env } from "@/src/shared/types/env"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"

/** Longer than one shard's processing budget so a live run is never usurped;
 *  short enough that a dead run's successor starts within minutes. */
export const HISTORY_LEASE_MS = 10 * 60 * 1000

export interface HistoryLeaseClaim {
  ok: true
  leaseToken: string
  /** Merged-PR-list index to RESUME from (0 on a fresh run). */
  cursor: number
  docsDone: number
}

export type HistoryLeaseResult = HistoryLeaseClaim | { ok: false; reason: "already-complete" | "in-flight" | "error" }

function keyOf(owner: string, repo: string): { owner: string; repo: string } {
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() }
}

/**
 * Atomically claim (or resume) the history backfill for a repo.
 *
 * Winner election is a single INSERT..ON CONFLICT..WHERE — `meta.changes === 1`
 * means we won. The WHERE admits exactly three takeover cases: an EXPIRED running
 * lease (dead shard → resume its cursor), a COMPLETE row under a DIFFERENT
 * embedding model (legitimate migration → restart), or `force`. A live lease or a
 * same-model complete row loses cleanly.
 *
 * THROWS on D1 unavailability rather than failing open — same reasoning as the
 * PR-backfill guard's read path: an unreadable coordinator must stall the queue
 * (which retries with backoff), never authorize unbounded embed spend.
 */
export async function claimHistoryLease(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { owner: string; repo: string; installationId: number; nowMs: number; force?: boolean },
): Promise<HistoryLeaseResult> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("history-lease: SIGILIX_PLATFORM_DB is not bound")
  const { owner, repo } = keyOf(args.owner, args.repo)
  const token = crypto.randomUUID()
  const expiry = args.nowMs + HISTORY_LEASE_MS

  const res = await db
    .prepare(
      "INSERT INTO history_ingest_lease" +
        " (owner, repo, installation_id, status, lease_token, lease_expires_at_ms, cursor, docs_done," +
        "  model_id, embedding_dim, started_at_ms, updated_at_ms)" +
        " VALUES (?, ?, ?, 'running', ?, ?, 0, 0, ?, ?, ?, ?)" +
        " ON CONFLICT (owner, repo) DO UPDATE SET" +
        "  installation_id = excluded.installation_id," +
        "  status = 'running'," +
        "  lease_token = excluded.lease_token," +
        "  lease_expires_at_ms = excluded.lease_expires_at_ms," +
        "  updated_at_ms = excluded.updated_at_ms," +
        // A model migration or force RESTARTS (cursor 0, fresh start time); a dead-
        // shard takeover RESUMES (cursor untouched). CASE keeps it one atomic stmt.
        "  cursor = CASE WHEN history_ingest_lease.model_id != excluded.model_id" +
        "                  OR history_ingest_lease.embedding_dim != excluded.embedding_dim OR ?" +
        "           THEN 0 ELSE history_ingest_lease.cursor END," +
        "  docs_done = CASE WHEN history_ingest_lease.model_id != excluded.model_id" +
        "                     OR history_ingest_lease.embedding_dim != excluded.embedding_dim OR ?" +
        "              THEN 0 ELSE history_ingest_lease.docs_done END," +
        "  started_at_ms = CASE WHEN history_ingest_lease.status = 'complete'" +
        "                  THEN excluded.started_at_ms ELSE history_ingest_lease.started_at_ms END," +
        "  completed_at_ms = NULL," +
        "  model_id = excluded.model_id," +
        "  embedding_dim = excluded.embedding_dim" +
        " WHERE (history_ingest_lease.status = 'running' AND history_ingest_lease.lease_expires_at_ms < ?)" +
        "    OR (history_ingest_lease.status = 'complete'" +
        "        AND (history_ingest_lease.model_id != excluded.model_id" +
        "             OR history_ingest_lease.embedding_dim != excluded.embedding_dim))" +
        // force re-runs a COMPLETE (or expired) backfill — it must NOT usurp a LIVE
        // run and throw away its in-flight progress; wait for it or let it finish.
        "    OR (? AND (history_ingest_lease.status = 'complete' OR history_ingest_lease.lease_expires_at_ms < ?))",
    )
    .bind(
      owner,
      repo,
      Math.trunc(args.installationId),
      token,
      expiry,
      EMBEDDING_MODEL,
      EMBEDDING_DIMENSIONS,
      args.nowMs,
      args.nowMs,
      args.force === true ? 1 : 0,
      args.force === true ? 1 : 0,
      args.nowMs,
      args.force === true ? 1 : 0,
      args.nowMs,
    )
    .run()

  if (res.meta.changes !== 1) {
    // Lost. Distinguish the reason for the skip log (best-effort read).
    try {
      const row = await db
        .prepare("SELECT status FROM history_ingest_lease WHERE owner = ? AND repo = ?")
        .bind(owner, repo)
        .first<{ status: string }>()
      return { ok: false, reason: row?.status === "complete" ? "already-complete" : "in-flight" }
    } catch {
      return { ok: false, reason: "in-flight" }
    }
  }

  // We won — read back OUR row (fenced on the token) to learn the resume cursor.
  const row = await db
    .prepare("SELECT cursor, docs_done FROM history_ingest_lease WHERE owner = ? AND repo = ? AND lease_token = ?")
    .bind(owner, repo, token)
    .first<{ cursor: number; docs_done: number }>()
  if (!row) return { ok: false, reason: "error" } // usurped between statements — impossible in-window, but never lie
  return { ok: true, leaseToken: token, cursor: Number(row.cursor) || 0, docsDone: Number(row.docs_done) || 0 }
}

/**
 * Resume a continuation shard that already OWNS the lease (its token rode the
 * queue message). Renews the expiry and returns the stored cursor. `ok:false`
 * means the lease moved on (a successor claimed after our expiry, or the run
 * completed) — the shard must stop.
 *
 * WHY THIS EXISTS: a continuation that re-CLAIMED would find its own freshly-
 * renewed lease live, be denied, and ack — permanently stalling the run with no
 * event left to resume it. Continuations renew; only run-starts claim.
 */
export async function renewHistoryLease(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { owner: string; repo: string; leaseToken: string; nowMs: number },
): Promise<{ ok: true; cursor: number; docsDone: number } | { ok: false }> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return { ok: false }
  const { owner, repo } = keyOf(args.owner, args.repo)
  const res = await db
    .prepare(
      "UPDATE history_ingest_lease SET lease_expires_at_ms = ?, updated_at_ms = ?" +
        " WHERE owner = ? AND repo = ? AND lease_token = ? AND status = 'running'",
    )
    .bind(args.nowMs + HISTORY_LEASE_MS, args.nowMs, owner, repo, args.leaseToken)
    .run()
  if (res.meta.changes !== 1) return { ok: false }
  const row = await db
    .prepare("SELECT cursor, docs_done FROM history_ingest_lease WHERE owner = ? AND repo = ? AND lease_token = ?")
    .bind(owner, repo, args.leaseToken)
    .first<{ cursor: number; docs_done: number }>()
  if (!row) return { ok: false }
  return { ok: true, cursor: Number(row.cursor) || 0, docsDone: Number(row.docs_done) || 0 }
}

/**
 * Persist shard progress + renew the lease. `false` = the lease was lost (token no
 * longer matches): the caller must stop, write nothing more, and NOT re-enqueue —
 * whoever took the lease owns the continuation.
 */
export async function advanceHistoryLease(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { owner: string; repo: string; leaseToken: string; cursor: number; docsDone: number; nowMs: number },
): Promise<{ ok: true; nextToken: string } | { ok: false }> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return { ok: false }
  const { owner, repo } = keyOf(args.owner, args.repo)
  // ROTATE the fencing token on every advance. Queues are at-least-once: a
  // redelivered continuation carries the PREVIOUS token, and without rotation it
  // would renew successfully, re-process the shard, and enqueue a SECOND
  // continuation — forking the chain into ~2× embed spend for the rest of the run.
  // With rotation the duplicate's renew fails (stale token) and it acks harmlessly.
  const nextToken = crypto.randomUUID()
  const res = await db
    .prepare(
      "UPDATE history_ingest_lease SET cursor = ?, docs_done = ?, lease_token = ?, lease_expires_at_ms = ?, updated_at_ms = ?" +
        " WHERE owner = ? AND repo = ? AND lease_token = ? AND status = 'running'",
    )
    .bind(
      Math.trunc(args.cursor),
      Math.trunc(args.docsDone),
      nextToken,
      args.nowMs + HISTORY_LEASE_MS,
      args.nowMs,
      owner,
      repo,
      args.leaseToken,
    )
    .run()
  return res.meta.changes === 1 ? { ok: true, nextToken } : { ok: false }
}

/**
 * Expire our lease (KEEPING the cursor) before rethrowing a shard failure, so the
 * queue's immediate retry can claim and RESUME instead of seeing a live lease,
 * acking, and losing the run — the exact failure mode the PR-backfill guard hit.
 * Best-effort: if this fails, the lease's natural expiry is the backstop.
 */
export async function expireHistoryLease(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { owner: string; repo: string; leaseToken: string },
): Promise<void> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return
  const { owner, repo } = keyOf(args.owner, args.repo)
  try {
    await db
      .prepare(
        "UPDATE history_ingest_lease SET lease_expires_at_ms = 0" +
          " WHERE owner = ? AND repo = ? AND lease_token = ? AND status = 'running'",
      )
      .bind(owner, repo, args.leaseToken)
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "history-lease-expire-failed",
        owner,
        repo,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/** Terminal completion, fenced. `false` = we no longer own the run. */
export async function completeHistoryLease(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { owner: string; repo: string; leaseToken: string; docsDone: number; nowMs: number },
): Promise<boolean> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return false
  const { owner, repo } = keyOf(args.owner, args.repo)
  const res = await db
    .prepare(
      "UPDATE history_ingest_lease SET status = 'complete', docs_done = ?, completed_at_ms = ?, updated_at_ms = ?" +
        " WHERE owner = ? AND repo = ? AND lease_token = ? AND status = 'running'",
    )
    .bind(Math.trunc(args.docsDone), args.nowMs, args.nowMs, owner, repo, args.leaseToken)
    .run()
  return res.meta.changes === 1
}
