import {
  LEARNING_EXTRACTOR_CONFIG,
  LEARNING_EXTRACTOR_TIMEOUT_MS,
  modelApiKeys,
  runWithRetryAndFallback,
  selectConfigApiKey,
} from "@/src/lib/triage-pr-review-ensemble"
import { buildExtractionPrompt, parseExtraction } from "@/src/features/learnings/domain/extractor"
import type { ExtractedLearning, ExtractionSurface } from "@/src/features/learnings/domain/extractor"
import { FINDING_CATEGORIES } from "@/src/shared/domain/finding-category"
import type { Env } from "@/src/shared/types/env"

export interface ExtractLearningArgs {
  surface: ExtractionSurface
  replyText: string
  findingContext?: string
  changedPaths?: string[]
  signal?: AbortSignal
}

const LEARNING_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    remember: { type: "boolean" },
    rule: { type: "string" },
    polarity: { type: "string", enum: ["suppress", "require", "context"] },
    category: { enum: [...FINDING_CATEGORIES, null] },
    pathGlob: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["remember"],
} as const

export async function extractLearning(env: Env, args: ExtractLearningArgs): Promise<ExtractedLearning | null> {
  try {
    const apiKey = selectConfigApiKey(LEARNING_EXTRACTOR_CONFIG, modelApiKeys(env))
    if (!apiKey) return null

    const { signal, ...promptArgs } = args
    const { system, user } = buildExtractionPrompt(promptArgs)
    const effectiveSignal = signal ?? new AbortController().signal

    const result = await runWithRetryAndFallback<ExtractedLearning>({
      config: LEARNING_EXTRACTOR_CONFIG,
      apiKey,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal: effectiveSignal,
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      format: LEARNING_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      parseAnswer: parseExtraction,
      parseFailureLabel: "learning_extractor_did_not_parse",
      startedAt: Date.now(),
      perAttemptTimeoutMs: LEARNING_EXTRACTOR_TIMEOUT_MS,
    })
    return result.verdict
  } catch {
    return null
  }
}
