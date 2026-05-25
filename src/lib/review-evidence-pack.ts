// Dynamic review evidence pack.
//
// This builds a small, deterministic evidence block around changed code:
// changed symbol snippets, related graph/retrieval paths, and nearby test
// context. It is intentionally evidence, not findings. The LLM still decides
// whether a bug exists, but it sees the concrete context needed to write a
// Greptile-style actionable inline comment when one is real.

import { nodeOverlapsChanged, type ChangedLines } from "./ast-rules/diff-filter"
import { extractFileGraph, type GraphSymbol } from "./graph-extract"
import type { RetrievedChunk } from "./retrieval"
import type { TestingEvidencePack } from "./testing-evidence-pack"
import type { GraphContextNode } from "../do/repo-graph"

export type DynamicReviewEvidenceMode = "off" | "shadow" | "post"

const DEFAULT_MAX_CARDS = 6
const MAX_CHANGED_LINES_PER_CARD = 12
const MAX_SNIPPET_LINES = 24
const SNIPPET_CONTEXT_LINES = 4
const MAX_GRAPH_RELATIONS_PER_CARD = 6
const MAX_RETRIEVAL_REFS_PER_CARD = 3
const MAX_RETRIEVAL_EXCERPT_LINES = 5
const MAX_RETRIEVAL_EXCERPT_CHARS = 900
const MAX_TEST_REFS_PER_CARD = 5

export interface DynamicReviewEvidenceEnv {
  OPENCLAW_DYNAMIC_REVIEW_EVIDENCE?: string
}

export interface DynamicReviewEvidenceGraphRelation {
  path: string
  relation: string
}

export interface DynamicReviewEvidenceRetrievalRef {
  path: string
  lineStart: number
  lineEnd: number
  score: number
  reason: string
  excerpt: string
}

export interface DynamicReviewEvidenceTestingContext {
  siblingRefs: string[]
  inspectedTestFiles: string[]
  helperCoverageRefs: string[]
}

export interface DynamicReviewEvidenceCard {
  path: string
  symbolName: string | null
  symbolKind: string | null
  symbolExported: boolean | null
  startLine: number
  endLine: number
  changedLines: number[]
  localSnippet: string
  graphRelations: DynamicReviewEvidenceGraphRelation[]
  retrievalRefs: DynamicReviewEvidenceRetrievalRef[]
  testingContext: DynamicReviewEvidenceTestingContext
}

export interface DynamicReviewEvidencePack {
  cards: DynamicReviewEvidenceCard[]
  filesScanned: number
  changedFilesWithSources: number
}

export interface BuildDynamicReviewEvidencePackArgs {
  filesByPath: ReadonlyMap<string, string>
  changedLines: ChangedLines
  reviewablePaths?: readonly string[]
  retrievalChunks?: readonly RetrievedChunk[]
  graphNodes?: readonly GraphContextNode[]
  blastCallerPaths?: readonly string[]
  blastDependentPaths?: readonly string[]
  testingEvidence?: TestingEvidencePack
  maxCards?: number
}

export function dynamicReviewEvidenceMode(
  env: DynamicReviewEvidenceEnv,
): DynamicReviewEvidenceMode {
  const v = (env.OPENCLAW_DYNAMIC_REVIEW_EVIDENCE ?? "").trim().toLowerCase()
  if (v === "post") return "post"
  if (v === "shadow") return "shadow"
  return "off"
}

export function dynamicReviewEvidenceEnabled(env: DynamicReviewEvidenceEnv): boolean {
  return dynamicReviewEvidenceMode(env) !== "off"
}

