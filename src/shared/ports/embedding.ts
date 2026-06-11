// Port: the embedding-provider contract. Pure leaf, type-only. Cloudflare
// Workers AI (`@cf/baai/bge-base-en-v1.5`) backs it today; a different embed
// provider could implement this without touching consumers. Deliberately
// SEPARATE from `ModelProviderPort` (SIG-381): embeddings run on the Cloudflare
// `ai` binding, not the Ollama LLM provider, so the Ollama→OpenRouter swap never
// touches embeddings — and the Ollama adapter is never asked to embed. Imports
// nothing. The `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` value constants stay
// with the adapter (impl detail of the CF model), re-exported from its barrel.

/** Minimal shape of the Cloudflare Workers AI binding used for embeddings. */
export interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][]; shape?: number[] }>
}

export interface EmbeddingPort {
  embedText(ai: AiBinding, text: string): Promise<number[]>
  embedTexts(ai: AiBinding, texts: ReadonlyArray<string>): Promise<number[][]>
}
