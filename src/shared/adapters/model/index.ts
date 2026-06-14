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
 * Provider-routing chat: OpenRouter-shaped model → OpenRouter adapter, else Ollama.
 * Same `ChatArgs → ChatResult` contract regardless of provider.
 */
export function chat(args: ChatArgs): Promise<ChatResult> {
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
