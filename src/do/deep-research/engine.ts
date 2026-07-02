// SIG-298 — the deep-research loop, factored as a pure orchestration function
// over injected IO dependencies (model / search / fetch / emit / clock / cancel
// flag). Keeping the loop dependency-injected is what makes the termination
// quad, the SSE event order, cancellation, and metering testable WITHOUT hitting
// the network. The DO (deep-research-do.ts) wires the real adapters in; tests
// wire fakes.
//
// Loop (spec §3): plan → classify → rounds of { generate queries → parallel
// search → goal-conditioned extraction → synthesize notes → stop-check } →
// final cited report. Termination quad enforced together: maxRounds, maxTimeMs,
// minRounds floor, and a 2-consecutive-empty-round kill.

import {
  buildClassifyPrompt,
  buildExtractionPrompt,
  buildFinalReportPrompt,
  buildPlanPrompt,
  buildQueryPrompt,
  buildStopCheckPrompt,
  buildSynthesisPrompt,
} from "./prompts"
import { isLowQuality, truncate } from "./text-utils"
import type { ResearchModelFn } from "./model"
import type { SearchQueryResult } from "./search"
import type { FetchPageResult } from "./fetch-guard"
import type { QuestionCategory, ResearchConfig, ResearchEvent, ResearchSource } from "./types"

/** Everything the loop needs from the outside world. All IO is here. */
export interface EngineDeps {
  question: string
  runId: string
  config: ResearchConfig
  /** Whether at least one search provider is configured (fail-fast if not). */
  hasSearchProvider: boolean
  emit: (event: ResearchEvent) => Promise<void> | void
  model: ResearchModelFn
  search: (query: string) => Promise<SearchQueryResult>
  fetchPage: (url: string) => Promise<FetchPageResult>
  isCancelled: () => boolean
  now: () => number
}

const MAX_PAGE_CHARS = 12_000
const MAX_REPORT_SOURCES = 30
const VALID_CATEGORIES: QuestionCategory[] = ["factual", "comparative", "howto", "exploratory", "troubleshooting"]
const NO_INFO = "NO RELEVANT INFORMATION"

/**
 * Run the full research loop, emitting the SSE event contract in order. Never
 * throws — any internal failure is surfaced as an `error` event followed by
 * `done`. Always emits a terminal `done`.
 */
export async function runResearchLoop(deps: EngineDeps): Promise<void> {
  try {
    if (!deps.hasSearchProvider) {
      // The single `done` is emitted by the finally below — do not double-emit.
      await deps.emit({ type: "error", message: "no search provider configured" })
      return
    }
    await runInner(deps)
  } catch (err) {
    await deps.emit({ type: "error", message: err instanceof Error ? err.message : String(err) })
  } finally {
    await deps.emit({ type: "done" })
  }
}

async function runInner(deps: EngineDeps): Promise<void> {
  const { config } = deps
  const start = deps.now()
  let tokensUsed = 0
  const track = (n: number): void => {
    tokensUsed += n
  }

  // ── plan ──────────────────────────────────────────────────────────
  await deps.emit({ type: "status", phase: "planning", round: 0 })
  const planPrompt = buildPlanPrompt(deps.question)
  const plan = await deps.model("planner", toMessages(planPrompt))
  track(plan.tokens)
  await deps.emit({ type: "plan", text: plan.text })

  // ── classify ──────────────────────────────────────────────────────
  const category = await classify(deps, track)
  await deps.emit({ type: "note", text: `Question category: ${category}` })

  const sources = new Map<string, ResearchSource>()
  let notes = ""
  let consecutiveEmpty = 0
  let lastRound = 0

  for (let round = 1; round <= config.maxRounds; round++) {
    lastRound = round
    if (deps.isCancelled()) return cancel(deps)
    if (deps.now() - start >= config.maxTimeMs) break

    // ── generate queries ────────────────────────────────────────────
    await deps.emit({ type: "status", phase: "searching", round })
    const queryPrompt = buildQueryPrompt({
      question: deps.question,
      category,
      plan: plan.text,
      notes,
      maxQueries: config.maxQueriesPerRound,
      round,
    })
    const queryResp = await deps.model("planner", toMessages(queryPrompt))
    track(queryResp.tokens)
    const queries = parseQueries(queryResp.text, config.maxQueriesPerRound)
    await deps.emit({ type: "queries", items: queries })

    if (deps.isCancelled()) return cancel(deps)

    // ── parallel web search ─────────────────────────────────────────
    const hits = await runSearches(deps, queries)
    const newHits = dedupeNewHits(hits, sources)
    for (const hit of newHits) {
      const source: ResearchSource = { url: hit.url, title: hit.title || domainOf(hit.url), domain: domainOf(hit.url) }
      if (hit.snippet) source.snippet = hit.snippet
      sources.set(hit.url, source)
      await deps.emit({ type: "source", ...source })
    }

    if (deps.isCancelled()) return cancel(deps)

    // ── fetch + goal-conditioned extraction ─────────────────────────
    await deps.emit({ type: "status", phase: "reading", round })
    const toFetch = newHits.slice(0, config.maxPagesPerRound).map((h) => h.url)
    const pages = await fetchPages(deps, toFetch, config.maxParallelFetches)
    const extractions = await extractPages(deps, pages, track)

    // ── synthesize notes ────────────────────────────────────────────
    await deps.emit({ type: "status", phase: "synthesizing", round })
    const roundText = extractions.join("\n\n").trim()
    const roundEmpty = extractions.length === 0 || isLowQuality(roundText)
    if (!roundEmpty) {
      const synthPrompt = buildSynthesisPrompt({
        question: deps.question,
        existingNotes: notes,
        roundExtractions: roundText,
      })
      const synth = await deps.model("synthesis", toMessages(synthPrompt))
      track(synth.tokens)
      notes = synth.text
      await deps.emit({ type: "note", text: `Round ${round}: integrated ${extractions.length} finding(s).` })
    } else {
      await deps.emit({ type: "note", text: `Round ${round}: no usable information found.` })
    }

    consecutiveEmpty = roundEmpty ? consecutiveEmpty + 1 : 0

    // ── termination checks (respect the minRounds floor) ────────────
    if (round >= config.minRounds) {
      if (consecutiveEmpty >= config.maxEmptyRounds) break
      if (tokensUsed >= config.tokenBudget) break
      if (await stopCheck(deps, notes, track)) break
    }
  }

  // ── final cited report ──────────────────────────────────────────────
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "status", phase: "finalizing", round: lastRound })
  const sourceList = [...sources.values()].slice(0, MAX_REPORT_SOURCES)
  const reportPrompt = buildFinalReportPrompt({ question: deps.question, notes, sources: sourceList })
  const report = await deps.model("finalReport", toMessages(reportPrompt))
  track(report.tokens)
  await deps.emit({ type: "final", markdown: report.text, sources: sourceList })
}

