// SIG-303 full usage metering — usage_events append adapter.
//
// Appends one row per metered event (a coding-agent run, a chatbot/research run,
// a Slack bot interaction, a Linear-triage). Fail-open BY DESIGN: any D1 error
// (or a missing binding) logs a warn and returns — metering must NEVER block or
// fail the request it is measuring. Schema DDL is owned by the migration.
//
// Dedup: when `eventId` is provided the (meter, event_id) UNIQUE partial index
// makes INSERT OR IGNORE idempotent across redeliveries (e.g. a webhook retry
// re-dispatching the same runId). When `eventId` is omitted every call inserts a
// fresh row (the natural granularity for per-turn CLI / chat requests).

import type { Env } from "@/src/shared/types/env"
import type { UsageEventMeter } from "@/src/features/tenancy/domain/usage-meters"

/**
 * Append one usage event. FAILS OPEN — never throws.
 *
 * @param installationId org key (0 when there is no org context, e.g. a
 *   portal-session seat event that is not repo-scoped).
 * @param userKey seat key ('gh:<id>' | 'slack:<id>'); null when the acting seat
 *   cannot be attributed (a documented gap, e.g. a per-installation CLI key).
 * @param eventId optional idempotency handle; when set, redeliveries dedup.
 */
export async function appendUsageEvent(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    meter: UsageEventMeter
    installationId: number
    userKey: string | null
    surface: string
    eventId?: string | null
    nowIso: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const installationId = Number.isFinite(args.installationId) ? args.installationId : 0
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO usage_events" +
          " (meter, installation_id, user_key, surface, event_id, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(args.meter, installationId, args.userKey ?? null, args.surface, args.eventId ?? null, args.nowIso)
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-events-append-failed",
        meter: args.meter,
        surface: args.surface,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
