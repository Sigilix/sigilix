// SIG-527: the dependency-ranked "repo map" block for the grounded slice.
//
// Aider-style: a compact, dependency-ranked, NAVIGATION-ONLY list of the repo's
// most-depended-on symbols — `path:line  kind name  (↑callers, imp importers)`,
// with NO bodies/signatures (those aren't indexed). It gives a small model
// orientation + coverage BEYOND the retrieved chunks (which only show the few
// places that matched the query), so it can reason about where to look without
// re-deriving the repo's shape by grepping.
//
// Fetch + render only; this never gates the agent. No graph, no committed
// version, or any error → `block: null` and the caller simply proceeds without
// the map (the same soft-fail contract as the rest of the grounded slice).

import { repoMapFor } from "./repo-graph-client"
import type { RepoMapEntry } from "@/src/shared/domain/graph-context"
import type { Env } from "@/src/shared/types/env"

// Default char budget for the rendered map block. Its OWN budget — it is ADDITIVE
// to the grounded slice (it does not carve from DEFAULT_CONTEXT_BUDGET), so a
// narrow turn pays at most ~this many extra chars for the orientation it buys.
const DEFAULT_MAP_CHARS = 1200

const HEADER =
  "# Repo map (most-depended-on symbols — navigation only, no bodies)\n" +
  "Pointers to where central code lives; do not infer behavior from this list.\n"

/** Render one entry as a single navigation line (no body, no signature). */
function renderEntry(e: RepoMapEntry): string {
  return `- ${e.path}:${e.line}  ${e.kind} ${e.name}  (↑${e.callerCount} callers, imp ${e.importerCount} importers)`
}

export interface BuildRepoMapBlockArgs {
  env: Env
  owner: string
  repo: string
  /** The current turn's retrieval-hit paths — biases their local symbols upward. */
  biasPaths: readonly string[]
  /** Max symbols to request from the graph before char-budget trimming. */
  limit: number
  /** Char cap on the rendered block; lowest-ranked lines drop until it fits. */
  maxMapChars?: number
}

export interface RepoMapBlock {
  /** The rendered block ready to inject, or null when nothing could be mapped. */
  block: string | null
  /** Entries that made it into the block (after the char-budget trim). */
  entries: number
  /** Char length of the rendered block (0 when null). */
  chars: number
}

const EMPTY: RepoMapBlock = { block: null, entries: 0, chars: 0 }

/**
 * Fetch the dependency-ranked repo map and render it NAVIGATION-ONLY, bounded to
 * `maxMapChars` by dropping the lowest-ranked lines (repoMapFor returns
 * most-central first). Soft-fails to `{ block: null, … }` — empty map, an
 * over-tight budget that fits no line, or any error.
 */
export async function buildRepoMapBlock(args: BuildRepoMapBlockArgs): Promise<RepoMapBlock> {
  const cap = args.maxMapChars ?? DEFAULT_MAP_CHARS

  let entries: RepoMapEntry[]
  try {
    entries = await repoMapFor(args.env, args.owner, args.repo, {
      limit: args.limit,
      biasPaths: [...args.biasPaths],
    })
  } catch {
    return EMPTY
  }
  if (entries.length === 0) return EMPTY

  // Keep the highest-ranked lines that fit under the cap (entries arrive
  // most-central first). The header counts against the cap; if not even the
  // header + one line fits, emit nothing (soft-fail, never a header-only block).
  const lines: string[] = []
  let used = HEADER.length
  for (const e of entries) {
    const line = renderEntry(e)
    const next = used + line.length + 1 // +1 for the newline joining it on
    if (next > cap) break
    lines.push(line)
    used = next
  }
  if (lines.length === 0) return EMPTY

  const block = HEADER + lines.join("\n")
  return { block, entries: lines.length, chars: block.length }
}
