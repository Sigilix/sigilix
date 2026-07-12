// Barrel for the model IO adapter — the provider-swap seam (SIG-381 / SIG-318).
// Exposes the call surface; consumers import `chat`/`generate` from here and the
// contract types from `shared/ports/model`, never a concrete provider module.
//
// OpenRouter migration: `chat` is now a ROUTER — it dispatches by model-id shape so a
// single ensemble can run mixed-provider (e.g. o3-logic on OpenRouter, others on
// Ollama). OpenRouter model ids contain a "/" ("openai/o3", "nvidia/nemotron-3-...");
// Ollama Turbo tags do not ("deepseek-v4-pro:cloud", "glm-5.1:cloud"). Until a config
// actually uses a slash-model, every call still resolves to Ollama — byte-identical to
// pre-migration. `generate` + embeddings are unchanged (Ollama / Workers AI).
//
// `ChatDisabledError` (the OLLAMA_CHAT_ENABLE kill-switch) remains an Ollama concern —
// consumers that handle it import it directly from `./ollama-chat`; this seam stays
// provider-agnostic.

import { generate } from "./ollama"
import { chat as ollamaChat } from "./ollama-chat"
import { chat as openrouterChat } from "./openrouter-chat"
import { chat as bedrockChat } from "./bedrock-chat"
import { embedText, embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embeddings"
import type { ChatArgs, ChatResult, ModelProviderPort } from "@/src/shared/ports/model"
import type { EmbeddingPort } from "@/src/shared/ports/embedding"

/**
 * True when `model` is an OpenRouter id (provider-prefixed with "/"), e.g.
 * "openai/o3", "nvidia/nemotron-3-ultra-550b-a55b". Ollama Turbo tags use ":cloud"
 * suffixes and no "/", so the test cleanly separates the two providers TODAY.
 *
 * Fragility: this is a shape heuristic, not a registry — it assumes no Ollama tag will
 * ever contain a "/". That holds for every tag we run; if it stops holding, replace
 * this with an explicit per-role provider field rather than widening the heuristic.
 *
 * This is the router heuristic AND the basis for per-call API-key selection: `chat`
 * (below) sends a slash-id to the OpenRouter adapter and a `:cloud` tag to Ollama, and
 * `selectConfigApiKey` (model-provider-routing) keys by the same shape — an OpenRouter id
 * resolves the OpenRouter key, a `:cloud` tag resolves the Ollama key. That shape routing
 * is what lets a local eval run hit Ollama Turbo (a `:cloud` model override → the Ollama
 * key, no OpenRouter spend) while prod runs all-OpenRouter.
 */
export function isOpenRouterModel(model: string): boolean {
  return model.includes("/")
}

/**
 * Bedrock-ensemble migration: the vendor/geo prefixes a Bedrock model id (or
 * cross-region inference profile) can start with. An explicit REGISTRY, not a
 * widened shape heuristic (per the fragility note above): a dot alone can't
 * separate providers — the Ollama tag "glm-5.1:cloud" carries a dot, and real
 * Bedrock ids can carry a ":" version suffix ("...-v1:0"), so neither character
 * is discriminating. The first dot-segment is unambiguous.
 */
const BEDROCK_ID_PREFIXES = new Set([
  // cross-region inference-profile geo prefixes ("us.anthropic.claude-sonnet-5")
  "us",
  "eu",
  "ap",
  "apac",
  "global",
  // model-id vendor prefixes ("deepseek.v3.2", "zai.glm-5", "nvidia.nemotron-super-3-120b")
  "anthropic",
  "deepseek",
  "zai",
  "nvidia",
  "mistral",
  "amazon",
  "meta",
  "ai21",
  "cohere",
])

/**
 * True when `model` is an AWS Bedrock id: no OpenRouter "/" and a first
 * dot-segment in the vendor/geo registry. Checked FIRST by the router below —
 * a Bedrock id never contains "/", and no Ollama tag's first dot-segment is a
 * Bedrock vendor. Basis for per-call key selection too (`selectModelApiKey`).
 */
export function isBedrockModel(model: string): boolean {
  if (model.includes("/")) return false
  const dot = model.indexOf(".")
  if (dot <= 0) return false
  return BEDROCK_ID_PREFIXES.has(model.slice(0, dot))
}

/**
 * Provider-routing chat: Bedrock-registry id → Bedrock adapter; OpenRouter-shaped
 * model → OpenRouter adapter; else Ollama. Same `ChatArgs → ChatResult` contract
 * regardless of provider.
 */
export function chat(args: ChatArgs): Promise<ChatResult> {
  if (isBedrockModel(args.model)) return bedrockChat(args)
  return isOpenRouterModel(args.model) ? openrouterChat(args) : ollamaChat(args)
}

export { generate, embedText, embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS }

/**
 * The active model provider. Consumers depending on the `ModelProviderPort` interface
 * use this singleton; `chat` is the provider-routing function above.
 */
export const modelProvider: ModelProviderPort = { generate, chat }

/**
 * The active embedding provider (Cloudflare Workers AI today). Symmetric with
 * `modelProvider`; embeddings swap independently of the LLM provider.
 */
export const embeddingProvider: EmbeddingPort = { embedText, embedTexts }
