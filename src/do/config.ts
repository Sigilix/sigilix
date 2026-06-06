// ARC-190 Task 1 + SIG-174: DO config resolver.
//
// Pure function — clamps numeric envs for retry/watchdog/history limits.
// The DO-backed webhook path is now always authoritative; the old
// review-mode rollout flag was removed after stabilization.
//
// `Env` is imported as a TYPE only (per Codex MINOR on plan v2) to avoid
// runtime cycles through `src/index.ts` — the entry module imports the
// DO class which imports this file; without `import type` we'd have a
// load-order hazard.

import type { Env } from "../index"
import type { ResolvedDoConfig } from "./types"

/** Spec §4.9 — locked defaults. */
const DEFAULT_MAX_RETRIES = 3
// SIG-329: lowered 20 min → 10 min. With the runner heartbeat + liveness
// alarm (see `DEFAULT_LIVENESS_MS`) a dead consumer is detected within
// `livenessMs`, so the watchdog is now only an absolute backstop
// reflecting the real p99 review duration (~10 min) rather than the
// dead-consumer detector it used to be (which forced a full 20-min wait
// before retry — SIG-329 root cause).
const DEFAULT_WATCHDOG_MS = 600000  // 10 min absolute backstop
// SIG-329: max tolerated gap between consumer heartbeats. A running
// attempt re-arms the liveness alarm on every `/heartbeat`; if no
// heartbeat lands within this window the DO declares the attempt dead
// and retries immediately instead of waiting out the watchdog.
const DEFAULT_LIVENESS_MS = 90000  // 90s heartbeat-gap detector
const DEFAULT_HISTORY_LIMIT = 10

/** Spec §4.9 — clamp ranges. */
const MAX_RETRIES_RANGE = [1, 10] as const
const WATCHDOG_MS_RANGE = [60000, 1800000] as const   // 1 min - 30 min
// SIG-329: liveness clamp. Floor 45s, ceiling 5 min (still far under the
// watchdog backstop so a misconfig can't silently disable fast detection).
// INVARIANT: the floor MUST exceed the consumer's HEARTBEAT_INTERVAL_MS
// (30s, see `consumer-wrapper.ts`) — otherwise the first liveness alarm
// (armed at pickup + livenessMs) would fire before the consumer's first
// heartbeat (at pickup + interval) and false-declare a live consumer dead.
// 45s leaves 15s of slack over the 30s beat (Sigilix PR #370 finding #3).
const LIVENESS_MS_RANGE = [45000, 300000] as const
const HISTORY_LIMIT_RANGE = [1, 100] as const

function clampInt(
  raw: string | undefined,
  fallback: number,
  range: readonly [number, number],
): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  return Math.max(range[0], Math.min(range[1], rounded))
}

/**
 * Resolve the per-deployment DO config from env vars. Pure; never
 * throws. `Env` import is type-only to avoid runtime cycles.
 */
export function resolveDoConfig(env: Env): ResolvedDoConfig {
  return {
    maxRetries: clampInt(
      env.OPENCLAW_PR_REVIEW_DO_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      MAX_RETRIES_RANGE,
    ),
    watchdogMs: clampInt(
      env.OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS,
      DEFAULT_WATCHDOG_MS,
      WATCHDOG_MS_RANGE,
    ),
    livenessMs: clampInt(
      env.OPENCLAW_PR_REVIEW_DO_LIVENESS_MS,
      DEFAULT_LIVENESS_MS,
      LIVENESS_MS_RANGE,
    ),
    historyLimit: clampInt(
      env.OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT,
      DEFAULT_HISTORY_LIMIT,
      HISTORY_LIMIT_RANGE,
    ),
  }
}
