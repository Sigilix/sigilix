// SIG-298 — env → clamped research run configuration. Pure: no IO, only reads
// string env fields and normalizes them into safe numerics + per-role model
// ids. Every knob has a hard default so the engine never depends on unset env.
// Follows the repo's OPENCLAW_* env-var convention.

import type { Env } from "@/src/shared/types/env"
import type { ResearchConfig, ResearchModelConfig } from "./types"

/** Termination-quad + budget defaults (spec §3). */
const DEFAULTS = {
  maxRounds: 8,
  maxTimeMs: 300_000,
  minRounds: 2,
  maxEmptyRounds: 2,
  maxQueriesPerRound: 4,
  maxPagesPerRound: 5,
  maxParallelFetches: 3,
  tokenBudget: 250_000,
  cleanupAfterMs: 60 * 60 * 1000, // ~1 hour after last activity
} as const

/** Default per-role model ids. Astraeus chain for reasoning-heavy roles; a
 *  cheaper tier (Boreas) for classify/extract. All env-overridable below. */
const DEFAULT_MODELS: ResearchModelConfig = {
  planner: "glm-5.2:cloud",
  synthesis: "glm-5.2:cloud",
  stopCheck: "glm-5.2:cloud",
  finalReport: "glm-5.2:cloud",
  classify: "gpt-oss:120b-cloud",
  extract: "gpt-oss:120b-cloud",
}

/** Parse a positive integer env value, clamped to [min, max]; default on junk. */
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/** A trimmed non-empty override, or the default. */
function modelOr(raw: string | undefined, def: string): string {
  const t = raw?.trim()
  return t ? t : def
}

/**
 * Resolve the run config from env. `minRounds` is additionally clamped to never
 * exceed `maxRounds` so the floor can't outrun the ceiling on a misconfig.
 */
export function resolveResearchConfig(env: Env): ResearchConfig {
  const maxRounds = clampInt(env.OPENCLAW_RESEARCH_MAX_ROUNDS, DEFAULTS.maxRounds, 1, 20)
  const minRounds = Math.min(maxRounds, clampInt(env.OPENCLAW_RESEARCH_MIN_ROUNDS, DEFAULTS.minRounds, 1, 20))
  return {
    maxRounds,
    minRounds,
    maxTimeMs: clampInt(env.OPENCLAW_RESEARCH_MAX_TIME_MS, DEFAULTS.maxTimeMs, 30_000, 600_000),
    maxEmptyRounds: clampInt(env.OPENCLAW_RESEARCH_MAX_EMPTY_ROUNDS, DEFAULTS.maxEmptyRounds, 1, 10),
    maxQueriesPerRound: clampInt(env.OPENCLAW_RESEARCH_MAX_QUERIES_PER_ROUND, DEFAULTS.maxQueriesPerRound, 1, 10),
    maxPagesPerRound: clampInt(env.OPENCLAW_RESEARCH_MAX_PAGES_PER_ROUND, DEFAULTS.maxPagesPerRound, 1, 12),
    maxParallelFetches: clampInt(env.OPENCLAW_RESEARCH_MAX_PARALLEL_FETCHES, DEFAULTS.maxParallelFetches, 1, 6),
    tokenBudget: clampInt(env.OPENCLAW_RESEARCH_TOKEN_BUDGET, DEFAULTS.tokenBudget, 10_000, 5_000_000),
    cleanupAfterMs: clampInt(
      env.OPENCLAW_RESEARCH_CLEANUP_AFTER_MS,
      DEFAULTS.cleanupAfterMs,
      60_000,
      24 * 60 * 60 * 1000,
    ),
    models: {
      planner: modelOr(env.OPENCLAW_RESEARCH_PLANNER_MODEL, DEFAULT_MODELS.planner),
      synthesis: modelOr(env.OPENCLAW_RESEARCH_SYNTHESIS_MODEL, DEFAULT_MODELS.synthesis),
      stopCheck: modelOr(env.OPENCLAW_RESEARCH_STOP_CHECK_MODEL, DEFAULT_MODELS.stopCheck),
      finalReport: modelOr(env.OPENCLAW_RESEARCH_FINAL_REPORT_MODEL, DEFAULT_MODELS.finalReport),
      classify: modelOr(env.OPENCLAW_RESEARCH_CLASSIFY_MODEL, DEFAULT_MODELS.classify),
      extract: modelOr(env.OPENCLAW_RESEARCH_EXTRACT_MODEL, DEFAULT_MODELS.extract),
    },
  }
}
