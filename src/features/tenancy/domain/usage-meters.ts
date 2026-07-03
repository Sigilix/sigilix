// SIG-303 full usage metering — pure domain knobs for the two usage pools.
//
// TWO INDEPENDENT POOLS (founder model):
//   • ORG pool  — a single shared org limit consumed by org AUTOMATION surfaces:
//       pr_reviews + linear_triage + slack. Usage is the SUM of those three
//       meters in the window, compared to ONE org cap. Per-meter `used` is a
//       breakdown; enforcement is on the pool total.
//   • SEAT pool — a per-dev limit consumed by a dev's DIRECT personal use:
//       coding_agent + chatbot. Usage is the SUM of those two for that seat,
//       compared to ONE seat cap.
//
// The pools are INDEPENDENT: an org-automation event never decrements a seat
// pool, and a seat event never decrements the org pool. Everything is COUNT-based
// (runs / messages / reviews) — never per-minute or per-cost.
//
// Windows: 5h ROLLING (session/burst) AND a FIXED weekly window that resets every
// Monday 09:00 UTC (NOT rolling 7d). WEEKLY is the primary/headline cap; the 5h
// window is the shorter burst guard. See weeklyWindowStartMs/ResetMs below.
//
// Domain-layer contract: NO env reads beyond the injected flag/override lookups,
// NO I/O, NO clock, NO network. Mirrors domain/rate-limit.ts conventions.

import type { Env } from "@/src/shared/types/env"

// ─── Pools, meters, windows ────────────────────────────────────────────────────

export type UsagePool = "org" | "seat"
export type UsageMeter = "pr_reviews" | "linear_triage" | "slack" | "coding_agent" | "chatbot"
export type UsageWindow = "session" | "weekly"

/** Org-pool meters (org-automation breakdown), in display order. */
export const ORG_METERS = ["pr_reviews", "linear_triage", "slack"] as const satisfies readonly UsageMeter[]
/** Seat-pool meters (per-dev direct-use breakdown), in display order. */
export const SEAT_METERS = ["coding_agent", "chatbot"] as const satisfies readonly UsageMeter[]

/** Which pool a meter draws down. */
export function meterPool(meter: UsageMeter): UsagePool {
  return meter === "coding_agent" || meter === "chatbot" ? "seat" : "org"
}

/** The meters recorded in the `usage_events` table (pr_reviews/linear_triage-read comes from their own ledgers). */
export type UsageEventMeter = "slack" | "linear_triage" | "coding_agent" | "chatbot"

// ─── Window constants ──────────────────────────────────────────────────────────

/** 5h ROLLING burst window (ms) — mirrors RATE_LIMIT_WINDOW_MS deliberately. */
export const USAGE_SESSION_WINDOW_MS = 18_000_000

/**
 * The WEEKLY window is NOT rolling — it resets on a FIXED weekly schedule:
 * every Monday 09:00. Weekly usage = events since the most recent Monday-09:00
 * boundary; it resets (zeroes) at the next Monday 09:00.
 *
 * TIMEZONE: UTC — a documented fixed anchor. The Worker has no per-user tz, and a
 * fixed UTC anchor is deterministic across POPs and immune to DST (a Monday-09:00
 * UTC boundary is always exactly 7×24h from the next). The portal renders the
 * `resets_at` instant in the viewer's locale, so "Resets Mon 9:00 AM" stays honest
 * as a wall-clock label even though the anchor itself is UTC.
 */
export const WEEKLY_ANCHOR_DOW_UTC = 1 // Monday (Date.getUTCDay(): 0=Sun … 6=Sat)
export const WEEKLY_ANCHOR_HOUR_UTC = 9 // 09:00
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Full week length (ms) — the fixed distance between consecutive Monday-09:00 anchors. */
export const USAGE_WEEKLY_WINDOW_MS = WEEK_MS

export const USAGE_WINDOW_LABEL: Record<UsageWindow, string> = {
  session: "5h",
  weekly: "Mon 9:00",
}

/**
 * Epoch-ms of the most recent Monday-09:00 UTC boundary at or before `nowMs` — the
 * lower bound of the current weekly window. Pure; DST-immune (all-UTC arithmetic).
 */
export function weeklyWindowStartMs(nowMs: number): number {
  const d = new Date(nowMs)
  const daysSinceMonday = (d.getUTCDay() - WEEKLY_ANCHOR_DOW_UTC + 7) % 7
  // Date.UTC normalizes a negative/overflowing day-of-month, so month/year roll safely.
  let anchor = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysSinceMonday,
    WEEKLY_ANCHOR_HOUR_UTC,
    0,
    0,
    0,
  )
  // If now is earlier in Monday than 09:00 (or the subtraction landed after now),
  // step back a full week so the anchor is always <= now.
  if (nowMs < anchor) anchor -= WEEK_MS
  return anchor
}

