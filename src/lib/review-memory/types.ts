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
  | "architecture"

export const ALL_REVIEW_MEMORY_CATEGORIES: readonly ReviewMemoryCategory[] = [
  "security",
  "logic",
  "performance",
  "tests",
  "architecture",
]

export type ReviewMemorySeverityLabel = "info" | "warning" | "error"

export const ALL_REVIEW_MEMORY_SEVERITIES: readonly ReviewMemorySeverityLabel[] = [
  "info",
  "warning",
  "error",
]

/**
 * SIG-247 Phase 2 (SIG-276): enum-bounded vocabulary for structured
 * claims that classify what a Sigilix finding ASSERTS. Claims are
 * extracted at finding-WRITE time from the bot's own finding (NOT from
 * the reviewer's dismissal reply — that would be low-coverage and would
 * pull reviewer free-text into the webhook path, breaking the privacy
 * contract). They ride the comment marker to the dismissal-capture path,
 * where Phase 2 PR B copies them onto the signal so memory can generalize
 * on the SPECIFIC pattern a team dismisses, not just its category.
 *
 * Each claim is enum-bounded — no free-text fields that could carry PII.
 * The vocabulary grows by telemetry-tuned expansion, not ad-hoc additions.
 */
export type ReviewMemoryClaimType =
  | "auth-gate-is-boundary"
  | "structural-glue-not-test-target"
  | "globally-unique-id-is-tenant-isolation"
  | "rethrowing-catch-not-swallowed"

export const ALL_REVIEW_MEMORY_CLAIM_TYPES: readonly ReviewMemoryClaimType[] = [
  "auth-gate-is-boundary",
  "structural-glue-not-test-target",
  "globally-unique-id-is-tenant-isolation",
  "rethrowing-catch-not-swallowed",
]

export interface ReviewMemoryClaim {
  /** Stable per-claim id — sha16 of the canonical `extractorVersion:type` form. */
  id: string
  /** Enum-bounded claim type. v0 starts narrow; expands per SIG-244 bake-off data. */
  type: ReviewMemoryClaimType
  /**
   * Confidence 0.0-1.0 from the extractor. Used at activation-time
   * weighting — low-confidence claims need more independent signals
   * to activate.
   */
  confidence: number
  /** Schema/version of the extractor that produced this claim. */
  extractorVersion: number
}

/**
 * The serialized subset of a claim carried in the comment marker
 * (SIG-276 Phase 2). The `id` is OMITTED on purpose: it is derivable
 * from `extractorVersion:type` and is recomputed at capture time
 * (PR B), so encoding it in the marker would just waste marker width.
 * `buildSigilixMarker` serializes this shape; `extractSigilixMarker`
 * parses it back.
 */
export type ReviewMemoryClaimMarkerData = Omit<ReviewMemoryClaim, "id">

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
  /**
   * SIG-276 Phase 2: the write-time claims the dismissed finding
   * asserted, copied off the parent comment's marker at capture time
   * (PR B) with each `id` recomputed via `hydrateClaimIds`. These
   * classify the BOT's finding, NOT the reviewer's reply text — the
   * privacy contract is unchanged (enum-bounded, no free-text payload).
   * Optional and absent on legacy/claimless markers and on signals
   * written before the extractor shipped. Phase 3+ uses the claims at
   * injection time so the bot can soften the SPECIFIC pattern the team
   * dismissed, not just the category as a whole.
   */
  claims?: ReviewMemoryClaim[]
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
  /**
   * SIG-247 Phase 1 PR B: ISO-8601 UTC stamped by the migration helper
   * when this record was first copied from the legacy keyspace into
   * the new `repo:<id>` keyspace. Sticky across subsequent
   * `appendSignal` + `unionRecords` cycles — the original timestamp is
   * preserved on every write so Phase 5 cleanup can treat this as
   * evidence the record went through migration BEFORE the cleanup
   * window started.
   *
   * Absent on:
   *   - records that were never migrated (pure capture-only writes
   *     into the new keyspace post-Phase-1 deploy)
   *   - legacy-key records (the sentinel only exists on the new key)
   */
  migratedAt?: string
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
 * SIG-276 Phase 3: a per-claim-type aggregate over the dismissal signals
 * backing an active memory, computed by `aggregateShadowClaims` in
 * `lookup.ts`. TELEMETRY-ONLY — it never drives softening in Phase 3
 * (the shadow matcher reads it to emit the `review-memory-claim-shadow`
 * corpus Phase 4 calibrates on). All fields are enum-bounded or numeric;
 * NO free-text (privacy contract §9).
 */
export interface ReviewMemoryShadowClaim {
  /** The matched claim enum (the stable match key — NOT the derived id). */
  type: ReviewMemoryClaimType
  /** DISTINCT `signal.prNumber` carrying this claim type — NOT raw signal rows. */
  distinctPrCount: number
  /** Raw count of signals carrying this claim type (for Phase-4 comparison). */
  signalCount: number
  /** ISO-8601 UTC of the most recent signal carrying this claim type. */
  lastSignalTs: string
  /** Distinct extractor versions seen for this type (telemetry; spots drift). */
  extractorVersions: number[]
  /** Raw (uncalibrated) confidences — telemetry ONLY, do NOT gate on these. */
  rawConfidences: number[]
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
  /**
   * SIG-276 Phase 3: per-claim-type aggregates over the signals backing
   * this memory. Populated by `runReviewMemoryLookup` ONLY when the
   * `OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW` flag is on; absent otherwise.
   * TELEMETRY-ONLY — `render.ts` and `selectTopMemories` ignore it, and
   * NOTHING in the posting path consumes it (it never changes softening).
   */
  shadowClaims?: ReviewMemoryShadowClaim[]
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
  /**
   * SIG-280 Phase 4: per-repo opt-in for claim-driven softening. Strict-bool,
   * default false. Surfaced in PR A; the Phase 4 PR C soften gate consumes it
   * (requires BOTH this AND env `OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW=soften`).
   */
  claimSoftening: boolean
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
  /**
   * SIG-276 Phase 2: structured claims the finding asserted, serialized
   * into the optional `:claims:` marker segment. Absent on pre-Phase-2
   * markers and on findings the extractor produced no claim for. Carries
   * the id-less `ReviewMemoryClaimMarkerData` shape; the capture path
   * (PR B) recomputes each `id` before storing the claim on a signal.
   * Unknown / malformed claim entries are dropped on parse (forward-compat
   * with future enum values, mirroring the `loc` precedent).
   */
  claims?: ReviewMemoryClaimMarkerData[]
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
