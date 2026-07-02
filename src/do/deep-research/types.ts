// SIG-298 — deep web research engine. Pure types shared across the engine,
// the search/fetch adapters, the DO, and its routes. Type-only leaf: no
// runtime, no IO, no env. The SSE event union below IS the wire contract the
// portal UI is built against — every `data:` line the DO streams is exactly one
// of these objects serialized as JSON. Do not widen it without updating the UI.

/** The coarse phase a `status` event reports for the current round. */
export type ResearchPhase = "planning" | "searching" | "reading" | "synthesizing" | "finalizing"

/** A web source surfaced during the run (a search hit or a fetched page). */
export interface ResearchSource {
  url: string
  title: string
  domain: string
  snippet?: string
}

/**
 * The SSE event contract. Each emitted event is exactly one of these, one JSON
 * object per `data:` line. The portal UI matches on `type` — keep the shapes
 * exact.
 */
export type ResearchEvent =
  | { type: "status"; phase: ResearchPhase; round: number }
  | { type: "plan"; text: string }
  | { type: "queries"; items: string[] }
  | { type: "source"; url: string; title: string; domain: string; snippet?: string }
  | { type: "note"; text: string }
  | { type: "final"; markdown: string; sources: ResearchSource[] }
  | { type: "error"; message: string }
  | { type: "done" }

/** The question category the classify step assigns — steers query breadth. */
export type QuestionCategory = "factual" | "comparative" | "howto" | "exploratory" | "troubleshooting"

/** One search hit as returned by a provider adapter, normalized. */
export interface SearchHit {
  url: string
  title: string
  snippet: string
}

/** Result of one provider search: the winning provider + its hits. */
export interface SearchResult {
  provider: SearchProvider
  hits: SearchHit[]
}

/** The ordered search-provider fallback chain (first configured wins). */
export type SearchProvider = "tavily" | "brave" | "serper" | "google-pse"

/** A page successfully fetched + stripped to plain text. */
export interface FetchedPage {
  url: string
  title: string
  domain: string
  text: string
}

/**
 * Resolved, clamped run configuration (from env). All numerics have hard
 * defaults so the engine never depends on unset env. The termination quad is
 * `maxRounds` / `maxTimeMs` / `minRounds` / `maxEmptyRounds`.
 */
export interface ResearchConfig {
  maxRounds: number
  maxTimeMs: number
  minRounds: number
  /** Consecutive empty/low-quality rounds that force a kill. */
  maxEmptyRounds: number
  maxQueriesPerRound: number
  maxPagesPerRound: number
  maxParallelFetches: number
  tokenBudget: number
  /** DO cleanup-alarm horizon after last activity (ms). */
  cleanupAfterMs: number
  models: ResearchModelConfig
}

/** Per-role model ids (env-overridable). */
export interface ResearchModelConfig {
  planner: string
  synthesis: string
  stopCheck: string
  finalReport: string
  classify: string
  extract: string
}

/** The distinct model roles the engine calls. */
export type ResearchModelRole = keyof ResearchModelConfig
