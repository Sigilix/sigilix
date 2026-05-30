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

// `sha` is the OIDC-bound commit (== claims.sha — the MERGE commit for a
// pull_request) and is the single-use/replay key. `head_sha` is the PR HEAD
// commit — the key Sigilix's review joins on (see queryReceiptByHead); for
// non-PR events the two are equal. `scrubbed_sha256` is the hash of the SCRUBBED
// SARIF actually persisted to KV (the raw `sarif_sha256` is the GitHub-attested
// identity, but the stored body is scrubbed, so consumption integrity-checks
// against this one — PR 3 / the believability boundary).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  repository_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_attempt TEXT NOT NULL,
  sarif_sha256 TEXT NOT NULL,
  scrubbed_sha256 TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  repository TEXT NOT NULL,
  job_workflow_ref TEXT NOT NULL,
  runner_environment TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, sha, run_id, run_attempt)
);
CREATE INDEX IF NOT EXISTS receipts_by_ingested ON receipts(ingested_at);
CREATE INDEX IF NOT EXISTS receipts_by_head ON receipts(repository_id, head_sha);
`

export interface ClaimReceiptArgs {
  repositoryId: string
  /** The OIDC-bound sha (== claims.sha; the MERGE commit for pull_request). The
   *  single-use/replay key. */
  sha: string
  /** The PR HEAD sha — the review's join key. For non-PR events == `sha`. */
  headSha: string
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
  headSha: string
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
      this.ctx.storage.sql.exec(SCHEMA)
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
              head_sha, repository, job_workflow_ref, runner_environment, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args.repositoryId, args.sha, args.runId, args.runAttempt,
          args.sarifSha256, args.scrubbedSha256, args.headSha, args.repository,
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
   * Review-join lookup: the most-recent verified receipt for a review of
   * `(repository_id, head_sha)`. This is the REVIEW path, NOT the replay key — a
   * re-run with a higher run_attempt (newer `ingested_at`) supersedes. Returns
   * the row incl. `scrubbedSha256` so the caller can integrity-check the KV body
   * before trusting it as "verified" evidence. Null if no receipt.
   */
  async queryReceiptByHead(repositoryId: string, headSha: string): Promise<RunnerReceiptRow | null> {
    const sql = this.sql()
    const r = [
      ...sql.exec<{
        sha: string; head_sha: string; run_id: string; run_attempt: string
        sarif_sha256: string; scrubbed_sha256: string; repository: string
        job_workflow_ref: string; runner_environment: string; ingested_at: number
      }>(
        `SELECT sha, head_sha, run_id, run_attempt, sarif_sha256, scrubbed_sha256,
                repository, job_workflow_ref, runner_environment, ingested_at
         FROM receipts WHERE repository_id = ? AND head_sha = ?
         ORDER BY ingested_at DESC LIMIT 1`,
        repositoryId, headSha,
      ),
    ][0]
    return r
      ? {
          sha: r.sha, headSha: r.head_sha, runId: r.run_id, runAttempt: r.run_attempt,
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
