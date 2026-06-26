// SIG-343 PR C Task 3 — usage ledger append adapter.
//
// Appends one row per unique (installation_id, repo_id, pr_number, head_sha)
// tuple; INSERT OR IGNORE deduplicates webhook redeliveries transparently.
// Rows with missing identity (empty headSha, non-finite ids) are skipped
// before touching D1 so the ledger never holds identity-less noise.
//
// Fail-open by design: any D1 error logs a warn and returns; metering must
// never block a review.  Schema DDL is owned by the migration.

import type { Env } from "@/src/shared/types/env"

/**
 * Append a single usage row.  Silently skips rows with missing identity
 * (non-finite installationId / repoId / prNumber, or empty headSha) and
 * deduplicates on the `UNIQUE(installation_id, repo_id, pr_number, head_sha)`
 * constraint via INSERT OR IGNORE (first-write-wins on all metric + author columns).
 *
 * `authorLogin` is supplementary attribution — NOT part of the identity key.
 *
 * FAILS OPEN — any error logs a warn and returns void; never throws.
 */
export async function appendUsage(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    modelCalls: number
    tokens: number
    authorLogin?: string | null
    nowIso: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  if (
    !Number.isFinite(args.installationId) ||
    !Number.isFinite(args.repoId) ||
    !Number.isFinite(args.prNumber) ||
    args.headSha === ""
  ) {
    return
  }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO usage_ledger" +
          " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        args.installationId,
        args.repoId,
        args.prNumber,
        args.headSha,
        args.modelCalls,
        args.tokens,
        args.authorLogin ?? null,
        args.nowIso,
      )
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-ledger-append-failed",
        installationId: args.installationId,
        repoId: args.repoId,
        prNumber: args.prNumber,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
