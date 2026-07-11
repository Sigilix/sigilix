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
  buildDirectAnswerPrompt,
  buildExtractionPrompt,
  buildFinalReportPrompt,
  buildPlanPrompt,
  buildQueryPrompt,
  buildRepoAnswerPrompt,
  buildStopCheckPrompt,
  buildSynthesisPrompt,
  NO_REPO_ANSWER,
} from "./prompts"
import { isCodebaseQuestion, isLowQuality, isTrivialMessage, truncate } from "./text-utils"
import type { ResearchModelFn } from "./model"
import type { ResearchMcpRuntime } from "./mcp-runtime"
import { describeMcpEvidence, selectMcpEvidence, withMcpEvidence, type ResearchMcpEvidence } from "./mcp-tools"
import type { SearchQueryResult } from "./search"
import type { FetchPageResult } from "./fetch-guard"
import type {
  QuestionCategory,
  RepoGrounding,
  ResearchConfig,
  ResearchEvent,
  ResearchMode,
  ResearchSource,
} from "./types"

/** Everything the loop needs from the outside world. All IO is here. */
export interface EngineDeps {
  question: string
  runId: string
  config: ResearchConfig
  /** Whether at least one search provider is configured. When false the loop
   *  degrades gracefully to a model-only answer (see `runDirectAnswer`) instead
   *  of running the search rounds. */
  hasSearchProvider: boolean
  /** Codebase grounding gathered before the loop from the caller's connected +
   *  indexed repository (null/undefined when nothing was grounded). When present,
   *  a codebase question is answered from real repo files with file-path citations;
   *  otherwise it augments the web answer. See `repo-grounding.ts`. */
  repoGrounding?: RepoGrounding | null
  /** Whether the caller has ANY indexed repo. Lets a codebase question with NO
   *  connected repo return a clear "connect a repo" answer instead of a generic one. */
  hasIndexedRepo?: boolean
  /** The run mode from the portal's Deep Research toggle. `"chat"` (toggle off) is
   *  a plain conversational reply — one direct model call, repo-grounded when the
   *  question is about the caller's code, but never a web-search run. `"deep"` (or
   *  undefined, the back-compat default) runs the full web-research pipeline. */
  mode?: ResearchMode
  emit: (event: ResearchEvent) => Promise<void> | void
  model: ResearchModelFn
  /** Verified installation-scoped read-only MCP runtime. Omitted when the
   *  caller has no positively authorized tenant selector. */
  mcp?: ResearchMcpRuntime
  search: (query: string) => Promise<SearchQueryResult>
  fetchPage: (url: string) => Promise<FetchPageResult>
  isCancelled: () => boolean
  now: () => number
}

// Per-page char cap on web content packed into the extraction prompt. Was 12k
// (~3k tokens) — an artificial clip that starved the model of page context. Lifted
// to ~48k tokens/page so the chat fills its window; the ~1.5MB fetch-guard byte cap
// (fetch-guard.ts) remains the real upper bound on any single page.
const MAX_PAGE_CHARS = 192_000
const MAX_REPORT_SOURCES = 30
const VALID_CATEGORIES: QuestionCategory[] = ["factual", "comparative", "howto", "exploratory", "troubleshooting"]
const NO_INFO = "NO RELEVANT INFORMATION"

/** The note shown when Deep Research is ON but no search provider is configured —
 *  the run still answers from the model instead of erroring. Declared here (above
 *  its use in runResearchLoop) so there's no doubt it's initialized at call time. */
const NO_SEARCH_NOTE = "Live web search isn't enabled — answering from the model's knowledge."

/**
 * Run the full research loop, emitting the SSE event contract in order. Never
 * throws — any internal failure is surfaced as an `error` event followed by
 * `done`. Always emits a terminal `done`.
 *
 * Routing: a greeting / trivial message short-circuits to a direct reply; Deep
 * Research OFF (`mode: "chat"`) answers conversationally with one direct model call
 * (repo-grounded for codebase questions) and NO web search; Deep Research ON runs
 * the full pipeline. When NO search provider is configured a run that would have
 * web-searched DEGRADES GRACEFULLY to a model-only answer with a clear (non-error)
 * note rather than erroring. See `runDirectAnswer`.
 */
