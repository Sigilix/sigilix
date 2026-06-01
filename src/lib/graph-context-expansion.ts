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
// In `shadow` the result is measured-only (the `graph-expansion-shadow` event).
// In `post` the TARGETED inject (`renderGraphExpansionForPrompt` below) renders
// the net-new cross-file bodies into the review prompt — see
// triage-pr-review-ensemble.
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

// SIG-286 PR2 — cross-file fetch bounds. The whole expansion runs inside
// GRAPH_EXPANSION_TIMEOUT_MS=3000 (soft-fail, non-blocking), and a GitHub
// getFileContent is ~150-350ms, so the budget is deliberately small: at most
// MAX_CROSS_FILE_FETCHES distinct cross-file paths, FETCH_CONCURRENCY at a time
// (~2 waves), leaving headroom for the DO query + body build inside the 3s cap.
// Fetched-but-over-budget paths are counted under `dropped.budgetExhausted`.
export const MAX_CROSS_FILE_FETCHES = 6
const FETCH_CONCURRENCY = 4

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

/** The enriched graph context — measured in shadow, never injected (PR1/PR2). */
export interface EnrichedGraphContext {
  graphAvailable: boolean
  definitionBodies: GraphBodySnippet[]
  callerBodies: GraphBodySnippet[]
  dependentBodies: GraphBodySnippet[]
  /** TREATMENT token total: ALL surviving snippets (filesByPath + fetched). */
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
    /** SIG-286 PR2: cross-file paths wanted but past MAX_CROSS_FILE_FETCHES. */
    budgetExhausted: number
  }
  /**
   * SIG-286 PR2 — the CONTROL-vs-TREATMENT measurement that decides PR3 (inject).
   * `control` = bodies available WITHOUT the cross-file fetch (filesByPath-only,
   * i.e. what PR1 saw). `treatment` total is `totalTokens` above; `netNewTokens`
   * is the cross-file context gain (treatment − control). `fetch` is the cost.
   */
  control: { tokens: number }
  fetch: {
    /** Was a bounded cross-file fetcher wired (PR2 on; PR1/tests off). */
    enabled: boolean
    /** Distinct cross-file files actually fetched (non-null) within budget. */
    files: number
    /** Total bytes of fetched cross-file source. */
    bytes: number
    /** Wall time spent in the bounded pre-fetch. */
    elapsedMs: number
    /** True when more distinct cross-file paths were wanted than the cap allows. */
    budgetExhausted: boolean
  }
  /** Cross-file context gain in tokens: `totalTokens − control.tokens`. */
  netNewTokens: number
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
    dropped: { cap: 0, sourceMissing: 0, graphRowsCapped: 0, budgetExhausted: 0 },
    control: { tokens: 0 },
    fetch: { enabled: false, files: 0, bytes: 0, elapsedMs: 0, budgetExhausted: false },
    netNewTokens: 0,
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

    // Floor + clamp to ≥1: a positive fractional arg (e.g. 0.5) must not floor
    // to 0 and silently drop every snippet (CodeRabbit). Non-finite/<1 → default.
    const maxBytesReq = Math.floor(args.maxBytes ?? DEFAULT_MAX_BYTES)
    const maxBytes = Number.isFinite(maxBytesReq) && maxBytesReq >= 1 ? maxBytesReq : DEFAULT_MAX_BYTES
    const bodiesSource = { filesByPath: 0, github: 0, retrievalChunk: 0, missing: 0 }
    const dropped = { cap: 0, sourceMissing: 0, graphRowsCapped: 0, budgetExhausted: 0 }

    // SIG-286 PR2: bounded, concurrent, FN-value-ordered cross-file pre-fetch.
    // Spends the whole fetch budget UP FRONT (so the cap is honored + the
    // fetches run concurrently within the 3s ceiling), populating `fetchedCache`.
    // After this, `resolveSource` only READS the cache — never lazily fetches —
    // so a cross-file path past the budget resolves to null (counted missing /
    // budgetExhausted), not an unbounded extra fetch.
    const fetchedCache = new Map<string, string | null>()
    const fetchStats = await prefetchCrossFileSources(args, fetchedCache)
    if (fetchStats.budgetExhausted) {
      // Distinct cross-file paths we wanted but couldn't fetch under the cap.
      dropped.budgetExhausted = fetchStats.wantedOverBudget
    }
    const resolveSource = (path: string): string | null => {
      const inMap = args.filesByPath.get(path)
      if (typeof inMap === "string") return inMap
      const cached = fetchedCache.get(path)
      return typeof cached === "string" ? cached : null
    }
    const sourceKind = (path: string): "filesByPath" | "github" =>
      args.filesByPath.has(path) ? "filesByPath" : "github"

    // ─── Definition bodies ──────────────────────────────────────────
    const definitionBodies: GraphBodySnippet[] = []
    for (const row of args.expansion.definitionRows) {
      if (args.signal?.aborted) break
      const source = resolveSource(row.path)
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
      const source = resolveSource(row.sourcePath)
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
      const source = resolveSource(row.sourcePath)
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

    // CONTROL vs TREATMENT token split (over the SURVIVING, post-cap snippets):
    // control = filesByPath-sourced bodies only (what PR1 / no-fetch would see);
    // treatment = all surviving bodies. netNew = the cross-file context gain.
    const totalTokens = estimateTokens(capResult.rendered)
    const controlRendered = [
      ...capResult.definitionBodies,
      ...capResult.callerBodies,
      ...capResult.dependentBodies,
    ]
      .filter((s) => s.source === "filesByPath")
      .map(renderSnippet)
      .join("\n")
    const controlTokens = estimateTokens(controlRendered)

    return {
      graphAvailable,
      definitionBodies: capResult.definitionBodies,
      callerBodies: capResult.callerBodies,
      dependentBodies: capResult.dependentBodies,
      totalTokens,
      cappedAt: maxBytes,
      elapsedMs: Date.now() - startMs,
      bodiesSource,
      dropped,
      control: { tokens: controlTokens },
      fetch: {
        enabled: args.fetchFileContent !== undefined,
        files: fetchStats.files,
        bytes: fetchStats.bytes,
        elapsedMs: fetchStats.elapsedMs,
        budgetExhausted: fetchStats.budgetExhausted,
      },
      netNewTokens: Math.max(0, totalTokens - controlTokens),
    }
  } catch {
    // Never throw into the review. Zeroed result, graphAvailable preserved.
    return zeroResult(graphAvailable, Date.now() - startMs)
  }
}

