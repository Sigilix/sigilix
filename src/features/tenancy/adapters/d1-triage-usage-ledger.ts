// SIG-38 free-launch caps — Linear-triage usage ledger append adapter.
//
// Mirrors `d1-usage-ledger.ts` (the PR-review writer) but appends one row per
// unique (team_id, issue_id) tuple to the separate `triage_usage_ledger`
// table — INSERT OR IGNORE deduplicates redeliveries/re-triages of the same
// issue transparently, matching the cap's literal "issues triaged per
// window" semantics (a re-triage of an already-counted issue is a no-op, not
// a second slot consumed). Rows with missing identity (empty teamId/issueId)
// are skipped before touching D1.
//
// Fail-open by design: any D1 error logs a warn and returns; metering must
// never block a triage. Schema DDL is owned by the migration.

import type { Env } from "@/src/shared/types/env"

/**
 * Append a single triage-usage row. Silently skips rows with missing
 * identity (empty teamId or issueId). Deduplicates on the
 * `UNIQUE(team_id, issue_id)` constraint via INSERT OR IGNORE
 * (first-write-wins).
 *
 * FAILS OPEN — any error logs a warn and returns void; never throws.
 */
export async function appendTriageUsage(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { teamId: string; issueId: string; nowIso: string },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  if (args.teamId === "" || args.issueId === "") return
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare("INSERT OR IGNORE INTO triage_usage_ledger (team_id, issue_id, created_at) VALUES (?, ?, ?)")
      .bind(args.teamId, args.issueId, args.nowIso)
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-triage-usage-ledger-append-failed",
        teamId: args.teamId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
