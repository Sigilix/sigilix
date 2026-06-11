// SIG-376 (SIG-318 Tier-1 7/8): the embed/upsert streaming pipeline lifted
// out of `indexer.ts` so that file stays under the 1,000-line budget.
// `processSlice` + `embedBatch` + `dualWriteLexical` + `coverageByPath`
// relocate verbatim — bodies are byte-identical to their prior in-file
// definitions; only the surrounding `export` keywords + the import paths
// differ.
//
// Leaf module: value-imports the pure foundation from `indexer-internals.ts`
// (`chunkId`, `shouldSkipForLength`, `EMBED_BATCH`, `UPSERT_BATCH`,
// the `IndexableFile` type) — a one-directional leaf → leaf
// edge (internals ← slice). It does NOT value-import the core `indexer.ts`.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import { embedTexts } from "@/src/shared/adapters/model"
import { appendVectorCoverage } from "@/src/lib/repo-index-vectors"
import { upsertLexicalChunks, type LexicalChunk } from "@/src/lib/lexical-index"
import { extractFileGraph } from "@/src/lib/graph-extract"
import { writeFileGraph } from "@/src/lib/repo-graph-client"
import { graphIndexEnabled } from "@/src/lib/graph-flags"
import { type Chunk, chunkFile } from "@/src/lib/chunk-core"
import { chunkFileAst, jsTsExtOf } from "@/src/lib/ast-chunker"
import { isBranchStateRepo } from "@/src/lib/index-branch"
import {
  type IndexableFile,
  chunkId,
  shouldSkipForLength,
  EMBED_BATCH,
  UPSERT_BATCH,
} from "@/src/lib/indexer-internals"

interface ProcessSliceArgs {
  client: GitHubClient
  env: Env
  owner: string
  /** Actual GitHub repo name for file fetches. */
  repo: string
  /** KV/vector/lease identity; branch indexes differ from repo. */
  stateRepo: string
  namespace: string
  headSha: string
  runId: string
  files: ReadonlyArray<IndexableFile>
  astChunking: boolean
}

export interface ProcessSliceResult {
  /** Total chunks upserted across the slice. */
  chunkCount: number
  /** Path → ordered chunk ids accumulated for this slice. Used by
   *  ARC-238's uninstall delete to call `deleteByIds` later. */
  idsByPath: Record<string, string[]>
}

/** SIG-137: group an upsert batch's chunk ids by source path for the
 *  delete-coverage ledger write that precedes each Vectorize upsert. */
function coverageByPath(records: VectorizeRecord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of records) {
    const path = typeof r.metadata.path === "string" ? r.metadata.path : ""
    if (path.length === 0) continue
    ;(out[path] ??= []).push(r.id)
  }
  return out
}

