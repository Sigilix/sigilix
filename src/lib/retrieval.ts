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
import { readRepoIndexManifestByNamespace } from "./repo-index-manifest"

const DEFAULT_NAMESPACE = "rubberfit"
const TOP_K = 6
const MAX_CHUNK_CHARS = 4_000
const MAX_TOTAL_CHARS = 18_000
// Cross-repo context (flag ON only). Per-sibling query depth is shallow so a
// sibling can't dominate; the folded total is hard-capped so the PR repo's own
// chunks stay the bulk of the context; sibling scores are down-weighted so the
// PR repo always ranks highest in the prompt ordering.
const CROSS_REPO_TOP_K = 3
const MAX_CROSS_REPO_CHUNKS = 3
const CROSS_REPO_SCORE_WEIGHT = 0.6

interface VectorizeMatch {
  id: string
  score: number
  metadata?: {
    repo?: string
    path?: string
    lineStart?: number
    lineEnd?: number
    content?: string
    headSha?: string
    runId?: string
  }
}

interface VectorizeIndex {
  query(
    vector: number[],
    options: { topK?: number; namespace?: string; returnMetadata?: "all" | "indexed" },
  ): Promise<{ matches: VectorizeMatch[] }>
}

interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][]; shape?: number[] }>
}

export interface RetrievalEnv {
  AI: AiBinding
  OPENCLAW_CODE_INDEX: VectorizeIndex
  OPENCLAW_TEAM_REPO_MAP?: string
  // SIG-45: hybrid lexical retrieval. Both optional — when absent or the
  // flag isn't "on", retrieval stays pure-vector.
  OPENCLAW_LEXICAL_INDEX?: D1Database
  OPENCLAW_RETRIEVAL_HYBRID?: string
  OPENCLAW_STATE?: KVNamespace
}

interface RetrievalCtx {
  text: string
  teamKey: string | null
  env: RetrievalEnv
  /**
   * Cross-repo context: sibling repo namespaces (same-installation, already
   * isolation-filtered by `resolveCrossRepoNamespaces`) to fold in as
   * lower-weighted, hard-capped context alongside the PR repo's own chunks.
   * Empty / undefined ⇒ unchanged single-repo behavior. This list is trusted
   * to be tenant-isolated by its producer; retrieval never derives it itself.
   */
  crossRepoNamespaces?: string[]
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
  /**
   * Cross-repo context: the sibling repo namespace this chunk came from when it
   * was retrieved from a repo OTHER than the PR's own. Unset ⇒ the PR repo. The
   * prompt formatter surfaces this so the model treats cross-repo snippets as
   * reference-only (never anchors a finding to a sibling repo's file).
   */
  repo?: string
  /** SIG-45: which backend(s) surfaced this chunk. Unset = legacy vector-only. */
  source?: "vector" | "lexical" | "hybrid"
  /** SIG-45: summed reciprocal-rank-fusion score (only set on the hybrid path). */
  rrfScore?: number
  /** Commit/ref the index says this chunk came from, formatted for prompts. */
  indexedRef?: string
  /** Full indexed commit SHA when known. */
  indexedHeadSha?: string
  /** Stable index run id when known. */
  indexRunId?: string
  /** current = chunk carried current manifest SHA; legacy = manifest-enriched only. */
  indexFreshness?: "current" | "legacy" | "unknown"
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

  const baseChunks = await queryNamespaceWithVector(ctx.env, namespace, queryVector, hybrid, lexicalPromise)

  // Cross-repo fold (flag ON only). The sibling list is already tenant-isolated
  // by its producer; here we just fan out the SAME embedding to each sibling
  // namespace, down-weight, and hard-cap the folded total so the PR repo stays
  // the weighted-highest bulk of the context. Empty list ⇒ single-repo behavior.
  const siblings = ctx.crossRepoNamespaces ?? []
  if (siblings.length === 0) return baseChunks
  return foldCrossRepoChunks(ctx.env, baseChunks, queryVector, siblings)
}

/**
 * Query a SINGLE namespace with an already-embedded vector and return ranked
 * chunks. Encapsulates the vector query + (optional) hybrid lexical fuse +
 * manifest enrichment for the PR repo's own namespace. A vector-query failure
 * soft-fails to the lexical leg (hybrid) or `[]` — the review still runs.
 */
