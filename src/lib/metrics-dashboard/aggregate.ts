// sig-metrics-dashboard — pure aggregation for GET /v1/metrics/dashboard.
//
// The route (../metrics-dashboard-route.ts) owns all IO (auth, D1, the KV
// telemetry + review-memory scan, the clock, crypto for fid). This module is
// pure per COMPLIANCE.md's domain-layer bar: plain-in, plain-out, no network,
// no env, no clock — unit-testable with fixtures.
//
// DATA HONESTY (see the route header + the PR body): every number here is
// derived from data Sigilix actually persists. The finding-level breakdowns
// (severity/category/posted/accepted) come from the SAME two KV keyspaces the
// FP-rate ruler reads — `ensemble-review-telemetry:` (posted synth findings,
// each carrying a numeric `score` + `sourceSpecialists`) joined to
// `review-memory:` dismissal signals by (prNumber, fid). We do NOT invent
// severities or categories: severity is BANDED from the finding's real score,
// and category is MAPPED from the finding's real source-specialist role. Keys
// with no real source (dataIntegrity has no producing specialist) are simply
// never emitted — never fabricated as a zero.

// ─── Contract key sets (the portal consumes these verbatim) ───

/** Severity bands. Every posted finding has a numeric score, so all four bands
 *  are an exhaustive banding — a 0 here is an honest "we posted none at this
 *  tier", so the full set is always returned (radar/donut need stable keys). */
export type SeverityKey = "critical" | "major" | "minor" | "trivial"

export const ALL_SEVERITY_KEYS: readonly SeverityKey[] = ["critical", "major", "minor", "trivial"]

/** Category buckets. Only the keys we can MAP from a real source-specialist
 *  role are ever emitted (see `roleToCategory`); `dataIntegrity` and
 *  `maintainability` have no producing specialist in the telemetry corpus and
 *  are therefore never fabricated. */
export type CategoryKey =
  | "functionalCorrectness"
  | "security"
  | "performance"
  | "maintainability"
  | "dataIntegrity"
  | "stability"

export interface SeverityBucket {
  key: SeverityKey
  posted: number
  accepted: number
}

export interface CategoryBucket {
  key: CategoryKey
  posted: number
  accepted: number
}

export interface ReviewCommentsAgg {
  posted: number
  /** 1 - dismissalRate; null when nothing was posted (rate undefined). */
  acceptanceRate: number | null
  /** posted - distinctDismissed; the reviewer-time-saved base. */
  accepted: number
  severity: SeverityBucket[]
  category: CategoryBucket[]
}

/**
 * One posted synthesizer finding, reduced to what the aggregation needs. `key`
 * is the (prNumber:fid) join key the route computes with `computeFid` — the
 * SAME key the dismissal set is keyed by, so a finding is "accepted" iff its
 * key is NOT in the dismissed set. `roles` are the finding's real
 * source-specialist roles (telemetry `provenance`), used only to map category.
 */
export interface PostedFinding {
  key: string
  score: number
  roles: string[]
}

// ─── Score → severity band (grounded in the real scoring) ─────

/**
 * Band a finding's numeric score to a severity tier. Grounded in the
 * codebase's own scoring semantics (src/lib/ensemble/render/finding-format.ts:
 * "score 5 → P0 (critical)", "score 4 → P1 (major)") and the review-memory
 * marker banding (score ≥ 5 error, ≥ 3 warning). NOT a fabricated mapping —
 * every posted finding already carries this score.
 */
export function scoreToSeverity(score: number): SeverityKey {
  if (score >= 5) return "critical"
  if (score >= 4) return "major"
  if (score >= 3) return "minor"
  return "trivial"
}

// ─── Role → category (only real, unambiguous mappings) ────────

/**
 * Map a real source-specialist role to a contract category key. Only the four
 * specialist roles that actually produce telemetry are mapped:
 *   logic       → functionalCorrectness  (the logic specialist finds correctness bugs)
 *   security    → security
 *   performance → performance
 *   tests       → stability              (the tests specialist guards regressions)
 * Any other/unknown role → null (dropped, never coerced into a bucket). The
 * contract's `maintainability` and `dataIntegrity` keys have NO producing
 * specialist, so they are never emitted rather than fabricated as zeros.
 */
export function roleToCategory(role: string): CategoryKey | null {
  switch (role) {
    case "logic":
      return "functionalCorrectness"
    case "security":
      return "security"
    case "performance":
      return "performance"
    case "tests":
      return "stability"
    // `architecture` is a review-memory category, not a telemetry role, but map
    // it defensively in case a future producer emits it.
    case "architecture":
      return "maintainability"
    default:
      return null
  }
}

