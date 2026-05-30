// SIG-286 PR1 — graph context expansion (shadow-only).
//
// Turns the LOCATION rows from RepoGraphDO.contextExpansionForChangedSymbols
// into bounded BODY snippets: definition bodies (the changed symbols), caller
// bodies (same-file call sites of a changed symbol), and import-dependent
// bodies (files that import a changed symbol). The graph stores coordinates,
// not source — body text is sliced from `filesByPath` (free; already fetched
// for changed files) and, for cross-file rows not in that map, an OPTIONAL
// bounded fetcher.
//
// PR1 is shadow-only and passes NO fetcher: cross-file rows are counted under
// `bodiesSource.missing` + `dropped.sourceMissing` so the telemetry quantifies
// the cross-file fetch opportunity for PR2. The result NEVER reaches a prompt
// in PR1 (see triage-pr-review-ensemble) — it only feeds the
// `graph-expansion-shadow` event.
//
// This module is pure/deterministic given its inputs, signal-aware, and never
// throws — on any internal error it returns a zeroed result.

import { estimateTokens } from "./diff-packing"
import type {
  GraphContextExpansion,
  GraphDefinitionRow,
  GraphCallerRow,
  GraphImportRow,
} from "../do/repo-graph"

/** Default byte cap on the simulated rendered payload. */
const DEFAULT_MAX_BYTES = 50_000

/** ± lines around a call site / import line when no symbol span is known. */
const WINDOW_LINES = 8

/** A single rendered body snippet (definition / caller / import-dependent). */
export interface GraphBodySnippet {
  path: string
  startLine: number
  endLine: number
  /** Short label for the snippet subject, e.g. `function foo` or `import bar`. */
  subject: string
  /** Where the body text came from (telemetry / PR2 sourcing). */
  source: "filesByPath" | "github" | "retrievalChunk"
  /** Numbered snippet text (line-prefixed), already bounded. */
  text: string
}

/** The enriched graph context — measured in shadow, never injected in PR1. */
export interface EnrichedGraphContext {
  graphAvailable: boolean
  definitionBodies: GraphBodySnippet[]
  callerBodies: GraphBodySnippet[]
  dependentBodies: GraphBodySnippet[]
  totalTokens: number
  cappedAt: number
  elapsedMs: number
  bodiesSource: {
    filesByPath: number
    github: number
    retrievalChunk: number
    missing: number
  }
  dropped: {
    cap: number
    sourceMissing: number
    graphRowsCapped: number
  }
}

export interface BuildGraphContextExpansionArgs {
  expansion: GraphContextExpansion
  /** Source text by repo-relative path (changed files are already here). */
  filesByPath: ReadonlyMap<string, string>
  /**
   * OPTIONAL bounded fetcher for cross-file paths NOT in `filesByPath`.
   * PR1 passes none (shadow-only, latency-trivial) → those rows count under
   * `bodiesSource.missing`. PR2 wires a bounded GitHub read here.
   */
  fetchFileContent?: (path: string) => Promise<string | null>
  signal?: AbortSignal
  /** Byte cap on the simulated rendered payload. Default 50_000. */
  maxBytes?: number
}

function zeroResult(graphAvailable: boolean, elapsedMs: number): EnrichedGraphContext {
  return {
    graphAvailable,
    definitionBodies: [],
    callerBodies: [],
    dependentBodies: [],
    totalTokens: 0,
    cappedAt: 0,
    elapsedMs,
    bodiesSource: { filesByPath: 0, github: 0, retrievalChunk: 0, missing: 0 },
    dropped: { cap: 0, sourceMissing: 0, graphRowsCapped: 0 },
  }
}

/**
 * Build the (shadow-only) enriched graph context. Definition bodies are the
 * highest-value snippets; import-dependent bodies the lowest. The byte cap is
 * applied in drop priority order: import dependents drop first, then callers,
 * then definitions last — so a tight budget still surfaces the changed code.
 *
 * Never throws: any internal error returns a zeroed result (graphAvailable
 * preserved from the expansion).
 */