export async function processSlice(args: ProcessSliceArgs): Promise<ProcessSliceResult> {
  const { client, env, owner, repo, stateRepo, namespace, headSha, runId, files } = args
  let chunkBuffer: Chunk[] = []
  const vectorBuffer: VectorizeRecord[] = []
  let totalChunks = 0
  const idsByPath: Record<string, string[]> = {}
  let astChunkFiles = 0
  let lineChunkFiles = 0
  let parseFallbackFiles = 0

  for (const file of files) {
    let content: string | null = null
    try {
      content = await client.getFileContent(owner, repo, file.path, headSha)
    } catch (err) {
      // Non-404 errors (rate limits, transient) re-throw so the queue
      // retries the slice. 404 returns null below.
      if (err instanceof GitHubHttpError && err.status !== 404 && err.status !== 403) {
        throw err
      }
      console.warn(
        JSON.stringify({
          event: "index-file-fetch-failed",
          owner,
          repo,
          path: file.path,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      continue
    }
    if (content === null) continue

    // SIG-138: graph write is best-effort and additive — any error here
    // logs + continues; the embedding/upsert pipeline is unaffected.
    if (!isBranchStateRepo(stateRepo) && graphIndexEnabled(env)) {
      try {
        const fg = extractFileGraph(file.path, content)
        await writeFileGraph(env, owner, repo, {
          runId,
          headSha,
          path: file.path,
          symbols: fg.symbols,
          fileEdgesRaw: fg.fileEdgesRaw,
          callEdges: fg.callEdges.map((c) => ({
            sourcePath: c.sourcePath,
            calleeName: c.calleeName,
            callKind: c.callKind,
            startLine: c.startLine,
            startCol: c.startCol,
          })),
        })
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "graph-write-failed",
            owner,
            repo,
            path: file.path,
            run_id: runId,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }

    // SIG-131: AST-aware chunking with line-window fallback.
    const ext = args.astChunking ? jsTsExtOf(file.path) : null
    let fileChunks: Chunk[]
    if (ext !== null) {
      const astChunks = chunkFileAst(file.path, content, ext)
      if (astChunks !== null) {
        fileChunks = astChunks
        astChunkFiles += 1
      } else {
        fileChunks = chunkFile(file.path, content) // parse failed → line-window
        parseFallbackFiles += 1
      }
    } else {
      fileChunks = chunkFile(file.path, content) // AST off or non-JS/TS
      lineChunkFiles += 1
    }
    chunkBuffer.push(...fileChunks)

    while (chunkBuffer.length >= EMBED_BATCH) {
      const batch = chunkBuffer.splice(0, EMBED_BATCH)
      const upserts = await embedBatch(env, batch, namespace)
      for (const record of upserts) {
        const path = typeof record.metadata.path === "string" ? record.metadata.path : ""
        if (path.length === 0) continue
        ;(idsByPath[path] ??= []).push(record.id)
      }
      vectorBuffer.push(...upserts)
      totalChunks += batch.length
      // Flush upsert batches as they fill.
      while (vectorBuffer.length >= UPSERT_BATCH) {
        const upBatch = vectorBuffer.splice(0, UPSERT_BATCH)
        // SIG-137: record ids in the delete-coverage ledger BEFORE upserting,
        // so a crash or mid-slice supersede can't leave a Vectorize entry that
        // isn't in the id-list (which would escape the GDPR uninstall delete).
        await appendVectorCoverage(env, owner, stateRepo, runId, coverageByPath(upBatch))
        await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
        await dualWriteLexical(env, upBatch) // SIG-45 — soft lexical mirror
      }
    }
  }

  // Drain remaining chunks.
  if (chunkBuffer.length > 0) {
    const upserts = await embedBatch(env, chunkBuffer, namespace)
    for (const record of upserts) {
      const path = typeof record.metadata.path === "string" ? record.metadata.path : ""
      if (path.length === 0) continue
      ;(idsByPath[path] ??= []).push(record.id)
    }
    vectorBuffer.push(...upserts)
    totalChunks += chunkBuffer.length
    chunkBuffer = []
  }
  // Drain remaining vectors.
  while (vectorBuffer.length > 0) {
    const upBatch = vectorBuffer.splice(0, UPSERT_BATCH)
    // SIG-137: coverage-before-upsert (see flush loop above).
    await appendVectorCoverage(env, owner, stateRepo, runId, coverageByPath(upBatch))
    await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
    await dualWriteLexical(env, upBatch) // SIG-45 — soft lexical mirror
  }

  console.log(
    JSON.stringify({
      event: "index-chunking",
      owner: args.owner,
      repo: args.repo,
      ast_on: args.astChunking,
      ast_chunk_files: astChunkFiles,
      line_chunk_files: lineChunkFiles,
      parse_fallback_files: parseFallbackFiles,
    }),
  )

  return { chunkCount: totalChunks, idsByPath }
}

interface VectorizeRecord {
  id: string
  values: number[]
  namespace: string
  metadata: Record<string, string | number>
}

/**
 * SIG-45: dual-write the just-upserted batch to the D1 FTS5 lexical mirror.
 * Gated only on the binding being present (NOT the read flag) so the lexical
 * index can be populated ahead of flipping OPENCLAW_RETRIEVAL_HYBRID on for
 * the A/B — you can't measure hybrid retrieval on an empty lexical corpus.
 *
 * Soft by design: `upsertLexicalChunks` swallows + logs its own failures and
 * we don't await-throw here. The Vectorize upsert and its delete-coverage
 * ledger (written BEFORE the upsert) remain the load-bearing GDPR path; a
 * lexical-mirror hiccup must never abort indexing or strand a vector that
 * escapes the uninstall delete.
 */
async function dualWriteLexical(env: Env, records: ReadonlyArray<VectorizeRecord>): Promise<void> {
  const db = env.OPENCLAW_LEXICAL_INDEX
  if (db == null || records.length === 0) return
  const chunks: LexicalChunk[] = []
  for (const r of records) {
    const path = typeof r.metadata.path === "string" ? r.metadata.path : ""
    const content = typeof r.metadata.content === "string" ? r.metadata.content : ""
    if (path.length === 0 || content.length === 0) continue
    chunks.push({
      id: r.id,
      namespace: r.namespace,
      path,
      lineStart: typeof r.metadata.lineStart === "number" ? r.metadata.lineStart : 0,
      lineEnd: typeof r.metadata.lineEnd === "number" ? r.metadata.lineEnd : 0,
      content,
    })
  }
  await upsertLexicalChunks(db, chunks)
}

async function embedBatch(env: Env, chunks: ReadonlyArray<Chunk>, namespace: string): Promise<VectorizeRecord[]> {
  const vectors = await embedTexts(
    env.AI,
    chunks.map((c) => c.content),
  )
  const out: VectorizeRecord[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const vec = vectors[i]!
    const id = await chunkId(namespace, chunk)
    if (shouldSkipForLength(id, namespace)) {
      console.error(
        JSON.stringify({
          event: "vector-upsert-length-exceeded",
          namespaceLength: namespace.length,
          idLength: id.length,
          namespaceSample: namespace.slice(0, 32),
          idSample: id.slice(0, 16),
          path: chunk.path,
        }),
      )
      continue
    }
    out.push({
      id,
      values: vec,
      namespace,
      metadata: {
        repo: namespace,
        path: chunk.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        content: chunk.content,
      },
    })
  }
  return out
}