export function buildDynamicReviewEvidencePack(
  args: BuildDynamicReviewEvidencePackArgs,
): DynamicReviewEvidencePack {
  const maxCards = clampPositiveInt(args.maxCards, DEFAULT_MAX_CARDS)
  const reviewablePathSet = new Set(args.reviewablePaths ?? [...args.filesByPath.keys()])
  const cards: DynamicReviewEvidenceCard[] = []
  let filesScanned = 0
  let changedFilesWithSources = 0

  for (const [path, source] of args.filesByPath) {
    if (cards.length >= maxCards) break
    if (!reviewablePathSet.has(path)) continue
    const pathChangedLines = sortedChangedLines(args.changedLines, path)
    if (pathChangedLines.length === 0) continue

    filesScanned++
    changedFilesWithSources++
    const graph = extractFileGraph(path, source)
    const symbols = graph.symbols
      .filter((s) => nodeOverlapsChanged(args.changedLines, path, s.startLine, s.endLine))
      .sort(compareSymbolsBySpecificity)
    const coveredChangedLines = new Set<number>()

    for (const symbol of symbols) {
      if (cards.length >= maxCards) break
      const changedLinesForSymbol = changedLinesWithinSpan(
        pathChangedLines,
        symbol.startLine,
        symbol.endLine,
      )
      const uncovered = changedLinesForSymbol.filter((line) => !coveredChangedLines.has(line))
      if (uncovered.length === 0) continue
      const linesForCard = uncovered.slice(0, MAX_CHANGED_LINES_PER_CARD)
      for (const line of linesForCard) coveredChangedLines.add(line)
      cards.push(buildCard({
        path,
        source,
        changedLinesForCard: linesForCard,
        symbol,
        graphNodes: args.graphNodes ?? [],
        blastCallerPaths: args.blastCallerPaths ?? [],
        blastDependentPaths: args.blastDependentPaths ?? [],
        retrievalChunks: args.retrievalChunks ?? [],
        testingEvidence: args.testingEvidence,
      }))
    }

    const remainingChangedLines = pathChangedLines.filter((line) => !coveredChangedLines.has(line))
    if (cards.length < maxCards && remainingChangedLines.length > 0) {
      cards.push(buildCard({
        path,
        source,
        changedLinesForCard: remainingChangedLines.slice(0, MAX_CHANGED_LINES_PER_CARD),
        symbol: null,
        graphNodes: args.graphNodes ?? [],
        blastCallerPaths: args.blastCallerPaths ?? [],
        blastDependentPaths: args.blastDependentPaths ?? [],
        retrievalChunks: args.retrievalChunks ?? [],
        testingEvidence: args.testingEvidence,
      }))
    }
  }

  return { cards, filesScanned, changedFilesWithSources }
}

export function renderDynamicReviewEvidenceBlock(pack: DynamicReviewEvidencePack): string {
  if (pack.cards.length === 0) return ""

  const lines: string[] = [
    "[DYNAMIC REVIEW EVIDENCE — changed-symbol context]",
    "Precomputed context for writing specific, inline-ready review comments. This is evidence, not a finding list. Use it to make claims falsifiable; do not invent facts beyond these snippets, graph/retrieval refs, tests, and the diff.",
    "",
  ]

  for (let i = 0; i < pack.cards.length; i++) {
    const card = pack.cards[i]!
    const subject = card.symbolName
      ? `${card.symbolKind ?? "symbol"} \`${card.symbolName}\``
      : "changed file region"
    lines.push(
      `Card ${i + 1}: ${card.path}:${card.startLine}-${card.endLine} — ${subject}`,
      `Changed lines: ${card.changedLines.join(", ")}`,
      "Local snippet:",
      fenceBlock(card.localSnippet, languageForPath(card.path)),
    )

    if (card.graphRelations.length > 0) {
      lines.push("Related graph paths:")
      for (const rel of card.graphRelations) {
        lines.push(`- ${rel.path} (${rel.relation})`)
      }
    }

    if (card.retrievalRefs.length > 0) {
      lines.push("Related retrieved chunks:")
      for (const ref of card.retrievalRefs) {
        lines.push(
          `- ${ref.path}:${ref.lineStart}-${ref.lineEnd} score=${ref.score.toFixed(3)} (${ref.reason})`,
          indentBlockLines(fenceBlock(ref.excerpt), "  "),
        )
      }
    }

    const testingLines = renderTestingContextLines(card.testingContext)
    if (testingLines.length > 0) {
      lines.push("Testing context:", ...testingLines)
    }

    if (i < pack.cards.length - 1) lines.push("")
  }

  return lines.join("\n").trim()
}

