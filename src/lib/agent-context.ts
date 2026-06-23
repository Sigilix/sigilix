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
import { buildRepoMapBlock } from "./repo-map"
import type { Env } from "@/src/shared/types/env"

// Section separator between the symbol block and the raw-chunk block.
const SECTION_SEP = "\n\n"
// Default char budget for the whole packed slice. Bounds over-injection so grounding
// can't cost the agent materially more than reading the code itself on a narrow query
// (the A1 measurement finding); tunable per call via maxContextChars.
const DEFAULT_CONTEXT_BUDGET = 6000
// SIG-527: how many central symbols to request for the repo map before the render's
// own char cap trims them. Generous — the ~1200-char map budget is the real bound.
const DEFAULT_REPO_MAP_LIMIT = 40

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
  /** Char budget for the whole packed slice (do-no-harm: grounding never injects more
   *  than this — bounds over-injection on narrow queries). Defaults to DEFAULT_CONTEXT_BUDGET. */
  maxContextChars?: number
  /** Readable "team conventions / past decisions" (Phase B negative memory) — the repo's
   *  review learnings (each a one-line rule). Injected first, capped to a slice of the
   *  budget so they never crowd out code. Recall-safe: they BIAS the agent, never suppress. */
  learnings?: readonly string[]
}

export interface AgentContextTelemetry {
  namespace: string
  chunkCount: number
  graphAvailable: boolean
  symbolsExpanded: number
  callersRendered: number
  superseded: number
  /** Raw chunks kept after budget-trimming (≤ chunkCount). */
  rawChunksKept: number
  /** Team-learning rules injected as negative memory (≤ provided). */
  learningsInjected: number
  /** SIG-527: repo-map symbols rendered into the slice (0 when no map). */
  mapEntries: number
  /** SIG-527: char length of the repo-map block (0 when no map). */
  mapChars: number
  contextChars: number
  /** The char budget applied to this slice. */
  budget: number
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
      rawChunksKept: 0,
      learningsInjected: 0,
      mapEntries: 0,
      mapChars: 0,
      contextChars: 0,
      budget: 0,
    },
  }
}

/**
 * Build the "team conventions / past decisions" block from the repo's review learnings
 * (Phase B negative memory). Capped to ~1/3 of the budget so it never crowds out code
 * context; rules are added best-first (the route passes them most-relevant/recent first)
 * until the cap. Returns the block + how many rules made it in.
 */