async function queryNamespaceWithVector(
  env: RetrievalEnv,
  namespace: string,
  queryVector: number[],
  hybrid: boolean,
  lexicalPromise: Promise<LexicalMatch[]>,
): Promise<RetrievedChunk[]> {
  let result: { matches: VectorizeMatch[] }
  try {
    result = await env.OPENCLAW_CODE_INDEX.query(queryVector, {
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

  const vectorChunks = await enrichWithIndexReference(parseVectorMatches(result.matches), env, namespace)
  if (!hybrid) return vectorChunks

  const lexical = await lexicalPromise
  const enrichedLexical = await enrichWithIndexReference(lexicalToChunks(lexical), env, namespace)
  const fused = fuseRetrieval(vectorChunks, enrichedLexical, namespace)
  console.log(
    JSON.stringify({
      event: "pr-review-retrieval-hybrid",
      namespace,
      vectorHits: vectorChunks.length,
      lexicalHits: enrichedLexical.length,
      fused: fused.length,
    }),
  )
  return fused.slice(0, TOP_K)
}

/**
 * Fetch cross-repo context from the (already isolation-filtered) sibling
 * namespaces and fold it in AFTER the PR repo's own chunks. Sibling chunks are
 * vector-only (shallow `CROSS_REPO_TOP_K`), tagged with their origin `repo`,
 * and down-weighted (`CROSS_REPO_SCORE_WEIGHT`) so the PR repo ranks highest in
 * the prompt ordering; the folded total is hard-capped at `MAX_CROSS_REPO_CHUNKS`.
 */
async function foldCrossRepoChunks(
  env: RetrievalEnv,
  baseChunks: RetrievedChunk[],
  queryVector: number[],
  siblingNamespaces: string[],
): Promise<RetrievedChunk[]> {
  const results = await Promise.all(siblingNamespaces.map((ns) => retrieveSiblingChunks(env, ns, queryVector)))
  const crossRepo = results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CROSS_REPO_CHUNKS)
  if (crossRepo.length === 0) return baseChunks
  console.log(
    JSON.stringify({
      event: "pr-review-retrieval-cross-repo",
      siblings: siblingNamespaces.length,
      folded: crossRepo.length,
    }),
  )
  return [...baseChunks, ...crossRepo]
}

/** One sibling namespace, vector-only, tagged + down-weighted. Soft-fails to `[]`. */
async function retrieveSiblingChunks(
  env: RetrievalEnv,
  namespace: string,
  queryVector: number[],
): Promise<RetrievedChunk[]> {
  let result: { matches: VectorizeMatch[] }
  try {
    result = await env.OPENCLAW_CODE_INDEX.query(queryVector, {
      topK: CROSS_REPO_TOP_K,
      namespace,
      returnMetadata: "all",
    })
  } catch (error) {
    console.warn("cross-repo retrieval query failed", { error: String(error), namespace })
    return []
  }
  const chunks = await enrichWithIndexReference(parseVectorMatches(result.matches), env, namespace)
  return chunks.map((c) => ({ ...c, repo: namespace, score: c.score * CROSS_REPO_SCORE_WEIGHT }))
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
      ...(typeof md.headSha === "string" && md.headSha.length > 0 ? { indexedHeadSha: md.headSha } : {}),
      ...(typeof md.runId === "string" && md.runId.length > 0 ? { indexRunId: md.runId } : {}),
    })
  }
  return out
}

function lexicalToChunks(lexical: LexicalMatch[]): RetrievedChunk[] {
  return lexical.map((m) => ({
    id: m.id,
    path: m.path,
    lineStart: m.lineStart,
    lineEnd: m.lineEnd,
    content: m.content,
    score: m.score,
    source: "lexical",
  }))
}

async function enrichWithIndexReference(
  chunks: RetrievedChunk[],
  env: RetrievalEnv,
  namespace: string,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return chunks
  const manifest = await readManifestSoft(env, namespace)
  return chunks.map((chunk) => {
    const indexedHeadSha = chunk.indexedHeadSha ?? manifest?.headSha
    const indexRunId = chunk.indexRunId ?? manifest?.runId
    const indexedRef = chunk.indexedRef ?? formatIndexedRef(manifest, indexedHeadSha)
    const indexFreshness = chunk.indexFreshness ?? classifyFreshness(chunk.indexedHeadSha, manifest?.headSha)
    return {
      ...chunk,
      ...(indexedHeadSha ? { indexedHeadSha } : {}),
      ...(indexRunId ? { indexRunId } : {}),
      ...(indexedRef ? { indexedRef } : {}),
      ...(indexFreshness ? { indexFreshness } : {}),
    }
  })
}

async function readManifestSoft(
  env: RetrievalEnv,
  namespace: string,
): Promise<{ headSha: string; runId: string; branch?: string; defaultBranch?: string } | null> {
  if (!env.OPENCLAW_STATE) return null
  try {
    const result = await readRepoIndexManifestByNamespace({ OPENCLAW_STATE: env.OPENCLAW_STATE }, namespace)
    if (result.kind !== "ok") return null
    return {
      headSha: result.manifest.headSha,
      runId: result.manifest.runId,
      ...(result.manifest.branch ? { branch: result.manifest.branch } : {}),
      ...(result.manifest.defaultBranch ? { defaultBranch: result.manifest.defaultBranch } : {}),
    }
  } catch (error) {
    console.warn("retrieval manifest read failed", { error: String(error), namespace })
    return null
  }
}