export async function runResearchLoop(deps: EngineDeps): Promise<void> {
  try {
    // Greeting / trivial small-talk ("hey!", "thanks") → a short, direct, friendly
    // reply with NO web research and NO repo retrieval, regardless of the Deep
    // Research toggle. This is the cheap guard that stops a casual message from
    // kicking off a multi-round web run (the "hey!" → 23s SearXNG essay bug).
    if (isTrivialMessage(deps.question)) {
      await runDirectAnswer(deps)
      return
    }

    const codebaseQ = isCodebaseQuestion(deps.question)
    // Deep Research OFF → a plain conversational turn: a single direct model call,
    // repo-grounded when the question is about the caller's own code, but never a
    // web-search / multi-round research run.
    const conversational = deps.mode === "chat"

    // Repo grounding retrieved real code → answer from the user's OWN codebase.
    // A codebase question (or no web provider configured) is answered DIRECTLY from
    // the repo with file-path citations — no web rounds. Grounding augments a
    // CODEBASE question only: a general/non-codebase question is never forced into
    // repo context just because the caller has a repo connected.
    if (deps.repoGrounding) {
      if (codebaseQ || !deps.hasSearchProvider) {
        await runRepoGrounded(deps, deps.repoGrounding, await gatherMcpEvidence(deps))
        return
      }
      // Non-codebase question with a connected repo: deep mode folds the repo
      // context into the web loop as authoritative augmentation. Chat mode never
      // web-searches, so it falls through to a plain direct answer below.
      if (!conversational) {
        await runInner(deps, await gatherMcpEvidence(deps))
        return
      }
    }

    // Codebase question but NO indexed repo connected → tell them to connect one
    // instead of answering from generic knowledge (the broken-moat repro).
    if (codebaseQ && !deps.hasIndexedRepo) {
      await runNoRepo(deps)
      return
    }

    // Conversational mode (Deep Research OFF) or no web provider → a single direct
    // model answer, no web search. Only the no-provider DEGRADATION shows the note;
    // a conversational reply doesn't — the user turned Deep Research off, so "web
    // search isn't enabled" would be misleading noise.
    if (conversational || !deps.hasSearchProvider) {
      await runDirectAnswer(deps, conversational ? undefined : NO_SEARCH_NOTE, await gatherMcpEvidence(deps))
      return
    }

    await runInner(deps, await gatherMcpEvidence(deps))
  } catch (err) {
    await deps.emit({ type: "error", message: err instanceof Error ? err.message : String(err) })
  } finally {
    await deps.emit({ type: "done" })
  }
}

/**
 * A single direct, conversational model answer with NO web search — the plain-chat
 * reply (Deep Research off), a greeting / trivial message, or the graceful
 * degradation when no search provider is configured. Emits the same first `status`
 * (so the UI still gets the resolved model + effort), an OPTIONAL non-error `note`,
 * then answers straight from the model and emits a `final` with an empty source
 * list. The caller's `finally` emits the single terminal `done`.
 */
async function runDirectAnswer(
  deps: EngineDeps,
  note?: string,
  mcpEvidence?: ResearchMcpEvidence | null,
): Promise<void> {
  const { config } = deps
  await deps.emit({ type: "status", phase: "planning", round: 0, model: config.tier, effort: config.effort })
  if (mcpEvidence) await deps.emit({ type: "note", text: describeMcpEvidence(mcpEvidence) })
  if (note) await deps.emit({ type: "note", text: note })
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "status", phase: "finalizing", round: 0 })
  const answer = await deps.model(
    "finalReport",
    toMessages(withMcpEvidence(buildDirectAnswerPrompt(deps.question), mcpEvidence)),
  )
  // Re-check after the (awaited) model call so a /cancel that lands mid-answer
  // wins the race — emit the cancel note instead of a stale final.
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "final", markdown: answer.text, sources: [] })
}

/**
 * Repo-grounded answer: the question is about the user's OWN connected codebase
 * and we retrieved real code for it. Emit the repo files as sources (so they get
 * the [1..k] citation numbers), then answer straight from the grounded repository
 * context — no web rounds. This is the moat: "where does X live in our repo?" now
 * answers with real file paths instead of a generic web essay.
 */
