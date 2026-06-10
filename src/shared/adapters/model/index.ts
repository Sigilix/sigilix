// Barrel for the model IO adapter — the provider-swap seam (SIG-381 / SIG-318).
// Re-exports the ACTIVE provider's call surface. To swap Ollama → OpenRouter,
// add the sibling adapter modules and flip these re-exports + `modelProvider`;
// consumers (which import the call surface from here, and the contract types
// from `shared/ports/model`) stay untouched.
//
// Deliberately provider-AGNOSTIC: it exposes `generate`/`chat`/embeddings + the
// `modelProvider` singleton, but NOT Ollama-specific failure modes. The
// `ChatDisabledError` kill-switch is an Ollama concern — the (few) consumers
// that handle it import it directly from `./ollama-chat`, keeping this seam
// swap-clean (no dead error symbol to strip when OpenRouter lands).

import { generate } from "./ollama"
import { chat } from "./ollama-chat"
import { embedText, embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embeddings"
import type { ModelProviderPort } from "@/src/shared/ports/model"
import type { EmbeddingPort } from "@/src/shared/ports/embedding"

export { generate, chat, embedText, embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS }

/**
 * The active model provider (Ollama today). Consumers that want to depend on the
 * `ModelProviderPort` interface (e.g. SIG-362) use this singleton; the
 * Ollama→OpenRouter swap reassigns it here, leaving consumers untouched. Named
 * generically (not `ollamaModelProvider`) so the symbol doesn't lie post-swap.
 */
export const modelProvider: ModelProviderPort = { generate, chat }

/**
 * The active embedding provider (Cloudflare Workers AI today). Symmetric with
 * `modelProvider`: gives consumers an `EmbeddingPort` to depend on, and
 * structurally locks the adapter against the port — a signature drift between
 * `embeddings.ts` and `EmbeddingPort` would fail to compile here. Embeddings
 * swap independently of the LLM provider.
 */
export const embeddingProvider: EmbeddingPort = { embedText, embedTexts }
