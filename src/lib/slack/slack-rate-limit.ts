// SIG-196: lightweight rolling-window rate-limit counter for Slack actions.
//
// KV key:  `slack-rl:${teamId}:${slackUserId}`
// Value:   JSON array of action epoch-ms timestamps (pruned to the window on each op).
//
// checkSlackRateLimit — PURE read: never writes KV. Fail-open on any KV fault
//                       so the review/triage surfaces stay available during outages.
// recordSlackAction   — Best-effort write. Swallows all faults; never throws.
//                       The CALLER invokes this only after performing real work so
//                       shadow mode can check-without-consuming via check alone.

import type { Env } from "@/src/shared/types/env"

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CAP = 3
const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SlackRateDecision {
  allowed: boolean
  used: number
  cap: number
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function kvKey(teamId: string, slackUserId: string): string {
  return `slack-rl:${teamId}:${slackUserId}`
}

/**
 * Read the KV entry and return only the timestamps that fall within the window.
 * Throws if kv.get throws (callers decide how to handle the fault).
 * A missing key or an unparseable value is treated as an empty list.
 */
async function readAndPrune(kv: KVNamespace, key: string, nowMs: number, windowMs: number): Promise<number[]> {
  const raw = await kv.get(key)
  let entries: number[]
  try {
    entries = raw !== null ? (JSON.parse(raw) as number[]) : []
    if (!Array.isArray(entries)) entries = []
  } catch {
    entries = []
  }
  const cutoff = nowMs - windowMs
  return entries.filter((ts) => ts > cutoff)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether the given Slack user is within their rolling-window cap.
 *
 * PURE READ — never writes KV.
 * On ANY KV fault → fail-open: `{ allowed: true, used: 0, cap }`.
 */
export async function checkSlackRateLimit(
  env: Pick<Env, "OPENCLAW_STATE">,
  args: { teamId: string; slackUserId: string; nowMs: number; cap?: number; windowMs?: number },
): Promise<SlackRateDecision> {
  const cap = args.cap ?? DEFAULT_CAP
  const windowMs = args.windowMs ?? DEFAULT_WINDOW_MS
  try {
    const pruned = await readAndPrune(env.OPENCLAW_STATE, kvKey(args.teamId, args.slackUserId), args.nowMs, windowMs)
    const used = pruned.length
    return { allowed: used < cap, used, cap }
  } catch {
    return { allowed: true, used: 0, cap }
  }
}

/**
 * Record that the caller performed a Slack action right now.
 *
 * Reads the current entries, prunes stale ones, appends `nowMs`, and writes
 * back with an expiration TTL of `windowMs + 60s`. Best-effort — swallows all
 * faults and never throws so a KV outage cannot break the caller's happy path.
 */
export async function recordSlackAction(
  env: Pick<Env, "OPENCLAW_STATE">,
  args: { teamId: string; slackUserId: string; nowMs: number; windowMs?: number },
): Promise<void> {
  const windowMs = args.windowMs ?? DEFAULT_WINDOW_MS
  const key = kvKey(args.teamId, args.slackUserId)
  try {
    const pruned = await readAndPrune(env.OPENCLAW_STATE, key, args.nowMs, windowMs)
    pruned.push(args.nowMs)
    await env.OPENCLAW_STATE.put(key, JSON.stringify(pruned), {
      expirationTtl: Math.ceil(windowMs / 1000) + 60,
    })
  } catch {
    // best-effort: swallow all faults
  }
}