function buildCard(args: {
  path: string
  source: string
  changedLinesForCard: readonly number[]
  symbol: GraphSymbol | null
  graphNodes: readonly GraphContextNode[]
  blastCallerPaths: readonly string[]
  blastDependentPaths: readonly string[]
  retrievalChunks: readonly RetrievedChunk[]
  testingEvidence: TestingEvidencePack | undefined
}): DynamicReviewEvidenceCard {
  const bounds = snippetBounds(args.source, args.changedLinesForCard, args.symbol)
  return {
    path: args.path,
    symbolName: args.symbol?.name ?? null,
    symbolKind: args.symbol?.kind ?? null,
    symbolExported: args.symbol?.exported ?? null,
    startLine: bounds.startLine,
    endLine: bounds.endLine,
    changedLines: [...args.changedLinesForCard],
    localSnippet: renderNumberedSnippet(
      args.source,
      bounds.startLine,
      bounds.endLine,
      new Set(args.changedLinesForCard),
    ),
    graphRelations: buildGraphRelations({
      path: args.path,
      graphNodes: args.graphNodes,
      blastCallerPaths: args.blastCallerPaths,
      blastDependentPaths: args.blastDependentPaths,
    }),
    retrievalRefs: buildRetrievalRefs({
      path: args.path,
      symbolName: args.symbol?.name ?? null,
      graphPaths: new Set([
        ...args.graphNodes.map((node) => node.path),
        ...args.blastCallerPaths,
        ...args.blastDependentPaths,
      ]),
      chunks: args.retrievalChunks,
    }),
    testingContext: buildTestingContext(args.path, args.testingEvidence),
  }
}

function sortedChangedLines(changedLines: ChangedLines, path: string): number[] {
  return [...(changedLines.get(path) ?? [])].sort((a, b) => a - b)
}

function changedLinesWithinSpan(
  changedLines: readonly number[],
  startLine: number,
  endLine: number,
): number[] {
  return changedLines.filter((line) => line >= startLine && line <= endLine)
}

function compareSymbolsBySpecificity(a: GraphSymbol, b: GraphSymbol): number {
  const spanDiff = (a.endLine - a.startLine) - (b.endLine - b.startLine)
  if (spanDiff !== 0) return spanDiff
  const startDiff = a.startLine - b.startLine
  if (startDiff !== 0) return startDiff
  return a.name.localeCompare(b.name)
}

function snippetBounds(
  source: string,
  changedLines: readonly number[],
  symbol: GraphSymbol | null,
): { startLine: number; endLine: number } {
  const lineCount = Math.max(1, source.split("\n").length)
  const firstChanged = changedLines[0] ?? 1
  const lastChanged = changedLines[changedLines.length - 1] ?? firstChanged
  let startLine = Math.max(1, Math.min(symbol?.startLine ?? firstChanged, firstChanged - SNIPPET_CONTEXT_LINES))
  let endLine = Math.min(lineCount, Math.max(symbol?.endLine ?? lastChanged, lastChanged + SNIPPET_CONTEXT_LINES))

  if (endLine - startLine + 1 > MAX_SNIPPET_LINES) {
    startLine = Math.max(1, firstChanged - Math.floor(MAX_SNIPPET_LINES / 3))
    endLine = Math.min(lineCount, startLine + MAX_SNIPPET_LINES - 1)
    if (lastChanged > endLine) {
      endLine = Math.min(lineCount, lastChanged + SNIPPET_CONTEXT_LINES)
      startLine = Math.max(1, endLine - MAX_SNIPPET_LINES + 1)
    }
  }

  return { startLine, endLine }
}

function renderNumberedSnippet(
  source: string,
  startLine: number,
  endLine: number,
  changedLineSet: ReadonlySet<number>,
): string {
  const sourceLines = source.split("\n")
  const width = String(endLine).length
  const lines: string[] = []
  for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
    const marker = changedLineSet.has(lineNo) ? ">" : " "
    const text = sourceLines[lineNo - 1] ?? ""
    lines.push(`${marker} ${String(lineNo).padStart(width, " ")} | ${text}`)
  }
  return lines.join("\n")
}

function buildGraphRelations(args: {
  path: string
  graphNodes: readonly GraphContextNode[]
  blastCallerPaths: readonly string[]
  blastDependentPaths: readonly string[]
}): DynamicReviewEvidenceGraphRelation[] {
  const out: DynamicReviewEvidenceGraphRelation[] = []
  const seen = new Set<string>()
  const add = (path: string, relation: string): void => {
    if (!path || path === args.path || seen.has(path)) return
    seen.add(path)
    out.push({ path, relation })
  }

  for (const node of args.graphNodes) {
    add(node.path, `hop${node.hop}/${node.edgeKind}`)
  }
  for (const path of args.blastCallerPaths) add(path, "blast/caller")
  for (const path of args.blastDependentPaths) add(path, "blast/importer")

  return out.slice(0, MAX_GRAPH_RELATIONS_PER_CARD)
}

