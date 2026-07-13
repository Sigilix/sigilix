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
 *  runs them, and their estimate-only cost is now covered by the default.)
 *  EXCEPTION (2026-07-12): `deepseek-v4-pro:cloud` — the `logic` primary now runs
 *  on Ollama Turbo, so it IS a prod model and gets an explicit row (kept in sync
 *  with SPECIALIST_CONFIGS). Ollama reports no per-call cost, so this row is the
 *  estimate the cost roll-up bills; the rate mirrors the OpenRouter v4-pro list
 *  rate (same base model). Ollama Turbo is a flat subscription, so real marginal
 *  OpenRouter spend on logic is zero — this is a conservative accounting estimate. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "openai/o3": { inputPerMTokUsd: 2.0, outputPerMTokUsd: 8.0 }, // legacy logic (removed Aug 26 2026)
  "moonshotai/kimi-k2.7-code": { inputPerMTokUsd: 0.74, outputPerMTokUsd: 3.5 }, // prior logic (SIG-450); still a Bedrock/command fallback
  "deepseek/deepseek-v4-flash": { inputPerMTokUsd: 0.09, outputPerMTokUsd: 0.18 },
  "deepseek/deepseek-v4-pro": { inputPerMTokUsd: 0.435, outputPerMTokUsd: 0.87 },
  "deepseek-v4-pro:cloud": { inputPerMTokUsd: 0.435, outputPerMTokUsd: 0.87 }, // logic primary on Ollama Turbo (2026-07-12); mirrors the OpenRouter v4-pro rate
  "z-ai/glm-5.1": { inputPerMTokUsd: 0.98, outputPerMTokUsd: 3.08 },
  "nvidia/nemotron-3-ultra-550b-a55b": { inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5 },
  // ── AWS Bedrock (us-east-1 on-demand list rates, aws.amazon.com/bedrock/pricing,
  // verified 2026-07-12). Bedrock's Converse API reports token counts but NO
  // per-call cost, so — unlike OpenRouter — these rows are not a fallback: they
  // are THE price. `bedrock-chat.ts` computes `usage.costUsd` from this table via
  // `computeCostUsd` on every call; a Bedrock model missing here would silently
  // bill at `DEFAULT_PRICING` (over-estimate — visible, not hidden). Keep in sync
  // with the Bedrock lineup in `model-provider-bedrock.ts`.
  "deepseek.v3.2": { inputPerMTokUsd: 0.62, outputPerMTokUsd: 1.85 }, // security + tests
  "zai.glm-5": { inputPerMTokUsd: 1.0, outputPerMTokUsd: 3.2 }, // performance
  "nvidia.nemotron-super-3-120b": { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.65 }, // synth
  // Bedrock logic CANDIDATES only (Bedrock swap still gated on Anthropic access; the
  // shipped default logic model is `deepseek-v4-pro:cloud` on Ollama Turbo, priced above).
  // Claude Sonnet 5 rate is the PROMOTIONAL launch price (through Aug 31 2026) — revisit.
  "us.anthropic.claude-sonnet-5": { inputPerMTokUsd: 2.0, outputPerMTokUsd: 10.0 },
  "mistral.mistral-large-3-675b-instruct": { inputPerMTokUsd: 0.5, outputPerMTokUsd: 1.5 },
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

/**
 * Bedrock-ensemble migration: price a single call from its token counts. The
 * Bedrock adapter uses this to synthesize the `usage.costUsd` OpenRouter reports
 * natively — Bedrock returns NO cost, and a zero/absent cost here would flow a
 * $0 into `usage_ledger.cost_usd`, silently disarming the cost-enforcement gate
 * (`SIGILIX_RATE_LIMIT_MODE=enforce`). Missing token counts contribute 0 (the
 * caller omits `costUsd` entirely when BOTH counts are absent — never zero-fill).
 */
export function computeCostUsd(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number {
  const price = pricingForModel(model)
  return (
    ((inputTokens ?? 0) / 1_000_000) * price.inputPerMTokUsd +
    ((outputTokens ?? 0) / 1_000_000) * price.outputPerMTokUsd
  )
}