function classifyFreshness(
  chunkHeadSha: string | undefined,
  manifestHeadSha: string | undefined,
): RetrievedChunk["indexFreshness"] {
  if (chunkHeadSha && manifestHeadSha && chunkHeadSha === manifestHeadSha) return "current"
  if (!chunkHeadSha && manifestHeadSha) return "legacy"
  return "unknown"
}

function formatIndexedRef(
  manifest: { headSha: string; branch?: string; defaultBranch?: string } | null,
  headSha: string | undefined,
): string | undefined {
  if (!headSha) return undefined
  const refName = manifest?.branch ?? manifest?.defaultBranch ?? "commit"
  return `${refName}@${headSha.slice(0, 7)}`
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
  lexical: RetrievedChunk[],
  namespace: string,
): RetrievedChunk[] {
  void namespace // reserved for future per-namespace tuning; keeps call sites stable
  const keyOf = (c: { id?: string; path: string; lineStart: number; lineEnd: number }): string =>
    c.id && c.id.length > 0 ? c.id : `${c.path}:${c.lineStart}-${c.lineEnd}`

  const vectorRanked: RankedItem<RetrievedChunk>[] = vector.map((c) => ({ key: keyOf(c), item: c }))
  const lexicalRanked: RankedItem<RetrievedChunk>[] = lexical.map((m) => ({ key: keyOf(m), item: m }))

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
  const ordered = orderChunksForPrompt(chunks)
  const parts: string[] = []
  let total = 0
  let kept = 0
  for (const c of ordered) {
    const truncated = c.content.length > MAX_CHUNK_CHARS
    const slice = truncated ? c.content.slice(0, MAX_CHUNK_CHARS) : c.content
    // SIG-45: on the hybrid path cite the RRF score + which signal surfaced
    // the chunk; legacy vector-only chunks (no `source`) keep `(score=X)` so
    // existing prompt expectations/tests are unchanged.
    const tag =
      c.source && c.rrfScore !== undefined
        ? `(${c.source}, rrf=${c.rrfScore.toFixed(4)})`
        : `(score=${c.score.toFixed(3)})`
    const freshness = formatFreshnessTag(c)
    // Cross-repo context: mark the origin repo so the model treats the snippet
    // as reference-only from ANOTHER repo (never anchors a finding to it).
    const repoTag = c.repo ? ` [repo=${c.repo}]` : ""
    // SIG-536 (P9): mark a capped snippet so the model knows it's partial — don't infer the
    // rest of the file from a truncated chunk (anti-fabrication).
    const trunc = truncated ? ` [truncated: first ${MAX_CHUNK_CHARS} of ${c.content.length} chars]` : ""
    const block = `--- ${c.path}:${c.lineStart}-${c.lineEnd} ${tag}${repoTag}${freshness}${trunc} ---\n${slice}`
    if (total + block.length > MAX_TOTAL_CHARS) break
    parts.push(block)
    total += block.length
    kept++
  }
  if (parts.length === 0) return null
  // SIG-536 (P9): if budget dropped lower-ranked chunks, say so — the slice is incomplete, so the
  // model should treat absence as "not retrieved", not "doesn't exist".
  const omitted = ordered.length - kept
  const footer =
    omitted > 0 ? `\n\n[+${omitted} more relevant chunk${omitted === 1 ? "" : "s"} omitted for context budget]` : ""
  return parts.join("\n\n") + footer
}

function formatFreshnessTag(c: RetrievedChunk): string {
  const fields: string[] = []
  if (c.indexedRef) fields.push(`indexed_ref=${c.indexedRef}`)
  if (c.indexFreshness) fields.push(`freshness=${c.indexFreshness}`)
  if (fields.length === 0) return ""
  return ` [${fields.join(", ")}]`
}

function orderChunksForPrompt(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => {
      // PR repo weighted highest: the PR's own chunks (no `repo` tag) ALWAYS
      // order before cross-repo sibling context, regardless of score. This
      // guarantees the code under review consumes the prompt char budget first
      // — a high-scoring sibling snippet can never evict a primary-repo chunk.
      const crossRepoDelta = crossRepoRank(a.chunk) - crossRepoRank(b.chunk)
      if (crossRepoDelta !== 0) return crossRepoDelta
      const scoreDelta = relevanceScore(b.chunk) - relevanceScore(a.chunk)
      if (Math.abs(scoreDelta) > 0.05) return scoreDelta
      return freshnessRank(a.chunk) - freshnessRank(b.chunk) || a.index - b.index
    })
    .map((entry) => entry.chunk)
}

/** 0 for the PR's own chunks, 1 for cross-repo sibling context (ordered last). */
function crossRepoRank(chunk: RetrievedChunk): number {
  return chunk.repo ? 1 : 0
}

function relevanceScore(chunk: RetrievedChunk): number {
  return chunk.rrfScore ?? chunk.score
}

function freshnessRank(chunk: RetrievedChunk): number {
  if (chunk.indexFreshness === "current") return 0
  if (chunk.indexFreshness === "legacy") return 1
  return 2
}