/**
 * SIG-286 PR1 — render the TARGETED graph-context inject for the review prompt.
 *
 * The BLANKET inject (every body) was a pre-registered KILL: median net-new
 * tokens 0, because most reviews have no cross-file context worth adding. This
 * renders ONLY the net-new cross-file high-value bodies — definitions + callers
 * whose source is NOT the changed files (`source !== "filesByPath"`), i.e.
 * context the model does not already have from the diff. Import-dependent bodies
 * (the lowest-value tier) are dropped entirely.
 *
 * Returns "" when there is nothing net-new to add, so the ~73% of reviews the
 * blanket inject would have taxed for ~0 gain inject nothing — the whole point
 * of the targeted pivot. Bodies are already byte-capped by the build. Pure.
 */
/**
 * The net-new cross-file high-value bodies the targeted inject renders:
 * definitions + callers sourced from OTHER files (`source !== "filesByPath"`),
 * import-dependents excluded. The SINGLE source of truth for "what gets
 * injected" — both the render and the injected-count telemetry call this, so
 * they can never drift. Pure.
 */
export function netNewCrossFileBodies(enriched: EnrichedGraphContext): GraphBodySnippet[] {
  return [...enriched.definitionBodies, ...enriched.callerBodies].filter(
    (b) => b.source !== "filesByPath",
  )
}

