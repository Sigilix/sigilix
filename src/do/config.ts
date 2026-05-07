// ARC-190 Task 1: env-driven DO config resolver.
//
// Pure function — clamps numeric envs, validates `OPENCLAW_PR_REVIEW_MODE`
// against the literal union, defaults to OFF on unknown / missing values.
// Locked defaults match spec §4.9.
//
// `Env` is imported as a TYPE only (per Codex MINOR on plan v2) to avoid
// runtime cycles through `src/index.ts` — the entry module imports the
// DO class which imports this file; without `import type` we'd have a
// load-order hazard.

import type { Env } from "../index"
import type { PrReviewMode, ResolvedDoConfig } from "./types"

const VALID_MODES = new Set<PrReviewMode>(["off", "shadow", "post"])

/** Spec §4.9 — locked defaults. */
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_WATCHDOG_MS = 1200000  // 20 min — matches spec §4.6a
const DEFAULT_HISTORY_LIMIT = 10

/** Spec §4.9 — clamp ranges. */
const MAX_RETRIES_RANGE = [1, 10] as const
const WATCHDOG_MS_RANGE = [60000, 1800000] as const   // 1 min - 30 min
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

function resolveMode(raw: string | undefined): PrReviewMode {
  if (raw === undefined || raw === null) return "off"
  if (VALID_MODES.has(raw as PrReviewMode)) return raw as PrReviewMode
  return "off"
}

/**
 * Resolve the per-deployment DO config from env vars. Pure; never
 * throws. `Env` import is type-only to avoid runtime cycles.
 */
export function resolveDoConfig(env: Env): ResolvedDoConfig {
  return {
    mode: resolveMode(env.OPENCLAW_PR_REVIEW_MODE),
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
    historyLimit: clampInt(
      env.OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT,
      DEFAULT_HISTORY_LIMIT,
      HISTORY_LIMIT_RANGE,
    ),
  }
}