/** Epoch-ms of the NEXT Monday-09:00 UTC boundary strictly after `nowMs` (the weekly reset). */
export function weeklyWindowResetMs(nowMs: number): number {
  return weeklyWindowStartMs(nowMs) + WEEK_MS
}

// ─── Mode flag (shadow by default) ──────────────────────────────────────────────

export type UsageMeterMode = "off" | "shadow" | "enforce"

/**
 * Resolve the SIG-303 usage-metering feature flag. Same three-state rollout as
 * resolveRateLimitMode, but on its OWN env var so flipping usage enforcement is
 * independent of the SIG-38 per-author PR-review gate:
 *   - "enforce" — a new run/request over its pool cap is blocked.
 *   - "off"     — metering logic bypassed entirely.
 *   - "shadow"  — (default) usage is recorded + telemetered; nothing is blocked.
 * Absent/unknown/mis-cased → "shadow" (safe, observable default).
 */
export function resolveUsageMeterMode(env: Pick<Env, "SIGILIX_USAGE_METER_MODE">): UsageMeterMode {
  const v = env.SIGILIX_USAGE_METER_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "off") return "off"
  return "shadow"
}

// ─── Tunable free-tier pool caps ────────────────────────────────────────────────
//
// FREE-TIER DEFAULTS — deliberately placeholders. The founder sets the REAL
// numbers per (pool × window) via the env overrides below (SIG-41 will drive
// these from Stripe entitlements). A cap of `null` = no hard cap (usage-only,
// no bar fill). Weekly is the headline cap; session is the burst guard.
//
//   SEAT pool (coding_agent + chatbot, per dev): 40 / 5h · 200 / 7d
//   ORG  pool (pr_reviews + linear_triage + slack, per org): 20 / 5h · 100 / 7d
export const DEFAULT_POOL_CAPS: Record<UsagePool, Record<UsageWindow, number | null>> = {
  seat: { session: 40, weekly: 200 },
  org: { session: 20, weekly: 100 },
}

/** Env override var for each (pool × window). Numeric; negative → treated as "no cap" (null). */
const POOL_CAP_ENV: Record<UsagePool, Record<UsageWindow, keyof Env>> = {
  seat: {
    session: "SIGILIX_USAGE_CAP_SEAT_SESSION",
    weekly: "SIGILIX_USAGE_CAP_SEAT_WEEKLY",
  },
  org: {
    session: "SIGILIX_USAGE_CAP_ORG_SESSION",
    weekly: "SIGILIX_USAGE_CAP_ORG_WEEKLY",
  },
}

/**
 * Resolve the effective per-pool, per-window cap.
 *
 * Precedence: env override (when set to a valid integer) → DEFAULT_POOL_CAPS.
 * A negative override means "no hard cap" and resolves to `null` (usage-only).
 * A non-numeric / empty override is ignored (falls back to the default).
 *
 * TUNABLE — this is the single seam the founder / SIG-41 changes to set real caps.
 */
export function resolveUsagePoolCap(env: Partial<Env>, pool: UsagePool, window: UsageWindow): number | null {
  const raw = env[POOL_CAP_ENV[pool][window]]
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim())
    if (Number.isInteger(n)) return n < 0 ? null : n
  }
  return DEFAULT_POOL_CAPS[pool][window]
}

// ─── Decision ────────────────────────────────────────────────────────────────

/**
 * A new run/request is ALLOWED when the pool total is under cap on BOTH windows.
 * Fail-open: a null cap (no limit) never blocks; a non-finite used/cap never blocks.
 * Blocks only on clear, finite evidence of excess in either window.
 */
export function decideUsagePool(args: {
  usedSession: number
  capSession: number | null
  usedWeekly: number
  capWeekly: number | null
}): boolean {
  const over = (used: number, cap: number | null): boolean =>
    cap !== null && Number.isFinite(used) && Number.isFinite(cap) && used >= cap
  return !(over(args.usedSession, args.capSession) || over(args.usedWeekly, args.capWeekly))
}

/** 0–100 rounded; null when there is no cap (no percentage without a limit). */
export function usagePct(used: number, cap: number | null): number | null {
  if (cap === null || !Number.isFinite(cap) || cap <= 0) return null
  return Math.min(100, Math.max(0, Math.round((used / cap) * 100)))
}
