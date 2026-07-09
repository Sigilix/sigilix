// SIG-298 — env → clamped research run configuration. Pure: no IO, only reads
// string env fields + the per-run request options (model tier + effort) and
// normalizes them into safe numerics + per-role model ids. Every knob has a
// hard default so the engine never depends on unset env. The termination quad
// is `maxRounds` / `maxTimeMs` / `minRounds` / `maxEmptyRounds`.
//
// PRECEDENCE (addendum): the request's `effort` picks the DEFAULT budget tier
// and the request's `model` picks the DEFAULT heavy-role model id; an explicit
// env override (OPENCLAW_RESEARCH_*) ALWAYS wins over both. `minRounds` (2) and
// the empty-round kill (2) apply at every effort.

import type { Env } from "@/src/shared/types/env"
import type { ResearchConfig, ResearchEffort, ResearchModelConfig, ResearchTier } from "./types"

/** Fixed defaults that do not vary with effort (minRounds/empty-kill apply at
 *  every effort per the addendum). */
const FIXED_DEFAULTS = {
  minRounds: 2,
  maxEmptyRounds: 2,
  maxParallelFetches: 3,
  // Run-level cumulative token budget (loop-termination guard). Lifted 250k → 1M so
  // a chat/research run can fill the default heavy tier's real window (glm-5.2 ≈ 1M)
  // instead of stopping early. Env OPENCLAW_RESEARCH_TOKEN_BUDGET still overrides
  // (clamp [10k, 5M]) — this is a cost knob, not an endpoint ceiling.
  tokenBudget: 1_000_000,
  cleanupAfterMs: 60 * 60 * 1000, // ~1 hour after last activity
} as const

/** Effort → budget preset (the DEFAULT tier; env overrides still win). */
const EFFORT_PRESETS: Record<
  ResearchEffort,
  { maxRounds: number; maxQueriesPerRound: number; maxPagesPerRound: number; maxTimeMs: number }
> = {
  low: { maxRounds: 3, maxQueriesPerRound: 2, maxPagesPerRound: 3, maxTimeMs: 120_000 },
  medium: { maxRounds: 8, maxQueriesPerRound: 4, maxPagesPerRound: 5, maxTimeMs: 300_000 },
  high: { maxRounds: 12, maxQueriesPerRound: 5, maxPagesPerRound: 6, maxTimeMs: 480_000 },
}

/** Named model tier → DEFAULT model id for the HEAVY roles. Deep research routes
 *  every model call through OpenRouter (the OPENROUTER_API_KEY provider): these are
 *  OpenRouter catalog ids (provider-prefixed with "/"), which the model-adapter seam
 *  (`chat` → `isOpenRouterModel`) dispatches to OpenRouter — so the SELECTED tier's
 *  real model does the actual research. astraeus = the flagship reasoning default
 *  (GLM-5.2), pyroeis = the mid-tier (Gemini 3.5 Flash, switched from GLM per #812),
 *  boreas = the cheap tier (Qwen3-Next-80B, matching the gateway's forced Boreas model,
 *  tier). Each id is env-overridable via `SIGILIX_DEEPRESEARCH_<TIER>_MODEL` for a
 *  one-line flip. Ids verified present in the OpenRouter catalog
 *  (https://openrouter.ai/api/v1/models) on 2026-07-06. */
export const TIER_MODELS: Record<ResearchTier, string> = {
  boreas: "qwen/qwen3-next-80b-a3b-instruct",
  pyroeis: "google/gemini-3.5-flash",
  astraeus: "z-ai/glm-5.2",
}

/** Resolve a tier's default heavy-role model id, honoring its
 *  `SIGILIX_DEEPRESEARCH_<TIER>_MODEL` env override (trimmed non-empty wins). */
function resolveTierModel(env: Env, tier: ResearchTier): string {
  const override =
    tier === "boreas"
      ? env.SIGILIX_DEEPRESEARCH_BOREAS_MODEL
      : tier === "pyroeis"
        ? env.SIGILIX_DEEPRESEARCH_PYROEIS_MODEL
        : env.SIGILIX_DEEPRESEARCH_ASTRAEUS_MODEL
  return modelOr(override, TIER_MODELS[tier])
}

