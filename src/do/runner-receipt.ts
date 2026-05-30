// SIG-184 PR 2 — RunnerReceiptDO: atomic single-use guard + the defensible
// runner-evidence receipt.
//
// PR 1's verifier is replay-AGNOSTIC — it accepts any in-exp-window token, so
// enforcing single-use is the ingest route's job. KV can't do it (no
// compare-and-swap; two concurrent replays both pass a get-then-put). A SQLite
// Durable Object gives an atomic claim: `transactionSync` serializes, so the
// SELECT-then-INSERT below is race-free, and the row IS the defensible record
// (verified claims + the EXACT SARIF content hash). The bulky scrubbed SARIF is
// stored best-effort in KV alongside — losing it never loses the receipt.
//
// Sharded by repository_id (idFromName) so a busy repo serializes only against
// itself; the (repository_id, sha, run_id, run_attempt) key is repo-scoped.
// run_attempt is in the key because a GitHub re-run reuses run_id with an
// incremented attempt — a legitimate new submission, not a replay.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"

// Replay rows only need to outlive the OIDC token's exp window (~minutes); 7d is
// generous and bounds growth. GC runs via a daily alarm.
const RETENTION_DAYS = 7
const DAY_MS = 86_400_000

// `sha` is the OIDC-signed commit (== claims.sha — the MERGE commit for a
// pull_request) and is the single-use/replay key AND the value the review binds
// against the PR's merge_commit_sha. `pull_number` is parsed from the SIGNED
// claims.ref (`refs/pull/{N}/merge`) — it's the REVIEW-JOIN key. Both come from
// the OIDC token, so neither can be forged via the request body (CR-4: an
// untrusted body head_sha let a same-repo run retarget another PR's review).
// `scrubbed_sha256` is the hash of the SCRUBBED SARIF persisted to KV (the raw
// `sarif_sha256` is the GitHub-attested identity, but the stored body is
// scrubbed, so consumption integrity-checks against this one).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  repository_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_attempt TEXT NOT NULL,
  sarif_sha256 TEXT NOT NULL,
  scrubbed_sha256 TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  repository TEXT NOT NULL,
  job_workflow_ref TEXT NOT NULL,
  runner_environment TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, sha, run_id, run_attempt)
);
CREATE INDEX IF NOT EXISTS receipts_by_ingested ON receipts(ingested_at);
`
// The pull_number index is created in sql() AFTER the column migration — a table
// provisioned before pull_number existed wouldn't have the column when this
// static schema runs, so indexing it here would throw.
const PULL_INDEX = "CREATE INDEX IF NOT EXISTS receipts_by_pull ON receipts(repository_id, pull_number)"

export interface ClaimReceiptArgs {
  repositoryId: string
  /** The OIDC-signed sha (== claims.sha; the MERGE commit for pull_request). The
   *  single-use/replay key + the value the review binds to merge_commit_sha. */
  sha: string
  /** PR number parsed from the SIGNED claims.ref (`refs/pull/{N}/merge`) — the
   *  review-join key. 0 for a non-pull_request run (not PR-joinable). */
  pullNumber: number
  runId: string
  runAttempt: string
  /** SHA-256 (hex) of the EXACT SARIF bytes received, before scrubbing — the
   *  GitHub-attested receipt identity. */
  sarifSha256: string
  /** SHA-256 (hex) of the SCRUBBED SARIF persisted to KV — integrity of the
   *  stored body, so consumption can verify it before trusting it as evidence. */
  scrubbedSha256: string
  repository: string
  jobWorkflowRef: string
  runnerEnvironment: string
  /** epoch ms; defaults to now. */
  ingestedAtMs?: number
}

/** A verified receipt row, returned by the review-join lookup. */
export interface RunnerReceiptRow {
  sha: string
  pullNumber: number
  runId: string
  runAttempt: string
  sarifSha256: string
  scrubbedSha256: string
  repository: string
  jobWorkflowRef: string
  runnerEnvironment: string
  ingestedAt: number
}

export type ClaimReceiptResult =
  // First time this (repo, sha, run, attempt) was seen — accepted.
  | { outcome: "accepted" }
  // Seen before with the SAME SARIF content — idempotent replay (CI retry).
  | { outcome: "duplicate" }
  // Seen before with a DIFFERENT SARIF content — a conflicting resubmission.
  | { outcome: "conflict"; existingSarifSha256: string }

export class RunnerReceiptDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      const sql = this.ctx.storage.sql
      sql.exec(SCHEMA)
      // Defensive migration (CR): `CREATE TABLE IF NOT EXISTS` does NOT add new
      // columns to a table provisioned by an earlier schema. No prod DO instance
      // exists today (the route is 503-gated, zero ingests), so this is
      // belt-and-suspenders — but it makes a re-provisioned/old shard safe rather
      // than failing every INSERT/SELECT with a missing-column error. NOT NULL +
      // DEFAULT '' satisfies any pre-existing rows (there are none).
      const cols = new Set([...sql.exec<{ name: string }>("PRAGMA table_info(receipts)")].map((r) => r.name))
      if (!cols.has("scrubbed_sha256")) sql.exec("ALTER TABLE receipts ADD COLUMN scrubbed_sha256 TEXT NOT NULL DEFAULT ''")
      if (!cols.has("pull_number")) sql.exec("ALTER TABLE receipts ADD COLUMN pull_number INTEGER NOT NULL DEFAULT 0")
      sql.exec(PULL_INDEX) // safe now — pull_number is guaranteed to exist
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Atomically claim a receipt. `transactionSync` runs to completion without
   * yielding, so the SELECT-then-INSERT can't interleave with a concurrent
   * claim. On an existing row we compare the stored SARIF hash:
   *   - no row        → insert → "accepted"
   *   - same hash     → idempotent CI retry → "duplicate"
   *   - different hash → different SARIF for the same run → "conflict"
   */
  async claimReceipt(args: ClaimReceiptArgs): Promise<ClaimReceiptResult> {
    const sql = this.sql()
    const at = args.ingestedAtMs ?? Date.now()
    let result: ClaimReceiptResult = { outcome: "accepted" }

    this.ctx.storage.transactionSync(() => {
      const existing = [
        ...sql.exec<{ sarif_sha256: string }>(
          `SELECT sarif_sha256 FROM receipts
           WHERE repository_id = ? AND sha = ? AND run_id = ? AND run_attempt = ?`,
          args.repositoryId, args.sha, args.runId, args.runAttempt,
        ),
      ][0]

      if (!existing) {
        sql.exec(
          `INSERT INTO receipts
             (repository_id, sha, run_id, run_attempt, sarif_sha256, scrubbed_sha256,
              pull_number, repository, job_workflow_ref, runner_environment, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args.repositoryId, args.sha, args.runId, args.runAttempt,
          args.sarifSha256, args.scrubbedSha256, args.pullNumber, args.repository,
          args.jobWorkflowRef, args.runnerEnvironment, at,
        )
        result = { outcome: "accepted" }
      } else if (existing.sarif_sha256 === args.sarifSha256) {
        result = { outcome: "duplicate" }
      } else {
        result = { outcome: "conflict", existingSarifSha256: existing.sarif_sha256 }
      }
    })

    // Ensure a GC alarm is pending (idempotent — only sets when none exists).
    // Best-effort: a scheduling failure must NEVER fail an already-committed
    // claim (the row is the defensible receipt; the next claim re-schedules GC).
    try {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
      }
    } catch {
      /* GC will be (re)scheduled on a later claim */
    }
    return result
  }

  /** Daily retention GC: drop receipts older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM receipts WHERE ingested_at < ?", cutoff)
    })
    // Only reschedule while rows remain, so an idle DO doesn't hold an alarm.
    const remaining = [...sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")][0]?.n ?? 0
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /**
   * Review-join lookup: the most-recent receipt for a review of `(repository_id,
   * pull_number)` — both SIGNED values (the caller MUST further bind by comparing
   * the returned `sha` to the PR's GitHub `merge_commit_sha`, so a stale receipt
   * for an older merge doesn't match). NOT the replay key — a re-run with a higher
   * run_attempt (newer `ingested_at`) supersedes. Returns the row incl.
   * `scrubbedSha256` for the KV-body integrity check. Null if no receipt. A
   * `pullNumber <= 0` (non-PR run) never joins.
   */
  async queryReceiptByPull(repositoryId: string, pullNumber: number): Promise<RunnerReceiptRow | null> {
    if (pullNumber <= 0) return null
    const sql = this.sql()
    const r = [
      ...sql.exec<{
        sha: string; pull_number: number; run_id: string; run_attempt: string
        sarif_sha256: string; scrubbed_sha256: string; repository: string
        job_workflow_ref: string; runner_environment: string; ingested_at: number
      }>(
        `SELECT sha, pull_number, run_id, run_attempt, sarif_sha256, scrubbed_sha256,
                repository, job_workflow_ref, runner_environment, ingested_at
         FROM receipts WHERE repository_id = ? AND pull_number = ?
         ORDER BY ingested_at DESC LIMIT 1`,
        repositoryId, pullNumber,
      ),
    ][0]
    return r
      ? {
          sha: r.sha, pullNumber: r.pull_number, runId: r.run_id, runAttempt: r.run_attempt,
          sarifSha256: r.sarif_sha256, scrubbedSha256: r.scrubbed_sha256,
          repository: r.repository, jobWorkflowRef: r.job_workflow_ref,
          runnerEnvironment: r.runner_environment, ingestedAt: r.ingested_at,
        }
      : null
  }

  /** Test-only: fetch a stored receipt row (or null). */
  async debugGet(
    repositoryId: string,
    sha: string,
    runId: string,
    runAttempt: string,
  ): Promise<{ sarifSha256: string; ingestedAt: number } | null> {
    const sql = this.sql()
    const r = [
      ...sql.exec<{ sarif_sha256: string; ingested_at: number }>(
        `SELECT sarif_sha256, ingested_at FROM receipts
         WHERE repository_id = ? AND sha = ? AND run_id = ? AND run_attempt = ?`,
        repositoryId, sha, runId, runAttempt,
      ),
    ][0]
    return r ? { sarifSha256: r.sarif_sha256, ingestedAt: r.ingested_at } : null
  }
}
