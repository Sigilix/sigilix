// ARC-189 — Cross-PR review memory types.
//
// Pure types module. No runtime exports beyond literal-union arrays
// for membership testing. The category set is intentionally a SEPARATE
// literal union from `SpecialistRole` (which lives in
// `src/lib/ensemble-router.ts`) — values match 1:1 today, but the
// public memory category name is decoupled so a future internal
// `SpecialistRole` rename would NOT require migrating the
// already-emitted Sigilix comment markers (§4.3 of the spec).

/**
 * Public category name used in:
 *  - the inline-comment marker (`<!-- sigilix:...:cat:<category>:... -->`)
 *  - KV keyspace (`review-memory:<owner>/<repo>:cat:<category>`)
 *  - sigilix.json `reviewMemory.categories`
 *  - rendered prompt block
 *
 * Maps 1:1 onto `SpecialistRole` today via
 * `categoryFromRoleHint()` / `roleHintFromCategory()` in
 * `src/lib/review-memory/marker.ts`.
 */
export type ReviewMemoryCategory =
  | "security"
  | "logic"
  | "performance"
  | "tests"

export const ALL_REVIEW_MEMORY_CATEGORIES: readonly ReviewMemoryCategory[] = [
  "security",
  "logic",
  "performance",
  "tests",
]

export type ReviewMemorySeverityLabel = "info" | "warning" | "error"

export const ALL_REVIEW_MEMORY_SEVERITIES: readonly ReviewMemorySeverityLabel[] = [
  "info",
  "warning",
  "error",
]

/**
 * One captured dismissal signal. Stored inside
 * `ReviewMemoryRecord.signals[]`. Privacy contract (spec §9): NO
 * `evidenceQuote`, NO reviewer login, NO PR title/body — just the
 * structured fields here.
 */
export interface ReviewMemorySignal {
  /** ISO-8601 UTC. Used by the 90d activation filter + 180d retention. */
  ts: string
  /** PR number where the dismissal was observed. */
  prNumber: number
  /**
   * Reply comment ID (the dismissal-bearing comment, NOT the parent
   * Sigilix-posted comment). Used by the dedupe layer; left in the
   * record for forensic correlation back to the GitHub thread.
   */
  commentId: number
  /** sha16 of the parent Sigilix comment's `(ruleId, path, line, headline)`. */
  fid: string
  /** v1 ships only `dismissed-textual`; v2 may add `dismissed-reaction`, etc. */
  kind: "dismissed-textual"
  /**
   * SIG-173: optional canonical reason label from `@sigilix dismiss
   * <reason>`. Absent on signals captured by the textual-dismissal
   * pipeline (those reviewers didn't tag a reason). The activation count
   * weights signals via `weightForReason(dismissReason)`; absent or
   * unknown → weight 1.0 (existing behavior, no surprise softening).
   */
  dismissReason?: import("../dismiss-reasons").DismissReason
}

/**
 * KV record shape. Two parallel keyspaces use this same shape:
 *  - category-only:    `review-memory:<owner>/<repo>:cat:<category>`
 *  - path + category:  `review-memory:<owner>/<repo>:path:<sha256>:cat:<category>`
 *
 * `pathSha256` is present ONLY in the path-scoped variant; the
 * category-only variant omits it. Stored as the FULL SHA-256 hex (not
 * truncated) so collision-prone short hashes never confuse storage.
 * The 12-hex truncation is reserved for human-readable display
 * (markers + prompt rendering).
 *
 * `schemaVersion: 1` enables value-driven schema migration without
 * re-keying (spec §4.4).
 */
export interface ReviewMemoryRecord {
  schemaVersion: 1
  category: ReviewMemoryCategory
  /** Repo-relative-path SHA-256 hex. Present only in path-scoped records. */
  pathSha256?: string
  /** Append-only with FIFO cap of 50 entries; pruned at write-time at >180d. */
  signals: ReviewMemorySignal[]
  /** ISO-8601 UTC; refreshed on every write. */
  lastUpdatedTs: string
}

/**
 * KV-storage scope discriminated union. Used by `buildKey()` in
 * `storage.ts` to derive the canonical key string.
 */
export type ReviewMemoryStorageScope =
  | { kind: "category"; category: ReviewMemoryCategory }
  | {
      kind: "path-category"
      category: ReviewMemoryCategory
      pathSha256: string
    }

/**
 * One memory ready for prompt injection — the lookup-stage output.
 * `pathSha12` (the 12-hex truncation, matching the comment marker) is
 * present only on `scope: "path-category"` findings; ABSENT on
 * `scope: "category"` findings (no per-path scope).
 *
 * `suggestedAction: "soften"` is the only v1 action. `"drop"` is
 * deferred to v2 once telemetry tunes the threshold (spec §4.6).
 */
export interface ReviewMemoryFinding {
  scope: "category" | "path-category"
  category: ReviewMemoryCategory
  pathSha12?: string
  signalCount: number
  /** ISO-8601 UTC of the most recent signal in the active window. */
  lastSignalTs: string
  suggestedAction: "soften"
}

/**
 * Resolved sigilix.json `reviewMemory` config — what the runtime
 * actually consumes after `resolveReviewMemoryConfig()` applies
 * defaults + clamps. Bool fields are strict-bool (literal `true`
 * required to enable; default OFF for both).
 */
export interface ResolvedReviewMemoryConfig {
  enabled: boolean
  captureOnly: boolean
  /**
   * Categories the operator opted in to. Empty array means "all of
   * `ALL_REVIEW_MEMORY_CATEGORIES`" — the parser canonicalizes that
   * default at resolve time so callers can use Set semantics directly.
   */
  categories: readonly ReviewMemoryCategory[]
  /** Clamped `[1, 10]`. Default 5. */
  maxInjectedMemories: number
  /** Clamped `[2, 20]`. Default 3. */
  minSignalThreshold: number
  /** Clamped `[7, 365]`. Default 90. */
  maxSignalAgeDays: number
}

/**
 * Parsed Sigilix comment marker — `extractSigilixMarker()` returns
 * this when a posted Sigilix comment body carries the canonical
 * marker line.
 */
export interface SigilixCommentMarker {
  /** sha16 hex (16 chars). */
  fid: string
  cat: ReviewMemoryCategory
  sev: ReviewMemorySeverityLabel
  /** sha12 hex (12 chars) of the repo-relative path. */
  pathSha12: string
  /**
   * SIG-170: optional location-class tag distinguishing inline review
   * comments from body-fallback comments. Absent on pre-SIG-170 markers
   * (back-compat): callers treat absence as `"inline"`. Present-but-
   * unknown values are accepted by `extractSigilixMarker` and surfaced
   * verbatim for forward-compat — the dismissal pipeline only consults
   * `fid`/`cat` and never branches on `loc`.
   */
  loc?: "inline" | "unanchored"
}

/**
 * Skip reasons emitted by capture + lookup paths. Centralized so
 * telemetry consumers can typecheck the discriminator (spec §6).
 */
export type ReviewMemorySkipReason =
  | "capture-disabled"
  | "retrieval-disabled-env"
  | "retrieval-disabled-config"
  | "not-a-reply"
  | "not-a-reply-to-sigilix"
  | "no-marker-found"
  | "no-dismissal-keyword"
  | "already-seen"
  | "no-paths-to-query"
  | "parent-fetch-failed"