export function renderGraphExpansionForPrompt(enriched: EnrichedGraphContext): string {
  const netNew = netNewCrossFileBodies(enriched)
  if (netNew.length === 0) return ""
  const lines = [
    "[GRAPH CONTEXT — CROSS-FILE]",
    "Bodies of definitions/callers pulled from OTHER files in the repo (not in",
    "this diff), to ground reasoning about cross-file contracts. Read-only",
    "reference — NOT changed code; do not flag findings inside these snippets.",
    "",
  ]
  for (const b of netNew) lines.push(renderSnippet(b))
  return lines.join("\n").trimEnd()
}

// ─── SIG-286 PR2: bounded cross-file pre-fetch ──────────────────────

interface PrefetchStats {
  files: number
  bytes: number
  elapsedMs: number
  budgetExhausted: boolean
  /** Distinct cross-file paths wanted beyond MAX_CROSS_FILE_FETCHES. */
  wantedOverBudget: number
}

/**
 * Fetch the cross-file source bodies the expansion needs, bounded + concurrent,
 * UP FRONT, into `fetchedCache`. Cross-file = a row path NOT already in
 * `filesByPath` (the changed files). Ordered by FN value (deepseek-v4-pro §2):
 * CALLERS first (who invokes the changed code → "what contract might I break")
 * > import-dependents > definitions (definitions are ~always in the changed
 * files already, so they rarely contribute a fetch). Distinct paths only; at
 * most MAX_CROSS_FILE_FETCHES, FETCH_CONCURRENCY at a time. Soft-fail: a fetch
 * error resolves to a cached `null` (counted missing, never thrown). No fetcher
 * (PR1 / tests) ⇒ zero stats and an empty cache.
 */
async function prefetchCrossFileSources(
  args: BuildGraphContextExpansionArgs,
  fetchedCache: Map<string, string | null>,
): Promise<PrefetchStats> {
  const startMs = Date.now()
  const empty: PrefetchStats = { files: 0, bytes: 0, elapsedMs: 0, budgetExhausted: false, wantedOverBudget: 0 }
  if (!args.fetchFileContent) return empty

  // Distinct cross-file paths in FN-value order.
  const wanted: string[] = []
  const seen = new Set<string>()
  const consider = (path: string | undefined): void => {
    if (typeof path !== "string" || path.length === 0) return
    if (args.filesByPath.has(path) || seen.has(path)) return
    seen.add(path)
    wanted.push(path)
  }
  for (const row of args.expansion.callerRows) consider(row.sourcePath)
  for (const row of args.expansion.importRows) consider(row.sourcePath)
  for (const row of args.expansion.definitionRows) consider(row.path)

  const wantedOverBudget = Math.max(0, wanted.length - MAX_CROSS_FILE_FETCHES)
  const toFetch = wanted.slice(0, MAX_CROSS_FILE_FETCHES)

  let files = 0
  let bytes = 0
  const fetchFile = args.fetchFileContent
  for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
    if (args.signal?.aborted) break
    const batch = toFetch.slice(i, i + FETCH_CONCURRENCY)
    // Each callback returns its OWN contribution; the shared counters are then
    // summed AFTER Promise.all (not mutated inside the callbacks). Functionally
    // identical under JS's single thread, but it keeps the accumulation immune
    // to a future refactor adding a yield before the increment (Sigilix nit).
    const results = await Promise.all(
      batch.map(async (path): Promise<{ fetched: boolean; bytes: number }> => {
        if (fetchedCache.has(path)) return { fetched: false, bytes: 0 }
        // Soft-fail every individual fetch: a 404 / rate-limit / network error
        // must NOT throw into the review (the outer catch is the last resort).
        const src = await fetchFile(path).catch(() => null)
        fetchedCache.set(path, src)
        return typeof src === "string"
          ? { fetched: true, bytes: byteLength(src) }
          : { fetched: false, bytes: 0 }
      }),
    )
    for (const r of results) {
      if (r.fetched) {
        files += 1
        bytes += r.bytes
      }
    }
  }

  return {
    files,
    bytes,
    elapsedMs: Date.now() - startMs,
    budgetExhausted: wantedOverBudget > 0,
    wantedOverBudget,
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
