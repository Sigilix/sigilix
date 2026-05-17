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

/**
 * Batch-embed N texts in a single AI binding call. Returns vectors in
 * the same order as the input. Used by the ARC-235 indexer's streaming
 * pipeline (16 chunks per call). Validates response shape strictly:
 * - input length matches output length
 * - every vector has EMBEDDING_DIMENSIONS dims
 *
 * Codex MED catch on the design review: keep the shape parsing here
 * rather than duplicating it in `indexer.ts`. The Worker AI binding
 * returns the unwrapped `{ data, shape }` shape that this file already
 * validates for `embedText`; the local CLI script's `{ result: { data } }`
 * REST wrapping is NOT the binding shape, and a copy-paste of the CLI
 * parser into the indexer would silently break.
 */
export async function embedTexts(ai: AiBinding, texts: ReadonlyArray<string>): Promise<number[][]> {
  if (texts.length === 0) return []
  // code-reviewer M1 catch: validate emptiness via trim-length but pass
  // the ORIGINAL text to the embedder. Trimming silently would mean the
  // vector represents trimmed content while the indexer stores
  // untrimmed content in metadata — a small but real "what was indexed
  // vs. what gets retrieved" drift. Embedding models are insensitive
  // to leading/trailing whitespace at the tokenizer level, so passing
  // raw text changes the math by a rounding error and preserves the
  // index/retrieval pairing.
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i]?.trim()) {
      throw new Error(`embedTexts: empty input at index ${i}`)
    }
  }
  const result = await ai.run(EMBEDDING_MODEL, { text: [...texts] })
  const data = result.data
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `embedTexts: unexpected length — got ${Array.isArray(data) ? data.length : "non-array"}, want ${texts.length}`,
    )
  }
  for (let i = 0; i < data.length; i++) {
    const vec = data[i]
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedTexts: bad dims at index ${i} — got ${Array.isArray(vec) ? vec.length : "non-array"}, want ${EMBEDDING_DIMENSIONS}`,
      )
    }
  }
  return data
}
