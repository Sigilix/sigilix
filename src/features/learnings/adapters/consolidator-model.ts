// Gardener P2: the memory-consolidation model call. Mirrors `extractor-model.ts`:
// a cheap, single-shot, fail-open OpenRouter call (`deepseek/deepseek-v4-flash`
// via GARDENER_CONSOLIDATION_CONFIG) that collapses one cleared cluster of
// near-duplicate rules into ONE canonical rule. A failed/unparsed call returns
// null — the caller keeps the originals (recall-safe).

import {
  GARDENER_CONSOLIDATION_CONFIG,
  GARDENER_CONSOLIDATION_TIMEOUT_MS,
  modelApiKeys,
  runWithRetryAndFallback,
  selectConfigApiKey,
} from "@/src/lib/triage-pr-review-ensemble"
import { FINDING_CATEGORIES } from "@/src/shared/domain/finding-category"
import { buildConsolidationPrompt, parseConsolidation } from "@/src/features/learnings/domain/consolidate-prompt"
import type { ConsolidationInput, ParsedConsolidation } from "@/src/features/learnings/domain/consolidate-prompt"
import type { Env } from "@/src/shared/types/env"

export interface RunConsolidationArgs {
  cluster: ReadonlyArray<ConsolidationInput>
  signal?: AbortSignal
}

const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    canonicalRule: { type: "string" },
    polarity: { type: "string", enum: ["suppress", "require", "context"] },
    category: { enum: [...FINDING_CATEGORIES, null] },
    pathGlob: { anyOf: [{ type: "string" }, { type: "null" }] },
    confidence: { type: "number" },
    mergedIds: { type: "array", items: { type: "string" } },
  },
  required: ["canonicalRule", "polarity", "confidence"],
} as const

/**
 * Run the Gardener consolidation model over one cleared cluster. Fail-open:
 * returns null on a missing key, a model error, or an unparsable answer — the
 * caller then leaves the cluster's originals untouched.
 */
export async function runConsolidation(env: Env, args: RunConsolidationArgs): Promise<ParsedConsolidation | null> {
  try {
    const apiKey = selectConfigApiKey(GARDENER_CONSOLIDATION_CONFIG, modelApiKeys(env))
    if (!apiKey) return null

    const { system, user } = buildConsolidationPrompt(args.cluster)
    const effectiveSignal = args.signal ?? new AbortController().signal

    const result = await runWithRetryAndFallback<ParsedConsolidation>({
      config: GARDENER_CONSOLIDATION_CONFIG,
      apiKey,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal: effectiveSignal,
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      format: CONSOLIDATION_SCHEMA as unknown as Record<string, unknown>,
      parseAnswer: parseConsolidation,
      parseFailureLabel: "gardener_consolidation_did_not_parse",
      startedAt: Date.now(),
      perAttemptTimeoutMs: GARDENER_CONSOLIDATION_TIMEOUT_MS,
    })
    return result.verdict
  } catch {
    return null
  }
}
