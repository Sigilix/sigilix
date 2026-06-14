// SIG-417 — the model token-pricing table (pure domain leaf).
//
// Carved out of `ensemble-slo-telemetry.ts` so BOTH the SLO cost roll-up
// (`computeReviewCost`) and the pure cost-projection domain module
// (`ensemble/domain/cost-projection.ts`) can read pricing WITHOUT a
// domain→lib import (the dependency rule — Codex SIG-417 sign-off). The SLO
// telemetry module re-exports these names, so its importers + tests are
// unchanged. Imports nothing (pure leaf).

/** USD per 1,000,000 tokens, split by direction. */
export interface ModelPricing {
  inputPerMTokUsd: number
  outputPerMTokUsd: number
}

/** Operator-maintained estimate. Keys match the `model` string the
 *  ensemble passes to `chat()` (e.g. `deepseek-v4-pro:cloud`). Keep this
 *  table in sync with `SPECIALIST_CONFIGS` / synth config when models
 *  change. Numbers are deliberately conservative cloud-inference
 *  estimates — used only as a FALLBACK when the provider didn't report an
 *  actual `usage.cost` (SIG-417). */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "deepseek-v4-pro:cloud": { inputPerMTokUsd: 0.6, outputPerMTokUsd: 1.7 },
  "kimi-k2.7-code:cloud": { inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.5 },
  "glm-5.1:cloud": { inputPerMTokUsd: 0.4, outputPerMTokUsd: 1.6 },
  "qwen3:cloud": { inputPerMTokUsd: 0.3, outputPerMTokUsd: 0.9 },
  "minimax:cloud": { inputPerMTokUsd: 0.3, outputPerMTokUsd: 1.1 },
  // SIG-392: the synth primary (swapped from gpt-oss:120b). gemma4:31b is the
  // SMALLEST model in the lineup (31B vs the 100-670B others), so it sits at
  // the low end of the estimate table. Without this row the synth's most-
  // frequent call fell through to DEFAULT_PRICING (0.6/2.5) — hiding the ~4×
  // per-call cost drop the swap measured. Estimate sized so the synth cost line
  // on the dashboard reflects the real drop, not the over-estimating default.
  "gemma4:31b": { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
  // SIG-406 alpha — the OpenRouter lineup. Unlike the rows above (conservative
  // cloud estimates), these are OpenRouter's PUBLISHED list rates (per-MTok, from
  // the /models catalog), so the cost dashboard reflects real OpenRouter spend.
  // Keep in sync with SPECIALIST_CONFIGS / SYNTHESIZER_CONFIG / CLAIM_EXTRACTOR_CONFIG
  // / DISPATCHER_LLM_MODEL (the dynamic-dispatcher.ts classifier).
  "openai/o3": { inputPerMTokUsd: 2.0, outputPerMTokUsd: 8.0 },
  "deepseek/deepseek-v4-flash": { inputPerMTokUsd: 0.09, outputPerMTokUsd: 0.18 },
  "deepseek/deepseek-v4-pro": { inputPerMTokUsd: 0.435, outputPerMTokUsd: 0.87 },
  "z-ai/glm-5.1": { inputPerMTokUsd: 0.98, outputPerMTokUsd: 3.08 },
  "nvidia/nemotron-3-ultra-550b-a55b": { inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5 },
}

/** Applied to any model not in `MODEL_PRICING`. Sized at the high end of
 *  the table so an untracked model over-estimates cost rather than
 *  hiding spend — a too-high number trips the budget alert (visible),
 *  a too-low one doesn't (silent). */
export const DEFAULT_PRICING: ModelPricing = {
  inputPerMTokUsd: 0.6,
  outputPerMTokUsd: 2.5,
}

export function pricingForModel(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING
}
