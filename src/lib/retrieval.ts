// Vectorize-backed codebase retrieval. At triage / mention-reply time,
// embed the issue body (or asker's question) and pull top-K chunks from
// the index. Results are formatted as the [RELEVANT CODEBASE CHUNKS]
// section the prompt already expects.
//
// Multi-repo: the index uses one namespace per repo. The Linear team key
// on the incoming webhook decides which namespace to query. With a
// missing team key we fall back to "rubberfit" (the first / primary repo,
// renamed from "rema-portal" on 2026-05-03). For unmapped team keys, we
// query the lowercased team key as the namespace.

import { embedText } from "@/src/shared/adapters/model"
import {
  hybridRetrievalEnabled,
  queryLexical,
  reciprocalRankFusion,
  type LexicalMatch,
  type RankedItem,
} from "./lexical-index"

const DEFAULT_NAMESPACE = "rubberfit"
const TOP_K = 6
const MAX_CHUNK_CHARS = 4_000
const MAX_TOTAL_CHARS = 18_000

interface VectorizeMatch {
  id: string
  score: number
  metadata?: {
    repo?: string
    path?: string
    lineStart?: number
    lineEnd?: number
    content?: string
  }
}

interface VectorizeIndex {
  query(
    vector: number[],
    options: { topK?: number; namespace?: string; returnMetadata?: "all" | "indexed" }
  ): Promise<{ matches: VectorizeMatch[] }>
}

interface AiBinding {
  run(
    model: string,
    input: { text: string | string[] }
  ): Promise<{ data?: number[][]; shape?: number[] }>
}

export interface RetrievalEnv {
  AI: AiBinding
  OPENCLAW_CODE_INDEX: VectorizeIndex
  OPENCLAW_TEAM_REPO_MAP?: string
  // SIG-45: hybrid lexical retrieval. Both optional — when absent or the
  // flag isn't "on", retrieval stays pure-vector.
  OPENCLAW_LEXICAL_INDEX?: D1Database
  OPENCLAW_RETRIEVAL_HYBRID?: string
}

interface RetrievalCtx {
  text: string
  teamKey: string | null
  env: RetrievalEnv
}

export interface RetrievedChunk {
  /**
   * SIG-45: the Vectorize/lexical chunk id (the deterministic `chunkId`).
   * Optional for back-compat with callers that build chunks by hand;
   * present for index-sourced chunks so hybrid RRF can dedupe across the
   * vector and lexical backends.
   */
  id?: string
  path: string
  lineStart: number
  lineEnd: number
  content: string
  score: number
  /** SIG-45: which backend(s) surfaced this chunk. Unset = legacy vector-only. */
  source?: "vector" | "lexical" | "hybrid"
  /** SIG-45: summed reciprocal-rank-fusion score (only set on the hybrid path). */
  rrfScore?: number
}

/**
 * Map a Linear team key to a Vectorize namespace. Operator-overridable
 * via OPENCLAW_TEAM_REPO_MAP env var (JSON object).
 *
 * SIG-132: the Vectorize namespace is now `<owner>/<repo>` lowercased
 * (multi-tenant isolation). Map VALUES must therefore be `owner/repo`,
 * e.g. `{"ARC":"sigilix/rubberfit","RFD":"sigilix/rubberfit-desktop"}`.
 * Stale single-segment values (e.g. `"rubberfit"`) will simply produce
 * zero retrieval matches against the new `<owner>/<repo>` namespaces.
 *
 * The fallback (no map entry) lowercases the bare team key — which does
 * NOT yield a valid `<owner>/<repo>` namespace, so an unmapped team gets
 * zero matches and the prompt instructs the model to abstain. Operators
 * should populate the map with `owner/repo` values for every team whose
 * indexed repo they want grounded. Bad JSON falls through to the default
 * rather than crashing the triage pipeline.
 */
export function teamKeyToNamespace(teamKey: string | null, mapJson?: string): string {
  if (!teamKey) return DEFAULT_NAMESPACE
  if (mapJson) {
    try {
      const map = JSON.parse(mapJson) as Record<string, unknown>
      if (
        map &&
        typeof map === "object" &&
        !Array.isArray(map) &&
        typeof map[teamKey] === "string" &&
        (map[teamKey] as string).trim().length > 0
      ) {
        return (map[teamKey] as string).trim()
      }
    } catch {
      // Bad JSON — fall through to default
    }
  }
  // No explicit mapping — use the team key itself, lowercased.
  // Prefer OPENCLAW_TEAM_REPO_MAP for modern repo namespaces (`owner/repo`).
  return teamKey.toLowerCase()
}

/**
 * Run retrieval for a given input text. Returns ranked chunks ready to
 * inject into a prompt. Empty array when retrieval fails or returns no
 * usable matches — callers should treat this as a soft failure (the
 * triage / mention-reply still runs, the model just gets no codebase
 * context and is instructed to abstain rather than fabricate).
 */
