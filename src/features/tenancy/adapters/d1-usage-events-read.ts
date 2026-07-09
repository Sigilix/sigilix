// SIG-303 full usage metering — usage_events read adapter.
//
// Fail-open by design: D1 errors log a warn and return {ok:false} so callers can
// distinguish "genuinely zero" from "couldn't read the DB". Schema DDL is owned by
// the migration — no ensureSchema here.
//
// created_at ordering invariant: all writes use new Date().toISOString() (canonical
// 24-char ".sssZ" UTC), which sorts lexicographically identically to
// chronologically, so `created_at >= ?` is index-safe (mirrors d1-usage-read.ts).

import type { Env } from "@/src/shared/types/env"
import type { UsageEventMeter } from "@/src/features/tenancy/domain/usage-meters"

/**
 * Count usage_events rows for a single meter in the window [sinceIso, now].
 *
 * Scope selectors (both optional; AND-combined when both present):
 *   - installationId → ORG-pool rollup (WHERE installation_id = ?).
 *   - userKey        → SEAT-pool rollup (WHERE user_key = ?).
 * Passing both narrows to "this user's events within this org" (org per-author
 * drill-down). Passing neither counts every row for the meter (not used by the
 * route, but well-defined).
 *
 * Returns {ok:true,count} on success (count may be 0), {ok:false} on a missing
 * binding OR a D1 fault. Callers MUST check `ok` — {ok:false} is a fault sentinel,
 * NOT "zero events". FAILS OPEN — never throws.
 */
export async function readUsageEventCount(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { meter: UsageEventMeter; installationId?: number; userKey?: string; sinceIso: string },
): Promise<{ ok: true; count: number } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  const db = env.SIGILIX_PLATFORM_DB
  const clauses = ["meter = ?", "created_at >= ?"]
  const binds: (string | number)[] = [args.meter, args.sinceIso]
  if (args.installationId !== undefined) {
    clauses.push("installation_id = ?")
    binds.push(args.installationId)
  }
  if (args.userKey !== undefined) {
    clauses.push("user_key = ?")
    binds.push(args.userKey)
  }
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ${clauses.join(" AND ")}`)
      .bind(...binds)
      .first<{ n: unknown }>()
    return { ok: true, count: Number(row?.n) || 0 }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-events-read-failed",
        meter: args.meter,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}

/**
 * SUM the `cost_usd` (blended model spend, migration 0015) of usage_events rows for
 * a meter in the window [sinceIso, now]. Same scope selectors as `readUsageEventCount`
 * (installationId → ORG pool; userKey → SEAT pool; both → per-member drill). Powers
 * the cost dimension of /v1/usage for the CLI (coding_agent) + chatbot surfaces.
 *
 * `COALESCE(SUM(cost_usd),0)` so a window with only pre-column rows (default 0) or no
 * rows reads 0.0, never NULL. Returns {ok:false} on a missing binding / D1 fault —
 * a fault sentinel, NOT "zero cost". FAILS OPEN — never throws.
 */
export async function readUsageEventCostSince(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { meter: UsageEventMeter; installationId?: number; userKey?: string; sinceIso: string },
): Promise<{ ok: true; costUsd: number } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  const db = env.SIGILIX_PLATFORM_DB
  const clauses = ["meter = ?", "created_at >= ?"]
  const binds: (string | number)[] = [args.meter, args.sinceIso]
  if (args.installationId !== undefined) {
    clauses.push("installation_id = ?")
    binds.push(args.installationId)
  }
  if (args.userKey !== undefined) {
    clauses.push("user_key = ?")
    binds.push(args.userKey)
  }
  try {
    const row = await db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_events WHERE ${clauses.join(" AND ")}`)
      .bind(...binds)
      .first<{ cost: unknown }>()
    return { ok: true, costUsd: Number(row?.cost) || 0 }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-events-cost-read-failed",
        meter: args.meter,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}

/**
 * Per-author breakdown of ORG-pool events for a meter within an installation +
 * window: `[{ userKey, count }]` sorted desc by count. Powers the org
 * "who triggered it" drill-down. Rows with a NULL user_key are bucketed under the
 * literal string "unattributed". Returns {ok:false} on a missing binding / fault.
 * FAILS OPEN — never throws.
 */
export async function readUsageEventAuthorBreakdown(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { meter: UsageEventMeter; installationId: number; sinceIso: string },
): Promise<{ ok: true; authors: Array<{ userKey: string; count: number }> } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const { results } = await db
      .prepare(
        "SELECT COALESCE(user_key, 'unattributed') AS userKey, COUNT(*) AS n" +
          " FROM usage_events WHERE meter = ? AND installation_id = ? AND created_at >= ?" +
          " GROUP BY COALESCE(user_key, 'unattributed') ORDER BY n DESC",
      )
      .bind(args.meter, args.installationId, args.sinceIso)
      .all<{ userKey: unknown; n: unknown }>()
    const authors = results.map((r) => ({
      userKey: typeof r.userKey === "string" ? r.userKey : "unattributed",
      count: Number(r.n) || 0,
    }))
    return { ok: true, authors }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-events-author-breakdown-failed",
        meter: args.meter,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}