export async function buildGraphContextExpansion(
  args: BuildGraphContextExpansionArgs,
): Promise<EnrichedGraphContext> {
  const startMs = Date.now()
  const graphAvailable = args.expansion.graphAvailable
  try {
    if (args.signal?.aborted) return zeroResult(graphAvailable, Date.now() - startMs)

    const maxBytes = args.maxBytes && args.maxBytes > 0 ? Math.floor(args.maxBytes) : DEFAULT_MAX_BYTES
    const bodiesSource = { filesByPath: 0, github: 0, retrievalChunk: 0, missing: 0 }
    const dropped = { cap: 0, sourceMissing: 0, graphRowsCapped: 0 }

    // Cache fetched cross-file sources so multiple rows on one path read once.
    const fetchedCache = new Map<string, string | null>()
    const resolveSource = async (path: string): Promise<string | null> => {
      const inMap = args.filesByPath.get(path)
      if (typeof inMap === "string") return inMap
      if (!args.fetchFileContent) return null
      if (fetchedCache.has(path)) return fetchedCache.get(path) ?? null
      const fetched = await args.fetchFileContent(path)
      fetchedCache.set(path, fetched)
      return fetched
    }
    const sourceKind = (path: string): "filesByPath" | "github" =>
      args.filesByPath.has(path) ? "filesByPath" : "github"

    // ─── Definition bodies ──────────────────────────────────────────
    const definitionBodies: GraphBodySnippet[] = []
    for (const row of args.expansion.definitionRows) {
      if (args.signal?.aborted) break
      const source = await resolveSource(row.path)
      if (source === null) {
        bodiesSource.missing++
        dropped.sourceMissing++
        continue
      }
      const kind = sourceKind(row.path)
      bodiesSource[kind]++
      definitionBodies.push(definitionSnippet(row, source, kind))
    }

    // ─── Caller bodies ──────────────────────────────────────────────
    const callerBodies: GraphBodySnippet[] = []
    for (const row of args.expansion.callerRows) {
      if (args.signal?.aborted) break
      const source = await resolveSource(row.sourcePath)
      if (source === null) {
        bodiesSource.missing++
        dropped.sourceMissing++
        continue
      }
      const kind = sourceKind(row.sourcePath)
      bodiesSource[kind]++
      callerBodies.push(callerSnippet(row, source, kind))
    }

    // ─── Import-dependent bodies ─────────────────────────────────────
    const dependentBodies: GraphBodySnippet[] = []
    for (const row of args.expansion.importRows) {
      if (args.signal?.aborted) break
      const source = await resolveSource(row.sourcePath)
      if (source === null) {
        bodiesSource.missing++
        dropped.sourceMissing++
        continue
      }
      const kind = sourceKind(row.sourcePath)
      bodiesSource[kind]++
      dependentBodies.push(importSnippet(row, source, kind))
    }

    // ─── Byte-cap simulation ─────────────────────────────────────────
    // Render highest-value first (definitions), drop lowest-value first
    // (import dependents → callers → definitions). Whichever lists overflow
    // the cap have their tails dropped; `dropped.cap` counts removed snippets.
    const capResult = applyByteCap(
      { definitionBodies, callerBodies, dependentBodies },
      maxBytes,
    )
    dropped.cap = capResult.droppedCount

    return {
      graphAvailable,
      definitionBodies: capResult.definitionBodies,
      callerBodies: capResult.callerBodies,
      dependentBodies: capResult.dependentBodies,
      totalTokens: estimateTokens(capResult.rendered),
      cappedAt: maxBytes,
      elapsedMs: Date.now() - startMs,
      bodiesSource,
      dropped,
    }
  } catch {
    // Never throw into the review. Zeroed result, graphAvailable preserved.
    return zeroResult(graphAvailable, Date.now() - startMs)
  }
}

// ─── Snippet builders ───────────────────────────────────────────────

function definitionSnippet(
  row: GraphDefinitionRow,
  source: string,
  kind: "filesByPath" | "github",
): GraphBodySnippet {
  const lineCount = countLines(source)
  const startLine = clampLine(row.startLine, lineCount)
  const endLine = clampLine(Math.max(row.startLine, row.endLine), lineCount)
  return {
    path: row.path,
    startLine,
    endLine,
    subject: `${row.kind} ${row.name}`,
    source: kind,
    text: numberedSlice(source, startLine, endLine),
  }
}