export async function retrieveChunks(ctx: RetrievalCtx): Promise<RetrievedChunk[]> {
  const trimmed = ctx.text.trim()
  if (!trimmed) return []

  const namespace = teamKeyToNamespace(ctx.teamKey, ctx.env.OPENCLAW_TEAM_REPO_MAP)
  const hybrid = hybridRetrievalEnabled(ctx.env)

  // SIG-45: when hybrid is on, the lexical leg needs no embedding, so kick it
  // off in parallel with the vector embed+query rather than serializing.
  const lexicalPromise: Promise<LexicalMatch[]> = hybrid
    ? queryLexical(ctx.env.OPENCLAW_LEXICAL_INDEX!, namespace, trimmed, TOP_K)
    : Promise.resolve([])

  let queryVector: number[]
  try {
    queryVector = await embedText(ctx.env.AI, trimmed.slice(0, 4_000))
  } catch (error) {
    console.warn("retrieval embed failed", { error: String(error), namespace })
    // Vector leg failed — fall back to whatever the lexical leg returns so
    // hybrid degrades to lexical-only rather than to nothing.
    if (hybrid) {
      const lexical = await lexicalPromise
      return lexical.length > 0 ? fuseRetrieval([], lexical, namespace) : []
    }
    return []
  }

  let result: { matches: VectorizeMatch[] }
  try {
    result = await ctx.env.OPENCLAW_CODE_INDEX.query(queryVector, {
      topK: TOP_K,
      namespace,
      returnMetadata: "all",
    })
  } catch (error) {
    console.warn("retrieval query failed", { error: String(error), namespace })
    if (hybrid) {
      const lexical = await lexicalPromise
      return lexical.length > 0 ? fuseRetrieval([], lexical, namespace) : []
    }
    return []
  }

  const vectorChunks = parseVectorMatches(result.matches)
  if (!hybrid) return vectorChunks

  const lexical = await lexicalPromise
  const fused = fuseRetrieval(vectorChunks, lexical, namespace)
  console.log(JSON.stringify({
    event: "pr-review-retrieval-hybrid",
    namespace,
    vectorHits: vectorChunks.length,
    lexicalHits: lexical.length,
    fused: fused.length,
  }))
  return fused.slice(0, TOP_K)
}

/** Map raw Vectorize matches to RetrievedChunks, carrying the chunk id. */
function parseVectorMatches(matches: VectorizeMatch[] | undefined): RetrievedChunk[] {
  const out: RetrievedChunk[] = []
  for (const m of matches ?? []) {
    const md = m.metadata
    if (
      !md ||
      typeof md.path !== "string" ||
      typeof md.lineStart !== "number" ||
      typeof md.lineEnd !== "number" ||
      typeof md.content !== "string"
    ) {
      continue
    }
    out.push({
      id: m.id,
      path: md.path,
      lineStart: md.lineStart,
      lineEnd: md.lineEnd,
      content: md.content,
      score: m.score,
      source: "vector",
    })
  }
  return out
}

/**
 * SIG-45: fuse the vector and lexical result lists via reciprocal-rank
 * fusion. Dedup key is the chunk id when present (same `chunkId` scheme on
 * both backends) else `path:lineStart-lineEnd`. The vector list is passed
 * first so a chunk present in both keeps its vector payload (cosine score)
 * and a same-RRF tie breaks toward the semantic hit. `source` records which
 * backend(s) surfaced each chunk so specialists can see the signal.
 */
export function fuseRetrieval(
  vector: RetrievedChunk[],
  lexical: LexicalMatch[],
  namespace: string,
): RetrievedChunk[] {
  void namespace // reserved for future per-namespace tuning; keeps call sites stable
  const keyOf = (c: { id?: string; path: string; lineStart: number; lineEnd: number }): string =>
    c.id && c.id.length > 0 ? c.id : `${c.path}:${c.lineStart}-${c.lineEnd}`

  const vectorRanked: RankedItem<RetrievedChunk>[] = vector.map((c) => ({ key: keyOf(c), item: c }))
  const lexicalRanked: RankedItem<RetrievedChunk>[] = lexical.map((m) => ({
    key: keyOf(m),
    item: {
      id: m.id,
      path: m.path,
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
      content: m.content,
      score: m.score,
      source: "lexical",
    },
  }))

  const inVector = new Set(vectorRanked.map((r) => r.key))
  const inLexical = new Set(lexicalRanked.map((r) => r.key))

  return reciprocalRankFusion<RetrievedChunk>([vectorRanked, lexicalRanked]).map((f) => {
    const key = keyOf(f.item)
    const source: RetrievedChunk["source"] =
      inVector.has(key) && inLexical.has(key) ? "hybrid" : inVector.has(key) ? "vector" : "lexical"
    return { ...f.item, source, rrfScore: f.rrfScore }
  })
}

/**
 * Format chunks into the prompt section the triage / mention-reply prompts
 * already document. Imposes per-chunk and total-chars caps so a single
 * outlier doesn't blow out the model's context window. Returns null when
 * there's nothing to inject so the caller can skip the section cleanly.
 */
export function formatChunksForPrompt(chunks: RetrievedChunk[]): string | null {
  if (chunks.length === 0) return null
  const parts: string[] = []
  let total = 0
  for (const c of chunks) {
    const slice = c.content.length > MAX_CHUNK_CHARS ? c.content.slice(0, MAX_CHUNK_CHARS) : c.content
    // SIG-45: on the hybrid path cite the RRF score + which signal surfaced
    // the chunk; legacy vector-only chunks (no `source`) keep `(score=X)` so
    // existing prompt expectations/tests are unchanged.
    const tag =
      c.source && c.rrfScore !== undefined
        ? `(${c.source}, rrf=${c.rrfScore.toFixed(4)})`
        : `(score=${c.score.toFixed(3)})`
    const block = `--- ${c.path}:${c.lineStart}-${c.lineEnd} ${tag} ---\n${slice}`
    if (total + block.length > MAX_TOTAL_CHARS) break
    parts.push(block)
    total += block.length
  }
  if (parts.length === 0) return null
  return parts.join("\n\n")
}