async function runRepoGrounded(
  deps: EngineDeps,
  grounding: RepoGrounding,
  mcpEvidence?: ResearchMcpEvidence | null,
): Promise<void> {
  const { config } = deps
  await deps.emit({ type: "status", phase: "planning", round: 0, model: config.tier, effort: config.effort })
  if (mcpEvidence) await deps.emit({ type: "note", text: describeMcpEvidence(mcpEvidence) })
  await deps.emit({
    type: "note",
    text: `Grounding this answer in your connected repository (${grounding.namespace}).`,
  })
  for (const source of grounding.sources) {
    await deps.emit({ type: "source", ...source })
  }
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "status", phase: "finalizing", round: 0 })
  const prompt = buildRepoAnswerPrompt({
    question: deps.question,
    repoContext: grounding.context,
    sources: grounding.sources,
  })
  const answer = await deps.model("finalReport", toMessages(withMcpEvidence(prompt, mcpEvidence)))
  // Re-check after the awaited model call so a mid-answer /cancel wins the race.
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "final", markdown: answer.text, sources: grounding.sources })
}

/**
 * No-repo answer: the question is clearly about the caller's own codebase, but no
 * repository is connected/indexed for them. Say so clearly (connect + index a
 * repo) instead of answering generically. No model call — a fixed, honest message.
 */
async function runNoRepo(deps: EngineDeps): Promise<void> {
  const { config } = deps
  await deps.emit({ type: "status", phase: "planning", round: 0, model: config.tier, effort: config.effort })
  if (deps.isCancelled()) return cancel(deps)
  await deps.emit({ type: "status", phase: "finalizing", round: 0 })
  await deps.emit({ type: "final", markdown: NO_REPO_ANSWER, sources: [] })
}

async function runInner(deps: EngineDeps, mcpEvidence?: ResearchMcpEvidence | null): Promise<void> {
  const { config } = deps
  const start = deps.now()
  let tokensUsed = mcpEvidence?.tokens ?? 0
  const track = (n: number): void => {
    tokensUsed += n
  }

  // ── plan ──────────────────────────────────────────────────────────
  // ONLY this first status carries model + effort (the UI reads them here);
  // every other status event omits them (the original contract shape).
  await deps.emit({ type: "status", phase: "planning", round: 0, model: config.tier, effort: config.effort })
  if (mcpEvidence) await deps.emit({ type: "note", text: describeMcpEvidence(mcpEvidence) })
  const planPrompt = withMcpEvidence(buildPlanPrompt(deps.question), mcpEvidence)
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

  // Fold repo grounding (when present) into the web loop as AUTHORITATIVE context:
  // seed the repo files FIRST so they take the low [1..k] citation numbers, and
  // thread the packed repo context into synthesis + the final report so the answer
  // prefers and cites the user's own code for codebase claims while web fills in
  // genuinely external facts.
  const repoContext = deps.repoGrounding?.context?.trim() ? deps.repoGrounding.context : undefined
  if (deps.repoGrounding) {
    for (const source of deps.repoGrounding.sources) {
      if (sources.has(source.url)) continue
      sources.set(source.url, source)
      await deps.emit({ type: "source", ...source })
    }
  }

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
        ...(repoContext ? { repoContext } : {}),
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
  const reportPrompt = buildFinalReportPrompt({
    question: deps.question,
    notes,
    sources: sourceList,
    ...(repoContext ? { repoContext } : {}),
  })
  const report = await deps.model("finalReport", toMessages(withMcpEvidence(reportPrompt, mcpEvidence)))
  track(report.tokens)
  await deps.emit({ type: "final", markdown: report.text, sources: sourceList })
}

async function gatherMcpEvidence(deps: EngineDeps): Promise<ResearchMcpEvidence | null> {
  if (!deps.mcp || deps.isCancelled()) return null
  try {
    return await selectMcpEvidence({
      question: deps.question,
      model: deps.model,
      runtime: deps.mcp,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "research-mcp-evidence-failed",
        err: err instanceof Error ? err.name : "unknown",
      }),
    )
    return null
  }
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