function buildLearningsBlock(
  learnings: readonly string[] | undefined,
  budget: number,
): { block: string | null; count: number } {
  if (!learnings || learnings.length === 0) return { block: null, count: 0 }
  const cap = Math.max(800, Math.floor(budget / 3))
  const header =
    "# Team conventions & past decisions (from this repo's Sigilix review history)\n" +
    "What this team has already decided or dismissed — respect it; don't re-flag or undo settled calls.\n"
  const lines: string[] = []
  let used = header.length
  for (const rule of learnings) {
    const trimmed = rule.trim()
    if (!trimmed) continue
    const line = `- ${trimmed}`
    if (used + line.length + 1 > cap) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return { block: null, count: 0 }
  return { block: header + lines.join("\n"), count: lines.length }
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
  const budget = args.maxContextChars ?? DEFAULT_CONTEXT_BUDGET

  // Team conventions / past decisions (Phase B negative memory) — readable, high-signal,
  // cheap; injected FIRST and useful even when no code chunk matches.
  const learnings = buildLearningsBlock(args.learnings, budget)
  const learningsLen = learnings.block ? learnings.block.length + SECTION_SEP.length : 0

  // retrieveChunks soft-fails to [] (empty query, embed/query error, unindexed namespace) —
  // the blind baseline, never a thrown turn.
  const query = args.query.trim()
  const chunks: RetrievedChunk[] = query ? await retrieveChunks({ text: query, teamKey: namespace, env: args.env }) : []

  // No code match: still surface team conventions if we have them (the agent benefits even
  // without a code hit); otherwise the blind baseline.
  if (chunks.length === 0) {
    if (!learnings.block) return emptyResult(namespace)
    return {
      context: learnings.block,
      telemetry: {
        namespace,
        chunkCount: 0,
        graphAvailable: false,
        symbolsExpanded: 0,
        callersRendered: 0,
        superseded: 0,
        rawChunksKept: 0,
        learningsInjected: learnings.count,
        // No retrieval hits → no repo map (preserve the current no-hit behavior).
        mapEntries: 0,
        mapChars: 0,
        contextChars: learnings.block.length,
        budget,
      },
    }
  }

  // SIG-527: the dependency-ranked repo map — fetched ONLY now that we have retrieval
  // hits (the no-hit path returned above, so no map is emitted with zero hits). Bias it
  // toward the files the hits touched. It is ADDITIVE: its own ~1200-char budget, NOT
  // carved from `budget`, and it never trims the learnings/symbol/raw sections (recall-
  // safe). Soft-fails to `{ block: null }` (no graph / no committed version / error).
  const biasPaths = [...new Set(chunks.map((c) => c.path))]
  const repoMap = await buildRepoMapBlock({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    biasPaths,
    limit: DEFAULT_REPO_MAP_LIMIT,
  })

  // Graph expansion (SIG-407): enclosing symbol bodies + caller/importer rows, bounded to
  // the budget so the block can't alone blow it. Soft-fails to `{ block: null }` when no
  // active graph version / the fetcher fails.
  const expansion = await expandHitsToSymbols({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    hits: chunks,
    fetchFileContent: args.fetchFileContent,
    maxBytes: Math.min(args.maxBytes ?? budget, budget),
    ...(args.signal ? { signal: args.signal } : {}),
  })

  // Drop raw chunks whose span the symbol block already contains (it supersedes them), then
  // fit the rest into the budget ALONGSIDE the learnings + symbol blocks — keep the
  // highest-ranked chunks, drop the lowest until it fits. retrieveChunks returns chunks
  // ranked best-first, so slicing from the end drops the weakest. Do-no-harm bound: a
  // narrow query can't be charged more than ~budget for grounding.
  const superseded = new Set(expansion.supersededHitKeys)
  const symbolBlock = expansion.block
  const symbolLen = symbolBlock ? symbolBlock.length + SECTION_SEP.length : 0

  let rawKept = chunks.filter((c) => !superseded.has(hitKey(c)))
  let rawBlock = formatChunksForPrompt(rawKept)
  while (rawBlock !== null && learningsLen + symbolLen + rawBlock.length > budget && rawKept.length > 0) {
    rawKept = rawKept.slice(0, -1)
    rawBlock = formatChunksForPrompt(rawKept)
  }

  // Order: learnings → repo map → symbol block → raw chunks. The repo map and the symbol
  // block (the matched code's full bodies) are intentionally budget-EXEMPT (the map carries
  // its OWN ~1200-char budget); only raw chunks trim against `budget`. So total can reach up
  // to ~budget (symbol) + ~budget/3 (learnings) + ~1200 (map); that's deliberate (keep
  // conventions, orientation AND the matched code), not a bug to "fix" into dropping any.
  const sections: string[] = []
  if (learnings.block) sections.push(learnings.block)
  if (repoMap.block) sections.push(repoMap.block)
  if (symbolBlock) sections.push(symbolBlock)
  if (rawBlock) sections.push(rawBlock)
  const context = sections.length > 0 ? sections.join(SECTION_SEP) : null

  return {
    context,
    telemetry: {
      namespace,
      chunkCount: chunks.length,
      graphAvailable: expansion.telemetry.graphAvailable,
      symbolsExpanded: expansion.telemetry.symbolsExpanded,
      callersRendered: expansion.telemetry.callersRendered,
      superseded: expansion.telemetry.superseded,
      rawChunksKept: rawKept.length,
      learningsInjected: learnings.count,
      mapEntries: repoMap.entries,
      mapChars: repoMap.chars,
      contextChars: context ? context.length : 0,
      budget,
    },
  }
}
