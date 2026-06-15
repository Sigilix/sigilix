// SIG-407 PR-2 — mention-path symbol expander (DARK; no caller yet — PR-3 wires it).
//
// Turns the @-mention Q&A retrieval hits into a SYMBOL-AWARE prompt block by
// expanding each hit (path + line range) into its enclosing symbol body plus
// direct callers, drawn from the SIG-138 acorn graph. This is the small-to-big /
// parent-document retrieval promise: a 30-line slice becomes the whole symbol +
// who calls it, so the answer model reasons over complete code, not a window.
//
// REUSE boundary (Codex sign-off, spec §0):
//   - REUSE `buildGraphContextExpansion` for body-slicing + bounded cross-file
//     fetch + byte-capping (it is pure, signal-aware, never throws).
//   - Do NOT reuse `renderGraphExpansionForPrompt` — it is REVIEW-specific: it
//     emits "not in this diff" / "do not flag findings" language, filters to
//     net-new cross-file bodies only, and excludes import-dependents. The mention
//     path wants a read-only GROUNDING frame, so we write a fresh renderer here.
//
// CRITICAL prefetch-priority fix (spec §3): `buildGraphContextExpansion`
// prioritizes CALLER cross-file fetches and treats `filesByPath` as
// already-available, spending the 6-file cross-file budget on callers/importers
// FIRST (definition paths are queued last). In the review path that is correct —
// definitions are the changed files, already in `filesByPath`. The mention path
// has NO changed-files map, so without intervention the definitions (the symbols
// the question actually matched — the highest-value bodies) would be starved by
// the caller budget. So we PRE-FETCH the distinct definition-row file paths into
// `filesByPath` up front; they then always render, and the cross-file budget goes
// to callers/importers.
//
// Never throws: any error returns an EMPTY result (no block). The expansion is
// purely additive — it can only ADD symbol context, never remove a hit the model
// would otherwise see.

import type { Env } from "@/src/shared/types/env"
import type { GraphHitExpansion } from "@/src/do/repo-graph"
import { enclosingSymbolsForHitsFor } from "./repo-graph-client"
import { buildGraphContextExpansion } from "./graph-context-expansion"
import type { GraphBodySnippet } from "./graph-context-expansion"
import type { RetrievedChunk } from "./retrieval"

/** Cap on distinct enclosing symbols rendered (one per top hit, in row order). */
export const MAX_EXPANDED_SYMBOLS = 8
/** Cap on caller bodies rendered (lower value than definitions). */
export const MAX_CALLER_BODIES = 6
/** Byte budget for the expansion-internal body build (reused as `maxBytes`). */
const DEFAULT_EXPANSION_MAX_BYTES = 18_000

/** A retrieval hit's coordinate, the unit the expander resolves to a symbol. */
export interface HitCoord {
  path: string
  lineStart: number
  lineEnd: number
}

export interface ExpandHitsArgs {
  env: Env
  owner: string
  repo: string
  /** Retrieval hits to expand (path + line range carry the coordinate). */
  hits: RetrievedChunk[]
  /**
   * Bounded file-content fetcher — the mention path passes
   * `client.getFileContent`. Used both to pre-fetch definition files and (by the
   * reused `buildGraphContextExpansion`) to fetch cross-file caller/importer
   * bodies. Soft-fails to null; never throws into the expander.
   */
  fetchFileContent: (path: string) => Promise<string | null>
  signal?: AbortSignal
  /** Byte cap on the expansion-internal body build. Default 18_000. */
  maxBytes?: number
}

export interface MentionSymbolExpansion {
  /** The rendered symbol block, or null when there is nothing to add. */
  block: string | null
  /**
   * The graph's active-version HEAD sha (from `GraphHitExpansion`). SURFACED for
   * PR-3's drift policy — NOT gated on here: the indexed HEAD usually lags the
   * question HEAD, so gating on exact match would make the feature never fire.
   * null when no graph is available.
   */
  headSha: string | null
  /**
   * Raw hit keys whose `[lineStart,lineEnd]` is contained by a RENDERED
   * definition body. Advisory for PR-3: when injecting, the symbol body
   * supersedes the raw slice, so PR-3 can drop the duplicated raw hit.
   */
  supersededHitKeys: string[]
  telemetry: {
    graphAvailable: boolean
    symbolsExpanded: number
    callersRendered: number
    fetchedFiles: number
    fetchBytes: number
    superseded: number
  }
}

