// Bedrock-ensemble migration — the single-shot EXTRACTOR model configs,
// relocated VERBATIM from `./model-provider.ts` to keep that adapter <=1k lines
// (the SIG-386 spill-sibling pattern; `model-provider.ts` re-exports them so
// importers + test paths are unchanged). Both extractors run on OpenRouter and
// are NOT steered by SIGILIX_ENSEMBLE_PROVIDER (they are cheap, fail-open,
// off-the-critical-path calls — migrating them buys ~nothing and adds risk).

import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"

/**
 * SIG-276 Phase 2: the write-time claim extractor. A cheap, single-shot classifier
 * (no retry, no fallback) over the final findings — fail-open by design, so a
 * capacity blip just yields no claims rather than burning the merge path.
 * SIG-406 alpha: on OpenRouter (`deepseek/deepseek-v4-flash`).
 */
export const CLAIM_EXTRACTOR_CONFIG: ModelConfig = {
  primary: "deepseek/deepseek-v4-flash",
  retries: 0,
  fallback: null,
}
/** Per-attempt cap for the claim extractor. Kept well under the
 *  specialist budget — the classifier prompt is small and the call is
 *  fail-open, so a slow model must not extend customer-visible latency. */
export const CLAIM_EXTRACTOR_TIMEOUT_MS = 25_000

/**
 * SIG-104 PR-2: the conversational learning extractor. Same cheap,
 * single-shot, fail-open shape as the claim extractor; a failed call just
 * means no durable learning is minted.
 */
export const LEARNING_EXTRACTOR_CONFIG: ModelConfig = {
  primary: "deepseek/deepseek-v4-flash",
  retries: 0,
  fallback: null,
}
export const LEARNING_EXTRACTOR_TIMEOUT_MS = 25_000

/**
 * Gardener P2: the memory-consolidation model. Same cheap, single-shot,
 * fail-open shape and SAME provider (OpenRouter `deepseek/deepseek-v4-flash`) as
 * the learning extractor — it is an off-the-critical-path Queue-consumer call, so
 * a failed call just means a cluster is left un-collapsed (recall-safe: the
 * originals stay). Not steered by SIGILIX_ENSEMBLE_PROVIDER.
 */
export const GARDENER_CONSOLIDATION_CONFIG: ModelConfig = {
  primary: "deepseek/deepseek-v4-flash",
  retries: 0,
  fallback: null,
}
export const GARDENER_CONSOLIDATION_TIMEOUT_MS = 25_000
