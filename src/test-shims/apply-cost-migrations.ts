// sig-cost-based-metering — test helper: apply the cost-column migrations.
//
// Migrations are forward-only (COMPLIANCE §8) — 0014 adds `cost_usd` to
// usage_ledger and 0015 adds `tokens` + `cost_usd` to usage_events. Any test that
// builds those tables from 0001/0004 and then exercises the cost-aware read/write
// paths must ALSO apply these, exactly as prod does (`wrangler d1 migrations apply`
// runs every migration in order). Reads the real migration files so the test schema
// can never drift from the shipped DDL.
//
// Fail-soft PER FILE: a test that created only usage_ledger (not usage_events), or
// vice-versa, gets a "no such table" on the other ALTER — swallowed, so every test
// can call this once regardless of which of the two tables it built.

import { readFileSync } from "node:fs"

const LEDGER_COST_SQL = readFileSync(
  new URL("../../migrations/0014_add_cost_usd_to_usage_ledger.sql", import.meta.url),
  "utf8",
)
const EVENTS_COST_SQL = readFileSync(
  new URL("../../migrations/0015_add_cost_usd_to_usage_events.sql", import.meta.url),
  "utf8",
)

/** Apply the cost-column migrations to whichever of usage_ledger / usage_events the
 *  test has already created. Idempotent-ish for tests: safe to call once after the
 *  base schema is applied. */
export async function applyCostMigrations(db: D1Database): Promise<void> {
  for (const sql of [LEDGER_COST_SQL, EVENTS_COST_SQL]) {
    try {
      await db.exec(sql)
    } catch {
      // The target table isn't present in this test's schema — nothing to alter.
    }
  }
}