/** Per-run request options that steer config defaults. */
export interface ResearchRequestOptions {
  model?: ResearchTier
  effort?: ResearchEffort
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

/** Resolve the per-role model ids for a heavy tier + the cheap (Boreas) tier.
 *  Classification/extraction stay on Boreas regardless of the chosen tier
 *  (cheap) — unless the tier IS boreas, in which case everything is Boreas
 *  naturally. Per-role env overrides always win. */
function resolveModels(env: Env, tier: ResearchTier): ResearchModelConfig {
  const heavy = resolveTierModel(env, tier)
  const cheap = resolveTierModel(env, "boreas")
  return {
    planner: modelOr(env.OPENCLAW_RESEARCH_PLANNER_MODEL, heavy),
    synthesis: modelOr(env.OPENCLAW_RESEARCH_SYNTHESIS_MODEL, heavy),
    stopCheck: modelOr(env.OPENCLAW_RESEARCH_STOP_CHECK_MODEL, heavy),
    finalReport: modelOr(env.OPENCLAW_RESEARCH_FINAL_REPORT_MODEL, heavy),
    classify: modelOr(env.OPENCLAW_RESEARCH_CLASSIFY_MODEL, cheap),
    extract: modelOr(env.OPENCLAW_RESEARCH_EXTRACT_MODEL, cheap),
  }
}

/**
 * Resolve the run config from env + the per-run request options. `minRounds` is
 * additionally clamped to never exceed `maxRounds` so the floor can't outrun the
 * ceiling on a misconfig.
 */
export function resolveResearchConfig(env: Env, options: ResearchRequestOptions = {}): ResearchConfig {
  const tier: ResearchTier = options.model ?? "astraeus"
  const effort: ResearchEffort = options.effort ?? "medium"
  const preset = EFFORT_PRESETS[effort]

  const maxRounds = clampInt(env.OPENCLAW_RESEARCH_MAX_ROUNDS, preset.maxRounds, 1, 20)
  const minRounds = Math.min(maxRounds, clampInt(env.OPENCLAW_RESEARCH_MIN_ROUNDS, FIXED_DEFAULTS.minRounds, 1, 20))
  return {
    tier,
    effort,
    maxRounds,
    minRounds,
    maxTimeMs: clampInt(env.OPENCLAW_RESEARCH_MAX_TIME_MS, preset.maxTimeMs, 30_000, 600_000),
    maxEmptyRounds: clampInt(env.OPENCLAW_RESEARCH_MAX_EMPTY_ROUNDS, FIXED_DEFAULTS.maxEmptyRounds, 1, 10),
    maxQueriesPerRound: clampInt(env.OPENCLAW_RESEARCH_MAX_QUERIES_PER_ROUND, preset.maxQueriesPerRound, 1, 10),
    maxPagesPerRound: clampInt(env.OPENCLAW_RESEARCH_MAX_PAGES_PER_ROUND, preset.maxPagesPerRound, 1, 12),
    maxParallelFetches: clampInt(env.OPENCLAW_RESEARCH_MAX_PARALLEL_FETCHES, FIXED_DEFAULTS.maxParallelFetches, 1, 6),
    tokenBudget: clampInt(env.OPENCLAW_RESEARCH_TOKEN_BUDGET, FIXED_DEFAULTS.tokenBudget, 10_000, 5_000_000),
    cleanupAfterMs: clampInt(
      env.OPENCLAW_RESEARCH_CLEANUP_AFTER_MS,
      FIXED_DEFAULTS.cleanupAfterMs,
      60_000,
      24 * 60 * 60 * 1000,
    ),
    models: resolveModels(env, tier),
  }
}

/** Validate a raw model-tier value from a request; null when invalid. */
export function parseTier(raw: unknown): ResearchTier | null {
  return raw === "boreas" || raw === "pyroeis" || raw === "astraeus" ? raw : null
}

/** Validate a raw effort value from a request; null when invalid. */
export function parseEffort(raw: unknown): ResearchEffort | null {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : null
}
