// Vectorize-backed codebase retrieval. At triage / mention-reply time,
// embed the issue body (or asker's question) and pull top-K chunks from
// the index. Results are formatted as the [RELEVANT CODEBASE CHUNKS]
// section the prompt already expects.
//
// Multi-repo: the index uses one namespace per repo. The Linear team key
// on the incoming webhook decides which namespace to query. Without a
// known mapping we fall back to "rubberfit" (the first / primary repo,
// renamed from "rema-portal" on 2026-05-03) to keep one team's issues
// from silently returning zero context.

import { embedText } from "./embeddings"

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
}

interface RetrievalCtx {
  text: string
  teamKey: string | null
  env: RetrievalEnv
}

export interface RetrievedChunk {
  path: string
  lineStart: number
  lineEnd: number
  content: string
  score: number
}

/**
 * Map a Linear team key to a Vectorize namespace. Operator-overridable
 * via OPENCLAW_TEAM_REPO_MAP env var (JSON object, e.g.
 * `{"ARC":"rubberfit","RFD":"rubberfit-desktop"}`). Bad JSON falls
 * through to the default rather than crashing the triage pipeline —
 * a wrong namespace just produces zero matches, not an error.
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
  // Matches the convention scripts/index-repo.mjs uses (namespace=repo dir name).
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

  let queryVector: number[]
  try {
    queryVector = await embedText(ctx.env.AI, trimmed.slice(0, 4_000))
  } catch (error) {
    console.warn("retrieval embed failed", { error: String(error), namespace })
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
    return []
  }

  const out: RetrievedChunk[] = []
  for (const m of result.matches ?? []) {
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
      path: md.path,
      lineStart: md.lineStart,
      lineEnd: md.lineEnd,
      content: md.content,
      score: m.score,
    })
  }
  return out
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
    const block = `--- ${c.path}:${c.lineStart}-${c.lineEnd} (score=${c.score.toFixed(3)}) ---\n${slice}`
    if (total + block.length > MAX_TOTAL_CHARS) break
    parts.push(block)
    total += block.length
  }
  if (parts.length === 0) return null
  return parts.join("\n\n")
}
