// Port: the "get relevant context" surface the ensemble uses to ground a review
// — index-backed code-chunk retrieval plus the prior-PR / Linear-issue corpora.
// Method-level (a unified query object is deferred to a later PR). The Vectorize /
// lexical / embedding bindings stay adapter-internal and never appear here; the
// adapter (PR 10/11) holds `env` + the index handles and implements these methods.
// Types only.
//
// COUPLING NOTE (reported): the natural return types — `RetrievedChunk` (from
// `@/lib/retrieval`) and `MultiCorpusResult` / `CorpusHit` (from
// `@/lib/multi-corpus`) — live in lib siblings, so importing them here would be a
// lateral/outward dependency the dependency-rule forbids. Minimal-but-faithful
// result shapes are declared LOCALLY below (they mirror the lib types field-for-
// field). When those chunk types are extracted to a leaf (`domain/` or
// `@/shared/types`), this port should import them instead.

/** A retrieved code chunk. Mirrors `RetrievedChunk` in `@/lib/retrieval`. */
export interface RetrievedChunk {
  /** The deterministic Vectorize/lexical chunk id (for hybrid RRF dedupe). */
  id?: string
  path: string
  lineStart: number
  lineEnd: number
  content: string
  score: number
  /** Which backend(s) surfaced this chunk. Unset = legacy vector-only. */
  source?: "vector" | "lexical" | "hybrid"
  /** Summed reciprocal-rank-fusion score (only set on the hybrid path). */
  rrfScore?: number
}

/** A prior-PR or Linear-issue corpus hit. Mirrors `CorpusHit` in `@/lib/multi-corpus`. */
export interface CorpusHit {
  kind: "pr" | "issue"
  /** "#234" for a PR, "ARC-42" for an issue. */
  ref: string
  /** Verdict (PR) or status (issue) for the labeled prompt block. */
  label: string
  content: string
  score: number
}

/** PR + issue corpus result. Mirrors `MultiCorpusResult` in `@/lib/multi-corpus`. */
export interface MultiCorpusResult {
  pr: CorpusHit[]
  issue: CorpusHit[]
}

export interface RetrievalPort {
  /**
   * Embed the query text and pull top-K ranked code chunks from the index
   * namespace for `teamKey`. Soft-fails to `[]` (the review still runs; the
   * model is instructed to abstain rather than fabricate).
   */
  retrieveChunks(args: { text: string; teamKey: string | null }): Promise<RetrievedChunk[]>

  /**
   * Query the prior-merged-PR and Linear-issue corpora in parallel for the
   * review query. Each leg soft-fails to `[]`.
   */
  retrieveMultiCorpus(
    owner: string,
    repo: string,
    queryText: string,
    opts?: { topK?: number; prNumber?: number; headSha?: string },
  ): Promise<MultiCorpusResult>
}