/** Emit the cooperative-cancellation note. `done` is emitted by the caller's finally. */
async function cancel(deps: EngineDeps): Promise<void> {
  await deps.emit({ type: "note", text: "Run cancelled by request." })
}

async function classify(deps: EngineDeps, track: (n: number) => void): Promise<QuestionCategory> {
  const prompt = buildClassifyPrompt(deps.question)
  const resp = await deps.model("classify", toMessages(prompt))
  track(resp.tokens)
  const word = resp.text.toLowerCase().replace(/[^a-z]/g, "")
  return VALID_CATEGORIES.find((c) => word.includes(c)) ?? "exploratory"
}

async function stopCheck(deps: EngineDeps, notes: string, track: (n: number) => void): Promise<boolean> {
  const prompt = buildStopCheckPrompt({ question: deps.question, notes })
  const resp = await deps.model("stopCheck", toMessages(prompt))
  track(resp.tokens)
  return /\bSTOP\b/i.test(resp.text) && !/\bCONTINUE\b/i.test(resp.text)
}

async function runSearches(
  deps: EngineDeps,
  queries: string[],
): Promise<Array<{ url: string; title: string; snippet: string }>> {
  const results = await Promise.all(queries.map((q) => deps.search(q)))
  const hits: Array<{ url: string; title: string; snippet: string }> = []
  for (const r of results) {
    if (r.ok) hits.push(...r.hits.filter((h) => h.url))
  }
  return hits
}

async function fetchPages(
  deps: EngineDeps,
  urls: string[],
  concurrency: number,
): Promise<Array<{ url: string; title: string; domain: string; text: string }>> {
  const pages: Array<{ url: string; title: string; domain: string; text: string }> = []
  await mapWithConcurrency(urls, concurrency, async (url) => {
    const result = await deps.fetchPage(url)
    if (result.ok && result.page.text.trim()) pages.push(result.page)
  })
  return pages
}

async function extractPages(
  deps: EngineDeps,
  pages: Array<{ url: string; title: string; domain: string; text: string }>,
  track: (n: number) => void,
): Promise<string[]> {
  const extractions: string[] = []
  for (const page of pages) {
    const prompt = buildExtractionPrompt({
      question: deps.question,
      pageText: truncate(page.text, MAX_PAGE_CHARS),
      url: page.url,
    })
    const resp = await deps.model("extract", toMessages(prompt))
    track(resp.tokens)
    const text = resp.text.trim()
    if (!text || text.toUpperCase().includes(NO_INFO) || isLowQuality(text)) continue
    extractions.push(`Source: ${page.url}\n${text}`)
  }
  return extractions
}

// ── pure helpers ──────────────────────────────────────────────────────

function toMessages(p: { system: string; user: string }) {
  return [
    { role: "system" as const, content: p.system },
    { role: "user" as const, content: p.user },
  ]
}

function parseQueries(text: string, max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*\d.)\]]+)\s*/, "").trim()
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function dedupeNewHits(
  hits: Array<{ url: string; title: string; snippet: string }>,
  known: Map<string, ResearchSource>,
): Array<{ url: string; title: string; snippet: string }> {
  const seen = new Set<string>()
  const out: Array<{ url: string; title: string; snippet: string }> = []
  for (const hit of hits) {
    if (!hit.url || known.has(hit.url) || seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push(hit)
  }
  return out
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Bounded-concurrency map — never runs more than `limit` tasks at once. */
async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers: Promise<void>[] = []
  const width = Math.max(1, Math.min(limit, items.length))
  for (let i = 0; i < width; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const next = queue.shift()
          if (next === undefined) return
          await task(next)
        }
      })(),
    )
  }
  await Promise.all(workers)
}
