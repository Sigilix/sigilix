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

/** OpenRouter published-rate FALLBACK table. Prod runs the ensemble on
 *  OpenRouter, so the provider reports an actual `usage.cost` per call and
 *  that measured figure is what `computeReviewCost` bills (SIG-417). These
 *  rows are only the fallback rate, used to *estimate* the cost of tokens
 *  that arrived with no reported cost — both in the post-hoc SLO roll-up
 *  and in the pre-flight cost projection / cost governor.
 *
 *  Keys are the OpenRouter model ids the ensemble passes to `chat()`, and
 *  the numbers are OpenRouter's PUBLISHED list rates (per-MTok, from the
 *  /models catalog). Keep this table in sync with `SPECIALIST_CONFIGS` /
 *  `SYNTHESIZER_CONFIG` / `CLAIM_EXTRACTOR_CONFIG` / `DISPATCHER_LLM_MODEL`
 *  (the dynamic-dispatcher.ts classifier).
 *
 *  Any model NOT listed here — including a local-eval `:cloud` override run
 *  against Ollama Turbo — falls back to `DEFAULT_PRICING`. (SIG-417 removed
 *  the legacy non-OpenRouter `:cloud` / Ollama estimate rows: prod no longer
 *  runs them, and their estimate-only cost is now covered by the default.) */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
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