/** Stable hit identity, mirroring retrieval/symbol-retrieval's `chunkId`. */
export function hitKey(hit: HitCoord): string {
  return `${hit.path}:${hit.lineStart}-${hit.lineEnd}`
}

const EMPTY: MentionSymbolExpansion = {
  block: null,
  headSha: null,
  supersededHitKeys: [],
  telemetry: {
    graphAvailable: false,
    symbolsExpanded: 0,
    callersRendered: 0,
    fetchedFiles: 0,
    fetchBytes: 0,
    superseded: 0,
  },
}

function emptyWith(headSha: string | null, graphAvailable: boolean): MentionSymbolExpansion {
  return {
    ...EMPTY,
    headSha,
    telemetry: { ...EMPTY.telemetry, graphAvailable },
  }
}

/**
 * The distinct definition-row file paths to pre-fetch into `filesByPath`. The
 * caller passes the ALREADY-CAPPED definition rows (the exact rows the mention
 * block will render), so this only de-duplicates by path, order-preserving — it
 * never fetches a file for a row that won't render. The MAX_EXPANDED_SYMBOLS
 * guard remains as a defensive cap on the distinct-path count. Pure.
 */
export function definitionPrefetchPaths(definitionRows: ReadonlyArray<{ path: string }>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of definitionRows) {
    if (out.length >= MAX_EXPANDED_SYMBOLS) break
    if (seen.has(row.path)) continue
    seen.add(row.path)
    out.push(row.path)
  }
  return out
}

/**
 * Render the MENTION-specific symbol block from the enriched definition + caller
 * bodies. Mirrors `buildGraphContextExpansion`'s per-snippet format
 * (`path:start-end — subject\n<numbered text>`; `text` is already line-numbered),
 * but with a read-only GROUNDING frame (NOT the review renderer's "do not flag
 * findings" / "not in this diff" language). Returns null when no bodies survive.
 * Pure.
 */
export function renderMentionSymbolBlock(
  definitionBodies: readonly GraphBodySnippet[],
  callerBodies: readonly GraphBodySnippet[],
): string | null {
  const defs = definitionBodies.slice(0, MAX_EXPANDED_SYMBOLS)
  const callers = callerBodies.slice(0, MAX_CALLER_BODIES)
  if (defs.length === 0 && callers.length === 0) return null

  const lines: string[] = [
    "[SYMBOL CONTEXT — expanded from your question's matches]",
    "Full symbol bodies (and their direct callers) for the code your question",
    "matched, pulled from the repository graph so the answer is grounded in the",
    "whole symbol, not a 30-line slice. Read-only reference for answering.",
    "",
  ]
  for (const b of defs) lines.push(renderMentionSnippet(b))
  if (callers.length > 0) {
    lines.push("")
    lines.push("[CALLERS]")
    for (const b of callers) lines.push(renderMentionSnippet(b))
  }
  return lines.join("\n").trimEnd()
}

function renderMentionSnippet(s: GraphBodySnippet): string {
  return `${s.path}:${s.startLine}-${s.endLine} — ${s.subject}\n${s.text}`
}

/** UTF-8 byte length — for telemetry on the definition pre-fetch payload. */
const TEXT_ENCODER = new TextEncoder()
function utf8ByteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length
}

/**
 * The raw hits superseded by a RENDERED definition body. A hit is superseded iff
 * some rendered def body on the SAME path fully contains the hit's line range
 * (`startLine <= hit.lineStart && endLine >= hit.lineEnd`). Computed against the
 * RENDERED (capped) def bodies, not the raw rows, so PR-3's drop decision matches
 * exactly what was injected. Pure.
 */