// Deterministic priority when a finding carries several roles — the finding is
// attributed to exactly ONE category (its highest-priority mapped role) so the
// per-category `posted` sums stay coherent with the overall posted count.
const CATEGORY_PRIORITY: readonly CategoryKey[] = [
  "security",
  "functionalCorrectness",
  "performance",
  "stability",
  "maintainability",
  "dataIntegrity",
]

function primaryCategory(roles: string[]): CategoryKey | null {
  const mapped = new Set<CategoryKey>()
  for (const r of roles) {
    const c = roleToCategory(r)
    if (c) mapped.add(c)
  }
  for (const c of CATEGORY_PRIORITY) {
    if (mapped.has(c)) return c
  }
  return null
}

// ─── The aggregation ──────────────────────────────────────────

/**
 * Aggregate posted findings + the dismissed-key set into the review-comment
 * block. `findings` may contain duplicate keys (the same finding re-posted
 * across pushes of a PR) — they are de-duped by `key` so a finding counts once.
 * A finding is ACCEPTED iff its key is not in `dismissedKeys`.
 *
 * Pure: no IO, no clock. `dismissedKeys` is precomputed by the route from the
 * review-memory signals (same (prNumber:fid) keyspace).
 */
export function aggregateReviewComments(
  findings: readonly PostedFinding[],
  dismissedKeys: ReadonlySet<string>,
): ReviewCommentsAgg {
  // De-dupe by join key — keep the first occurrence (score/roles are stable per
  // fid; reruns re-post the same finding).
  const byKey = new Map<string, PostedFinding>()
  for (const f of findings) {
    if (!byKey.has(f.key)) byKey.set(f.key, f)
  }

  const sev: Record<SeverityKey, { posted: number; accepted: number }> = {
    critical: { posted: 0, accepted: 0 },
    major: { posted: 0, accepted: 0 },
    minor: { posted: 0, accepted: 0 },
    trivial: { posted: 0, accepted: 0 },
  }
  const cat = new Map<CategoryKey, { posted: number; accepted: number }>()

  let posted = 0
  let accepted = 0
  for (const f of byKey.values()) {
    posted += 1
    const isAccepted = !dismissedKeys.has(f.key)
    if (isAccepted) accepted += 1

    const band = scoreToSeverity(f.score)
    sev[band].posted += 1
    if (isAccepted) sev[band].accepted += 1

    const category = primaryCategory(f.roles)
    if (category) {
      const entry = cat.get(category) ?? { posted: 0, accepted: 0 }
      entry.posted += 1
      if (isAccepted) entry.accepted += 1
      cat.set(category, entry)
    }
  }

  const severity: SeverityBucket[] = ALL_SEVERITY_KEYS.map((key) => ({
    key,
    posted: sev[key].posted,
    accepted: sev[key].accepted,
  }))

  // Category: only keys we genuinely observed (never a fabricated 0), in the
  // fixed priority order so the portal gets a stable sequence.
  const category: CategoryBucket[] = CATEGORY_PRIORITY.filter((k) => cat.has(k)).map((key) => {
    const e = cat.get(key)!
    return { key, posted: e.posted, accepted: e.accepted }
  })

  return {
    posted,
    acceptanceRate: posted > 0 ? accepted / posted : null,
    accepted,
    severity,
    category,
  }
}

// ─── Reviewer-time-saved estimate ─────────────────────────────

/**
 * ESTIMATE ONLY (portal renders "(est.)"): assumes each accepted review comment
 * saves a human reviewer ~MIN_PER_COMMENT minutes of manual review. This is a
 * heuristic, NOT a measured quantity — there is no timing instrumentation.
 */
export const MIN_PER_COMMENT = 5

export function reviewerTimeSavedHours(acceptedFindings: number): number {
  if (!Number.isFinite(acceptedFindings) || acceptedFindings <= 0) return 0
  return (acceptedFindings * MIN_PER_COMMENT) / 60
}

// ─── avgReviewIterationsPerPr (pure math over D1 counts) ──────

/**
 * Average distinct commits reviewed per PR = total usage_ledger rows / distinct
 * PRs (usage_ledger dedupes on (installation, repo, pr, head_sha), so each row
 * is a distinct reviewed commit). null when there are no PRs (undefined ratio).
 */
export function avgReviewIterationsPerPr(totalRows: number, distinctPrs: number): number | null {
  if (distinctPrs <= 0) return null
  return totalRows / distinctPrs
}