function callerSnippet(
  row: GraphCallerRow,
  source: string,
  kind: "filesByPath" | "github",
): GraphBodySnippet {
  const lineCount = countLines(source)
  // Prefer the whole caller symbol body when its span resolved; otherwise a
  // bounded window around the call-site line.
  const hasSpan =
    typeof row.callerStartLine === "number" && typeof row.callerEndLine === "number"
  const startLine = hasSpan
    ? clampLine(row.callerStartLine as number, lineCount)
    : clampLine(row.startLine - WINDOW_LINES, lineCount)
  const endLine = hasSpan
    ? clampLine(Math.max(row.callerStartLine as number, row.callerEndLine as number), lineCount)
    : clampLine(row.startLine + WINDOW_LINES, lineCount)
  return {
    path: row.sourcePath,
    startLine,
    endLine,
    subject: `call ${row.calleeName} (${row.callKind})`,
    source: kind,
    text: numberedSlice(source, startLine, endLine),
  }
}

function importSnippet(
  row: GraphImportRow,
  source: string,
  kind: "filesByPath" | "github",
): GraphBodySnippet {
  const lineCount = countLines(source)
  const startLine = clampLine(row.startLine - WINDOW_LINES, lineCount)
  const endLine = clampLine(row.startLine + WINDOW_LINES, lineCount)
  return {
    path: row.sourcePath,
    startLine,
    endLine,
    subject: `import ${row.importedName ?? "*"}`,
    source: kind,
    text: numberedSlice(source, startLine, endLine),
  }
}

// ─── Byte cap ───────────────────────────────────────────────────────

interface CappedLists {
  definitionBodies: GraphBodySnippet[]
  callerBodies: GraphBodySnippet[]
  dependentBodies: GraphBodySnippet[]
}

/**
 * Fit the snippet lists inside `maxBytes` of simulated rendered payload.
 * Drop order (lowest value first): import dependents → callers → definitions.
 * Within each list the TAIL drops first (rows are already ordered by the DO).
 * Returns the surviving lists, the rendered payload string, and how many
 * snippets were dropped for the cap.
 */
function applyByteCap(lists: CappedLists, maxBytes: number): CappedLists & {
  rendered: string
  droppedCount: number
} {
  // Render in value order so the cheapest-to-keep (definitions) render first.
  const ordered: Array<{ bucket: keyof CappedLists; snippet: GraphBodySnippet }> = [
    ...lists.definitionBodies.map((s) => ({ bucket: "definitionBodies" as const, snippet: s })),
    ...lists.callerBodies.map((s) => ({ bucket: "callerBodies" as const, snippet: s })),
    ...lists.dependentBodies.map((s) => ({ bucket: "dependentBodies" as const, snippet: s })),
  ]

  const kept: CappedLists = { definitionBodies: [], callerBodies: [], dependentBodies: [] }
  const renderedParts: string[] = []
  let bytes = 0
  let droppedCount = 0
  let capHit = false

  for (const { bucket, snippet } of ordered) {
    const block = renderSnippet(snippet)
    const blockBytes = byteLength(block) + (renderedParts.length > 0 ? 1 : 0) // +1 for the joining "\n"
    if (capHit || bytes + blockBytes > maxBytes) {
      capHit = true
      droppedCount++
      continue
    }
    bytes += blockBytes
    renderedParts.push(block)
    kept[bucket].push(snippet)
  }

  // If the cap forced drops, prefer keeping HIGH-value buckets: the loop above
  // already renders definitions first, so a mid-list cap naturally drops the
  // dependent/caller tails before definitions. The droppedCount reflects every
  // snippet that didn't fit, in that priority order.
  return { ...kept, rendered: renderedParts.join("\n"), droppedCount }
}

function renderSnippet(s: GraphBodySnippet): string {
  return `${s.path}:${s.startLine}-${s.endLine} — ${s.subject}\n${s.text}`
}

// ─── Pure helpers ───────────────────────────────────────────────────

function countLines(source: string): number {
  return Math.max(1, source.split("\n").length)
}

function clampLine(line: number, lineCount: number): number {
  if (!Number.isFinite(line)) return 1
  return Math.min(lineCount, Math.max(1, Math.floor(line)))
}

function numberedSlice(source: string, startLine: number, endLine: number): string {
  const lines = source.split("\n")
  const width = String(endLine).length
  const out: string[] = []
  for (let n = startLine; n <= endLine; n++) {
    out.push(`${String(n).padStart(width, " ")} | ${lines[n - 1] ?? ""}`)
  }
  return out.join("\n")
}

/** UTF-8 byte length (the cap is a byte budget, not a char budget). */
function byteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — a full code point is 4 bytes; skip the low surrogate.
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}