export function supersededHitKeys(hits: readonly HitCoord[], renderedDefBodies: readonly GraphBodySnippet[]): string[] {
  if (hits.length === 0 || renderedDefBodies.length === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const contained = renderedDefBodies.some(
      (b) => b.path === hit.path && b.startLine <= hit.lineStart && b.endLine >= hit.lineEnd,
    )
    if (!contained) continue
    const key = hitKey(hit)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * Expand retrieval hits into a symbol-aware prompt block. DARK in PR-2: no caller
 * yet (PR-3 wires both the single-shot and agentic seams). Never throws.
 */
export async function expandHitsToSymbols(args: ExpandHitsArgs): Promise<MentionSymbolExpansion> {
  if (args.hits.length === 0) return EMPTY

  const hitCoords: HitCoord[] = args.hits.map((h) => ({
    path: h.path,
    lineStart: h.lineStart,
    lineEnd: h.lineEnd,
  }))

  // The DO call is the one boundary whose failure means "no graph at all" — its
  // own try/catch returns EMPTY (headSha unknown). Everything AFTER it runs in a
  // second try so a downstream throw still SURFACES the now-known headSha /
  // graphAvailable (PR-3's drift policy wants the sha even on a partial failure).
  let hitExp
  try {
    hitExp = await enclosingSymbolsForHitsFor(args.env, args.owner, args.repo, { hits: hitCoords })
  } catch {
    return EMPTY
  }

  // No graph (or no active version) → nothing to add. Surface headSha (null here).
  if (!hitExp.graphAvailable) return emptyWith(hitExp.headSha, false)

  try {
    // Honor an already-aborted signal before spending any fetch budget; the graph
    // WAS available, so keep graphAvailable=true (and the surfaced headSha).
    if (args.signal?.aborted) return emptyWith(hitExp.headSha, true)

    // Cap the rows to the mention render caps BEFORE handing them to
    // buildGraphContextExpansion. The DO returns rows ordered by (path, start_line);
    // the build then applies its byte cap ACROSS all rows. If we capped only after
    // the build, rows the mention block will never render could (a) trigger
    // definition-file fetches and (b) consume byte-cap budget that should keep
    // caller bodies — so we slice up front. importRows are dropped entirely: the
    // mention renderer never renders import-dependents, so leaving them would only
    // spend cross-file fetch/cap budget on bodies that never appear in the block.
    const cappedExpansion: GraphHitExpansion = {
      ...hitExp,
      definitionRows: hitExp.definitionRows.slice(0, MAX_EXPANDED_SYMBOLS),
      callerRows: hitExp.callerRows.slice(0, MAX_CALLER_BODIES),
      importRows: [],
    }

    // Pre-fetch the DISTINCT definition file paths (of the CAPPED rows) into
    // `filesByPath` so the reused build always renders them (instead of starving
    // them behind the caller fetch budget). Concurrent, soft-fail to null.
    const defPaths = definitionPrefetchPaths(cappedExpansion.definitionRows)
    const fetched = await Promise.all(
      defPaths.map(async (path): Promise<readonly [string, string | null]> => {
        const src = await args.fetchFileContent(path).catch(() => null)
        return [path, src] as const
      }),
    )
    const filesByPath = new Map<string, string>()
    let prefetchFiles = 0
    let prefetchBytes = 0
    for (const [path, src] of fetched) {
      if (typeof src === "string") {
        filesByPath.set(path, src)
        prefetchFiles += 1
        prefetchBytes += utf8ByteLength(src)
      }
    }

    // Reuse the body-slice + bounded cross-file fetch machinery. Definitions come
    // from `filesByPath` (always rendered); the cross-file budget now goes to
    // callers.
    const enriched = await buildGraphContextExpansion({
      expansion: cappedExpansion,
      filesByPath,
      fetchFileContent: args.fetchFileContent,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      maxBytes: args.maxBytes ?? DEFAULT_EXPANSION_MAX_BYTES,
    })

    // The build is now over pre-capped rows; these slices are a defensive no-op
    // safety net (the byte cap can only ever REDUCE counts below the row caps).
    const renderedDefs = enriched.definitionBodies.slice(0, MAX_EXPANDED_SYMBOLS)
    const renderedCallers = enriched.callerBodies.slice(0, MAX_CALLER_BODIES)
    const block = renderMentionSymbolBlock(renderedDefs, renderedCallers)
    const superseded = supersededHitKeys(hitCoords, renderedDefs)

    return {
      block,
      headSha: hitExp.headSha,
      supersededHitKeys: superseded,
      telemetry: {
        graphAvailable: true,
        symbolsExpanded: renderedDefs.length,
        callersRendered: renderedCallers.length,
        // Total file reads = the definition pre-fetch (counted here; those land in
        // filesByPath, so buildGraphContextExpansion classifies them as
        // filesByPath-sourced and they do NOT appear in enriched.fetch) PLUS the
        // reused build's bounded cross-file caller fetches (importRows are dropped).
        fetchedFiles: prefetchFiles + enriched.fetch.files,
        fetchBytes: prefetchBytes + enriched.fetch.bytes,
        superseded: superseded.length,
      },
    }
  } catch {
    // Never throw into the mention path. The graph WAS available, so preserve the
    // surfaced headSha / graphAvailable; the empty block = today's behavior.
    return emptyWith(hitExp.headSha, true)
  }
}
