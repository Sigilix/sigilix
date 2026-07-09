// SIG-298 — deep web research engine. Pure types shared across the engine,
// the search/fetch adapters, the DO, and its routes. Type-only leaf: no
// runtime, no IO, no env. The SSE event union below IS the wire contract the
// portal UI is built against — every `data:` line the DO streams is exactly one
// of these objects serialized as JSON. Do not widen it without updating the UI.

/** The coarse phase a `status` event reports for the current round. */
export type ResearchPhase = "planning" | "searching" | "reading" | "synthesizing" | "finalizing"

/** The named model tier for the HEAVY roles (planning/synthesis/stop-check/
 *  final report). Only Boreas exists today; pyroeis/astraeus are named tiers
 *  that map to default model ids (env-overridable per role). */
export type ResearchTier = "boreas" | "pyroeis" | "astraeus"

/** The effort level — scales the loop budgets (rounds / queries / pages / time). */
export type ResearchEffort = "low" | "medium" | "high"

/** A source surfaced during the run. `kind` distinguishes a web hit/page from a
 *  file in the user's own connected repository (the codebase-grounding moat). It
 *  is OPTIONAL and additive — legacy UIs that ignore it treat every source as a
 *  web source, so the existing contract is unchanged. For a repo source `url` is
 *  a GitHub blob URL and `domain` is the `owner/repo` slug (not a hostname). */
export interface ResearchSource {
  url: string
  title: string
  domain: string
  snippet?: string
  kind?: "web" | "repo"
}

/**
 * Codebase grounding gathered BEFORE the loop from the caller's connected +
 * indexed repository, reusing the same retrieval seam the PR-review path uses
 * (`gatherAgentContext`). Present (non-null) only when real code was retrieved.
 * Pure type — the runtime that builds it lives in `repo-grounding.ts`.
 */
export interface RepoGrounding {
  /** The `<owner>/<repo>` index namespace the context came from (lowercased). */
  namespace: string
  /** The packed, prompt-ready grounded slice (learnings → repo map → symbol
   *  bodies → raw chunks) — injected as authoritative repo context. */
  context: string
  /** The repo files to cite ([n] in the answer), most-relevant first. */
  sources: ResearchSource[]
  /** How many code chunks retrieval matched (0 ⇒ conventions-only grounding). */
  chunkCount: number
}

/**
 * The SSE event contract. Each emitted event is exactly one of these, one JSON
 * object per `data:` line. The portal UI matches on `type` — keep the shapes
 * exact.
 */
export type ResearchEvent =
  // The FIRST emitted status (phase "planning", round 0) additionally carries
  // the resolved `model` tier + `effort` so the UI can display them. Every
  // OTHER status event omits those fields (the original contract).
  | { type: "status"; phase: ResearchPhase; round: number; model?: ResearchTier; effort?: ResearchEffort }
  | { type: "plan"; text: string }
  | { type: "queries"; items: string[] }
  | { type: "source"; url: string; title: string; domain: string; snippet?: string; kind?: "web" | "repo" }
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

/** A search provider that can appear in the fallback chain. The order is set by
 *  `OPENCLAW_SEARCH_CHAIN` (default: exa,tavily,brave,selfhost,google-pse); the
 *  first configured provider in the resolved chain serves each query. */
export type SearchProvider = "exa" | "tavily" | "brave" | "serper" | "selfhost" | "google-pse"

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
  /** The resolved model tier for the heavy roles (echoed in the first status). */
  tier: ResearchTier
  /** The resolved effort level (echoed in the first status). */
  effort: ResearchEffort
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
