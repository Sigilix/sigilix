// Agent-memory store — Vectorize + embedding layer.
//
// Tenant isolation is the Vectorize NAMESPACE, not a metadata filter: every
// vector for (userId, repoId) lives under `<userId>/<repoId>` lowercased, and a
// query in that namespace can only ever match vectors written to it. This is the
// same isolation mechanism the code index uses (`<owner>/<repo>` lowercased,
// SIG-132) and is structurally stronger than a post-filter (a missed filter can
// leak; a namespace can't).
//
// The embedder is the shared Workers AI BGE model (768-dim, cosine) reused from
// the code index, so the same `boreas-agent-memory` index dimensionality matches.
//
// Soft by design: the RETRIEVAL path (embed + query) never throws into the
// request — an embed/query failure returns [] (an honest "no memory available",
// the agent proceeds blind), telemetered. The WRITE path (embed + upsert)
// returns a boolean so the route can still persist the record to KV and report a
// degraded `stored` flag rather than 500ing.

import { embedText, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { AgentMemoryKind } from "./types"
import { ALL_AGENT_MEMORY_KINDS } from "./types"

// Max chars fed to the embedder — matches the retrieval.ts code-index cap
// (the BGE model truncates beyond its ~512-token window anyway).
const MAX_EMBED_CHARS = 4_000

interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][]; shape?: number[] }>
}

/** Minimal Vectorize binding shape (write + read). Mirrors the local interfaces
 *  the code-index modules declare against the generated `VectorizeIndex`. */
interface VectorizeUpsertRecord {
  id: string
  values: number[]
  namespace: string
  metadata: Record<string, string | number>
}

interface VectorizeMatch {
  id: string
  score: number
  metadata?: { kind?: string; ts?: string }
}

interface AgentMemoryVectorIndex {
  upsert(vectors: VectorizeUpsertRecord[]): Promise<unknown>
  query(
    vector: number[],
    options: { topK?: number; namespace?: string; returnMetadata?: "all" | "indexed" },
  ): Promise<{ matches: VectorizeMatch[] }>
  deleteByIds(ids: string[]): Promise<unknown>
}

export interface AgentMemoryRetrievalEnv {
  AI: AiBinding
  OPENCLAW_AGENT_MEMORY_INDEX: AgentMemoryVectorIndex
}

/**
 * The tenant Vectorize namespace = `<userId>/<repoId>` lowercased. The single
 * isolation boundary — every write + query is scoped to it, so a query can never
 * surface another tenant's memory.
 */
export function memoryNamespace(userId: string, repoId: string): string {
  return `${userId}/${repoId}`.toLowerCase()
}

/** Hit returned by `queryMemoryIds` — the vector id + score + metadata the route
 *  uses to order (by ts) + hydrate the full record from KV. */
export interface MemoryVectorHit {
  id: string
  score: number
  ts?: string
  kind?: AgentMemoryKind
}

/**
 * Embed `content` and upsert one vector under the tenant namespace, with
 * `{ kind, ts }` in metadata. Returns true on success. Soft: an embed or upsert
 * failure returns false (telemetered) so the caller can still KV-persist the
 * record and report a degraded `stored` flag. Never throws.
 */
export async function upsertMemoryVector(
  env: AgentMemoryRetrievalEnv,
  args: { id: string; userId: string; repoId: string; kind: AgentMemoryKind; content: string; ts: string },
): Promise<boolean> {
  const namespace = memoryNamespace(args.userId, args.repoId)
  let vector: number[]
  try {
    vector = await embedText(env.AI, args.content.slice(0, MAX_EMBED_CHARS))
  } catch (err) {
    emitTelemetry("agent-memory-embed-failed", { namespace, stage: "write", err: errMsg(err) })
    return false
  }
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    emitTelemetry("agent-memory-embed-failed", { namespace, stage: "write", reason: "bad-dims", dims: vector.length })
    return false
  }
  try {
    await env.OPENCLAW_AGENT_MEMORY_INDEX.upsert([
      { id: args.id, values: vector, namespace, metadata: { kind: args.kind, ts: args.ts } },
    ])
    return true
  } catch (err) {
    emitTelemetry("agent-memory-upsert-failed", { namespace, err: errMsg(err) })
    return false
  }
}

/**
 * Embed `query`, run a topK semantic query under the tenant namespace, and return
 * the raw vector hits (id + score + `{ kind, ts }` metadata). Soft: an empty
 * query, embed failure, or query failure returns [] (telemetered) so the route
 * answers `{ results: [] }` (200), never 500. Never throws.
 */
export async function queryMemoryIds(
  env: AgentMemoryRetrievalEnv,
  args: { userId: string; repoId: string; query: string; topK: number },
): Promise<MemoryVectorHit[]> {
  const namespace = memoryNamespace(args.userId, args.repoId)
  const trimmed = args.query.trim()
  if (!trimmed) return []

  let vector: number[]
  try {
    vector = await embedText(env.AI, trimmed.slice(0, MAX_EMBED_CHARS))
  } catch (err) {
    emitTelemetry("agent-memory-embed-failed", { namespace, stage: "query", err: errMsg(err) })
    return []
  }

  let result: { matches: VectorizeMatch[] }
  try {
    result = await env.OPENCLAW_AGENT_MEMORY_INDEX.query(vector, {
      topK: args.topK,
      namespace,
      returnMetadata: "all",
    })
  } catch (err) {
    emitTelemetry("agent-memory-query-failed", { namespace, err: errMsg(err) })
    return []
  }

  const hits: MemoryVectorHit[] = []
  for (const m of result.matches ?? []) {
    if (typeof m.id !== "string" || m.id === "") continue
    hits.push({
      id: m.id,
      score: typeof m.score === "number" ? m.score : 0,
      ...(typeof m.metadata?.ts === "string" ? { ts: m.metadata.ts } : {}),
      ...(isMemoryKind(m.metadata?.kind) ? { kind: m.metadata.kind } : {}),
    })
  }
  return hits
}

/**
 * Best-effort delete of one memory's vector by its id (the record id — the same
 * value {@link upsertMemoryVector} used). SOFT: a delete failure (or an absent /
 * incompatible binding) returns false, telemetered — a stale vector is recall-safe
 * (its KV record is gone, so a query hit hydrates to null and is dropped) and must
 * never fail the caller's KV delete. Never throws.
 */
export async function deleteMemoryVector(env: AgentMemoryRetrievalEnv, id: string): Promise<boolean> {
  try {
    await env.OPENCLAW_AGENT_MEMORY_INDEX.deleteByIds([id])
    return true
  } catch (err) {
    emitTelemetry("agent-memory-vector-delete-failed", { id, err: errMsg(err) })
    return false
  }
}

function isMemoryKind(value: unknown): value is AgentMemoryKind {
  return typeof value === "string" && (ALL_AGENT_MEMORY_KINDS as readonly string[]).includes(value)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}
