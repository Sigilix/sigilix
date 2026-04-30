// Cloudflare Workers AI embedding wrapper.
//
// Single model: @cf/baai/bge-base-en-v1.5 (768 dims, ~512 token context).
// The same model is used by the off-Worker indexer (scripts/index-repo.mjs)
// against Cloudflare's REST API. Mismatched embedding models would silently
// produce noise in retrieval — chunks indexed with model X are not
// comparable to query vectors from model Y, even at the same dimensionality.
//
// 512 token context is small for source code. Chunks are kept under
// MAX_CHUNK_LINES (~30) at index time so the embedder doesn't truncate
// them. Long inputs are silently truncated by the model — the indexer
// must guarantee shape, not this caller.

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"
export const EMBEDDING_DIMENSIONS = 768

interface AiBinding {
  run(
    model: string,
    input: { text: string | string[] }
  ): Promise<{ data?: number[][]; shape?: number[] }>
}

export async function embedText(ai: AiBinding, text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("embedText: empty input")
  }
  const result = await ai.run(EMBEDDING_MODEL, { text: trimmed })
  const first = result.data?.[0]
  if (!Array.isArray(first) || first.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedText: unexpected shape — got ${first?.length ?? "no"} dims, want ${EMBEDDING_DIMENSIONS}`
    )
  }
  return first
}