function buildRetrievalRefs(args: {
  path: string
  symbolName: string | null
  graphPaths: ReadonlySet<string>
  chunks: readonly RetrievedChunk[]
}): DynamicReviewEvidenceRetrievalRef[] {
  const symbolPattern = identifierPattern(args.symbolName)
  const scored = args.chunks
    .map((chunk) => {
      const mentionsSymbol = symbolPattern !== null && symbolPattern.test(chunk.content)
      const graphRelated = args.graphPaths.has(chunk.path)
      const samePath = chunk.path === args.path
      const rank = (mentionsSymbol ? 4 : 0) + (graphRelated ? 2 : 0) - (samePath ? 2 : 0) + chunk.score
      let reason = "retrieval"
      if (mentionsSymbol && graphRelated) reason = "mentions changed symbol + graph-related"
      else if (mentionsSymbol) reason = "mentions changed symbol"
      else if (graphRelated) reason = "graph-related"
      else if (samePath) reason = "same changed path"
      return { chunk, rank, reason }
    })
    .sort((a, b) => b.rank - a.rank)

  return scored
    .filter((s) => s.chunk.path !== args.path || s.reason !== "same changed path")
    .slice(0, MAX_RETRIEVAL_REFS_PER_CARD)
    .map(({ chunk, reason }) => ({
      path: chunk.path,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      score: chunk.score,
      reason,
      excerpt: chunkExcerpt(chunk.content, symbolPattern),
    }))
}

function chunkExcerpt(content: string, symbolPattern: RegExp | null): string {
  const lines = content.split("\n")
  let start = 0
  if (symbolPattern !== null) {
    const hit = lines.findIndex((line) => symbolPattern.test(line))
    if (hit >= 0) start = Math.max(0, hit - 2)
  }
  const excerpt = lines.slice(start, start + MAX_RETRIEVAL_EXCERPT_LINES).join("\n")
  return excerpt.length > MAX_RETRIEVAL_EXCERPT_CHARS
    ? `${excerpt.slice(0, MAX_RETRIEVAL_EXCERPT_CHARS)}…`
    : excerpt
}

function identifierPattern(identifier: string | null): RegExp | null {
  if (identifier === null || identifier.length === 0) return null
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`)
}

function buildTestingContext(
  path: string,
  testingEvidence: TestingEvidencePack | undefined,
): DynamicReviewEvidenceTestingContext {
  if (testingEvidence === undefined) {
    return { siblingRefs: [], inspectedTestFiles: [], helperCoverageRefs: [] }
  }

  const siblingRefs: string[] = []
  const inspectedTestFiles = new Set<string>()
  const helperCoverageRefs: string[] = []
  const mapping = testingEvidence.siblingMappings.find((m) => m.source === path)
  if (mapping) {
    siblingRefs.push(`siblingMapping:${mapping.source}->${mapping.test ?? "NONE"}`)
    if (mapping.test && testingEvidence.inspectedTestFiles.includes(mapping.test)) {
      inspectedTestFiles.add(mapping.test)
    }
  }

  const helperCoverage = testingEvidence.helperCoverageBySource[path]
  if (helperCoverage) {
    const helpers = helperCoverage.helpers.length > 0
      ? ` helpers=${helperCoverage.helpers.slice(0, 3).join(",")}`
      : ""
    const glue = helperCoverage.structurallyGlue ? " structurallyGlue=true" : ""
    helperCoverageRefs.push(`helperCoverage:${path}:${helperCoverage.status}${helpers}${glue}`)
  }

  return {
    siblingRefs: siblingRefs.slice(0, MAX_TEST_REFS_PER_CARD),
    inspectedTestFiles: [...inspectedTestFiles].slice(0, MAX_TEST_REFS_PER_CARD),
    helperCoverageRefs,
  }
}

function renderTestingContextLines(context: DynamicReviewEvidenceTestingContext): string[] {
  const lines: string[] = []
  for (const ref of context.siblingRefs) lines.push(`- ${ref}`)
  for (const path of context.inspectedTestFiles) lines.push(`- inspectedTestFile:${path}`)
  for (const ref of context.helperCoverageRefs) lines.push(`- ${ref}`)
  return lines
}

function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return ext
  return ""
}

function fenceBlock(text: string, language = ""): string {
  const maxBackticks = longestBacktickRun(text)
  const fence = "`".repeat(Math.max(3, maxBackticks + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function longestBacktickRun(text: string): number {
  let longest = 0
  let current = 0
  for (const char of text) {
    if (char === "`") {
      current++
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

function indentBlockLines(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n")
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
