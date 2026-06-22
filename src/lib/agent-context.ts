// SIG-494 (Sigilix CLI Agent — grounded retrieval) — the keystone of the cost moat.
//
// Compose the SAME index + graph primitives the @-mention Q&A path already uses
// (retrieveChunks → expandHitsToSymbols) into ONE packed context for a single agent
// turn, so the agent gets review-identical grounding instead of exploring the repo
// blind. The whole bet: injecting a small, precise slice costs fewer tokens than the
// model grepping/reading its way to the same code — and we MEASURE that delta before
// building anything else out (the A1 harness compares blind vs. grounded).
//
// Display-/grounding-only: this never gates the agent. Empty query, no index match, or
// no graph → `context: null` and the agent simply proceeds without grounding (the
// honest blind baseline) — it must NEVER fabricate context or fail the turn.

import { retrieveChunks, formatChunksForPrompt, type RetrievedChunk } from "./retrieval"
import { expandHitsToSymbols, hitKey } from "./symbol-expansion"
import type { Env } from "@/src/shared/types/env"

export interface AgentContextArgs {
  owner: string
  repo: string
  /** The turn's intent / query (free text). */
  query: string
  env: Env
  /** Bounded file-content fetcher (e.g. `GitHubClient.getFileContent`) used by the
   *  graph expander for definition + cross-file caller/importer bodies. Soft-fails. */
  fetchFileContent: (path: string) => Promise<string | null>
  signal?: AbortSignal
  /** Byte cap on the symbol-expansion body build (passed through to the expander). */
  maxBytes?: number
}

export interface AgentContextTelemetry {
  namespace: string
  chunkCount: number
  graphAvailable: boolean
  symbolsExpanded: number
  callersRendered: number
  superseded: number
  contextChars: number
}

export interface AgentContextResult {
  /** Packed grounded-context string ready to inject pre-turn; null when nothing grounded. */
  context: string | null
  telemetry: AgentContextTelemetry
}

/** Vectorize namespace for a repo (SIG-132: `<owner>/<repo>` lowercased). */
export function indexNamespaceFor(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase()
}

function emptyResult(namespace: string): AgentContextResult {
  return {
    context: null,
    telemetry: {
      namespace,
      chunkCount: 0,
      graphAvailable: false,
      symbolsExpanded: 0,
      callersRendered: 0,
      superseded: 0,
      contextChars: 0,
    },
  }
}

/**
 * Gather grounded context for one agent turn: semantic index hits + graph symbol
 * expansion (enclosing definitions, callers, importers), packed for injection. The
 * symbol block supersedes the raw chunk slices it already contains, so we drop those
 * raw chunks — duplicating bytes would inflate the agent's context window, defeating
 * the token win.
 */
export async function gatherAgentContext(args: AgentContextArgs): Promise<AgentContextResult> {
  const namespace = indexNamespaceFor(args.owner, args.repo)

  const query = args.query.trim()
  if (!query) return emptyResult(namespace)

  // retrieveChunks soft-fails to [] (embed/query error, unindexed namespace) — that's
  // the blind baseline, never a thrown turn.
  const chunks: RetrievedChunk[] = await retrieveChunks({ text: query, teamKey: namespace, env: args.env })
  if (chunks.length === 0) return emptyResult(namespace)

  // Graph expansion (SIG-407): enclosing symbol bodies + caller/importer rows. Soft-
  // fails to `{ block: null }` when no active graph version / the fetcher fails.
  const expansion = await expandHitsToSymbols({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    hits: chunks,
    fetchFileContent: args.fetchFileContent,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
  })

  // Drop raw chunks whose span is already contained by a rendered symbol body.
  const superseded = new Set(expansion.supersededHitKeys)
  const rawChunks = chunks.filter((c) => !superseded.has(hitKey(c)))
  const rawBlock = formatChunksForPrompt(rawChunks)

  const sections: string[] = []
  if (expansion.block) sections.push(expansion.block)
  if (rawBlock) sections.push(rawBlock)
  const context = sections.length > 0 ? sections.join("\n\n") : null

  return {
    context,
    telemetry: {
      namespace,
      chunkCount: chunks.length,
      graphAvailable: expansion.telemetry.graphAvailable,
      symbolsExpanded: expansion.telemetry.symbolsExpanded,
      callersRendered: expansion.telemetry.callersRendered,
      superseded: expansion.telemetry.superseded,
      contextChars: context ? context.length : 0,
    },
  }
}
