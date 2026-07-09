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
 * @param tokens  optional total tokens for this event (sig-cost-based-metering);
 *   missing/non-finite/negative → 0 (fail-safe: a 0 never inflates window spend).
 * @param costUsd optional blended model spend in USD for this event; same
 *   coercion. Both DEFAULT 0 in the schema, so a caller that has no usage yet may
 *   omit them and the row still records the event (count/attribution unchanged).
 */
export async function appendUsageEvent(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    meter: UsageEventMeter
    installationId: number
    userKey: string | null
    surface: string
    eventId?: string | null
    tokens?: number
    costUsd?: number
    nowIso: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const installationId = Number.isFinite(args.installationId) ? args.installationId : 0
  // Cost/tokens are not identity — coerce to a safe 0 (never NULL/NaN/negative).
  const tokens = typeof args.tokens === "number" && Number.isFinite(args.tokens) && args.tokens > 0 ? args.tokens : 0
  const costUsd =
    typeof args.costUsd === "number" && Number.isFinite(args.costUsd) && args.costUsd > 0 ? args.costUsd : 0
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO usage_events" +
          " (meter, installation_id, user_key, surface, event_id, tokens, cost_usd, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        args.meter,
        installationId,
        args.userKey ?? null,
        args.surface,
        args.eventId ?? null,
        tokens,
        costUsd,
        args.nowIso,
      )
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

/**
 * Late-bind the token/cost usage of an already-appended event (sig-cost-based-
 * metering). Some surfaces record the event at admission / run-start (for the
 * count + attribution) but only KNOW the model spend when the work completes
 * asynchronously — e.g. the deep-research (chatbot) DO, which appends at start
 * keyed by the run id and computes tokens as it runs. Those surfaces call this at
 * completion to stamp the real `tokens` + `cost_usd` onto the row.
 *
 * Idempotent + fail-safe: matches on `(meter, event_id)` (the same key the append
 * dedups on), so an `event_id` is REQUIRED — a null/blank one no-ops. A
 * missing/non-finite/negative value coerces to 0. FAILS OPEN — never throws.
 */
export async function updateUsageEventCost(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { meter: UsageEventMeter; eventId: string; tokens?: number; costUsd?: number },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const eventId = args.eventId?.trim()
  if (!eventId) return // no correlation handle → nothing to update
  const tokens = typeof args.tokens === "number" && Number.isFinite(args.tokens) && args.tokens > 0 ? args.tokens : 0
  const costUsd =
    typeof args.costUsd === "number" && Number.isFinite(args.costUsd) && args.costUsd > 0 ? args.costUsd : 0
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare("UPDATE usage_events SET tokens = ?, cost_usd = ? WHERE meter = ? AND event_id = ?")
      .bind(tokens, costUsd, args.meter, eventId)
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-events-cost-update-failed",
        meter: args.meter,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
