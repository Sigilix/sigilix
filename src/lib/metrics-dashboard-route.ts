// sig-metrics-dashboard — GET /v1/metrics/dashboard.
//
// Powers the portal's metrics dashboard (headline tiles + severity radar/donut
// + category breakdown + CodeRabbit-style Repository / Username / Teams
// filters). Dual-authed (portal session cookie OR bearer api key — mirrors
// org-overview-route.ts / workspace-prs-route.ts) and tenant-scoped to the
// caller's own installation(s). CORS'd for the portal origins (wired into
// index.ts's isPortalCorsPath alongside /v1/org/overview).
//
// DATA HONESTY (the whole point of this endpoint — see the shared contract):
// every field is aggregated ONLY from data Sigilix actually persists. Fields
// with a real source are computed; fields with NO source are returned `null`
// so the portal renders "Coming soon" — nothing is fabricated.
//
//   REAL (D1 usage_ledger, installation-scoped, bound `?` params):
//     - activeRepos             distinct repo_id in window
//     - mergedPrs.total         distinct (repo_id, pr_number) in window. NOTE:
//                               usage_ledger has NO merge column — this is
//                               "distinct PRs Sigilix reviewed", the honest
//                               substitute (there is no GitHub merge-state
//                               store; medianTime.mergeMin is null for the same
//                               reason).
//     - mergedPrs.avgPerUser    total / distinct active authors
//     - activeUsers.assigned    distinct non-null author_login (identified)
//     - activeUsers.unassigned  usage rows with NULL author_login (review
//                               events we could not attribute to a login)
//     - avgReviewIterationsPerPr total rows / distinct PRs (rows = distinct
//                               reviewed commits, per the UNIQUE constraint)
//     - facets.repos / .users   the caller's available filter options
//
//   REAL (KV `ensemble-review-telemetry:` + `review-memory:`, the SAME corpus
//   the FP-rate ruler reads — bounded scan, scoped to the caller's repo slugs):
//     - reviewComments.posted           distinct posted synth findings in window
//     - reviewComments.acceptanceRate   1 - dismissed/posted (fp-rate join)
//     - reviewerTimeSavedHours          ESTIMATE: accepted * MIN_PER_COMMENT/60
//     - severity[]                      posted/accepted banded from real score
//     - category[]                      posted/accepted mapped from real role
//
//   NULL (no source — never fabricated):
//     - chatUsage        portal chat is a separate repo; not instrumented here
//     - medianTime       no merge/last-commit timestamps are persisted
//     - toolFindings     tracked ONLY in a single GLOBAL RunnerToolMetrics DO
//                        with no per-installation scoping — returning it would
//                        LEAK cross-tenant tool counts, so it is null by design
//     - pipelineFailures CI triage is post-and-forget; no aggregate is stored
//
// Tenant isolation (CRITICAL): the D1 reads filter on the caller's exact
// installation_id set via bound `?` placeholders (never string-concatenated);
// the KV scan matches only repo slugs owned by the caller. Every filter (repo /
// user / team) is validated against the caller's own installation and can only
// NARROW the scope — a filter value the caller doesn't own is ignored, never
// widening past the tenant boundary.
//
// Fail-soft: each field is computed in its own try/catch and degrades to its
// zero/empty/null value rather than throwing — the dashboard never 500s on a
// D1 or KV fault (auth 401 is the only non-2xx path). A missing session key or
// a token-decrypt failure degrades to an empty scope at 200 (mirrors
// org-overview-route.ts), never a cross-tenant read.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { listKeys, mapWithConcurrency, FETCH_CONCURRENCY } from "@/src/lib/kv-scan"
import { computeFid } from "@/src/lib/review-memory/marker"
import { mapTelemetryToReview, mapSignalRecord } from "@/src/lib/fp-rate/ingest"
import { filterReviewsToWindow } from "@/src/lib/fp-rate/window"
import { dedupeDismissals, findingKey, GUARD_SKIP_REASONS } from "@/src/lib/fp-rate/attribute"
import {
  aggregateReviewComments,
  avgReviewIterationsPerPr,
  reviewerTimeSavedHours,
  type CategoryBucket,
  type PostedFinding,
  type SeverityBucket,
} from "@/src/lib/metrics-dashboard/aggregate"
import type { Env } from "@/src/shared/types/env"

// Defensive pagination cap on GET /user/installations — mirrors the sibling
// portal routes.
const MAX_INSTALLATION_PAGES = 20

// Facet caps — generous relative to any real org, purely to bound an anomalous
// installation from an unbounded scan.
const FACET_REPO_LIMIT = 1000
const FACET_USER_LIMIT = 1000

// KV scan bounds — mirror metrics-fp-rate-route.ts exactly (same corpus, same
// Workers 1000-subrequest ceiling budgeting).
const TELEMETRY_PREFIX = "ensemble-review-telemetry:"
const MEMORY_PREFIX = "review-memory:"
const TELEMETRY_LIST_SCAN = 10_000
const MEMORY_LIST_SCAN = 4_000
const MAX_TELEMETRY_FETCH = 700
const MAX_MEMORY_FETCH = 200

const DAY_MS = 24 * 60 * 60 * 1000
const ALLOWED_WINDOW_DAYS = [7, 30, 90] as const
const DEFAULT_WINDOW_DAYS = 30

// ─── Response shape (portal consumes this verbatim) ───────────

export interface MetricsDashboardResponse {
  window: string
  activeRepos: number
  mergedPrs: { total: number; avgPerUser: number }
  activeUsers: { assigned: number; unassigned: number }
  reviewComments: { posted: number; acceptanceRate: number | null }
  reviewerTimeSavedHours: number | null
  avgReviewIterationsPerPr: number | null
  severity: SeverityBucket[]
  category: CategoryBucket[]
  chatUsage: { sessions: number; messages: number } | null
  medianTime: { mergeMin: number; lastCommitMin: number } | null
  toolFindings: { sast: number; linter: number; other: number } | null
  pipelineFailures: number | null
  facets: {
    repos: Array<{ id: number; name: string }>
    users: Array<{ login: string }>
    teams: Array<{ id: string; name: string }>
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: Array<{ id?: number }>
}

/** Every installation id the session's GitHub user-to-server token can see. Soft-fails to []. */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

// ─── Param parsing ────────────────────────────────────────────

/** window ∈ {7d,30d,90d}; default 30d. Returns null on an unsupported value. */
function parseWindowDays(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  return (ALLOWED_WINDOW_DAYS as readonly number[]).includes(n) ? n : null
}

/** Repeatable + comma-separated param → trimmed, non-empty segments. */
function parseCsvParam(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "")
}

// ─── Resolved caller scope ────────────────────────────────────

/** The ledger scan scope: the caller's owned installation ids, or "all" for the
 *  legacy global key (Sigilix-internal, never handed to a tenant). */
type LedgerScope = number[] | "all"

/**
 * Resolve a portal session to its owned installation ids. Best-effort: a
 * missing session-encryption key or a token-decrypt failure degrades to an
 * empty scope (telemetered) rather than throwing — a genuinely empty dashboard,
 * never a cross-tenant read (mirrors org-overview-route.ts's degraded posture).
 */
async function resolveSessionScope(env: Env, session: AuthedSession): Promise<LedgerScope> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "metrics-dashboard-encryption-key-missing" }))
    return []
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "metrics-dashboard-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
  return await fetchUserInstallationIds(accessToken)
}

// ─── D1 reads (tenant-scoped, bound params) ───────────────────

/** Build the `installation_id IN (...)` fragment + binds for a non-"all" scope. */
function installationFilter(scope: LedgerScope, column: string): { clause: string; binds: number[] } {
  if (scope === "all") return { clause: "", binds: [] }
  return { clause: `${column} IN (${scope.map(() => "?").join(",")})`, binds: [...scope] }
}

interface AllowedRepo {
  id: number
  name: string
}

/** The caller's repos (facets + repo-filter validation). Fail-soft to []. */
async function readAllowedRepos(env: Pick<Env, "SIGILIX_PLATFORM_DB">, scope: LedgerScope): Promise<AllowedRepo[]> {
  if (!env.SIGILIX_PLATFORM_DB) return []
  if (scope !== "all" && scope.length === 0) return []
  try {
    const inst = installationFilter(scope, "installation_id")
    const sql =
      "SELECT repo_id AS id, full_name AS name FROM repo" +
      (inst.clause ? ` WHERE ${inst.clause}` : "") +
      " ORDER BY full_name LIMIT ?"
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(sql)
      .bind(...inst.binds, FACET_REPO_LIMIT)
      .all<{ id: unknown; name: unknown }>()
    const byId = new Map<number, AllowedRepo>()
    for (const r of results) {
      const id = Number(r.id)
      const name = typeof r.name === "string" ? r.name : ""
      if (Number.isInteger(id) && name !== "" && !byId.has(id)) byId.set(id, { id, name })
    }
    return [...byId.values()]
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metrics-dashboard-repos-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}

/** The caller's distinct active authors (facets + user-filter validation). Fail-soft to []. */
async function readAllowedUsers(env: Pick<Env, "SIGILIX_PLATFORM_DB">, scope: LedgerScope): Promise<string[]> {
  if (!env.SIGILIX_PLATFORM_DB) return []
  if (scope !== "all" && scope.length === 0) return []
  try {
    const inst = installationFilter(scope, "installation_id")
    const clauses = ["author_login IS NOT NULL"]
    if (inst.clause) clauses.push(inst.clause)
    const sql =
      "SELECT DISTINCT author_login AS login FROM usage_ledger WHERE " +
      clauses.join(" AND ") +
      " ORDER BY author_login LIMIT ?"
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(sql)
      .bind(...inst.binds, FACET_USER_LIMIT)
      .all<{ login: unknown }>()
    // Case-insensitive de-dup, keep first casing seen.
    const byLower = new Map<string, string>()
    for (const r of results) {
      const login = typeof r.login === "string" ? r.login : ""
      if (login === "") continue
      const key = login.toLowerCase()
      if (!byLower.has(key)) byLower.set(key, login)
    }
    return [...byLower.values()]
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metrics-dashboard-users-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}

interface UsageStats {
  activeRepos: number
  distinctPrs: number
  assignedUsers: number
  totalRows: number
  unassignedRows: number
}

const EMPTY_USAGE_STATS: UsageStats = {
  activeRepos: 0,
  distinctPrs: 0,
  assignedUsers: 0,
  totalRows: 0,
  unassignedRows: 0,
}

/**
 * Windowed usage aggregates, scoped to the caller's installation(s) and the
 * (already-validated) repo/user filters. All filters compose with AND; every
 * value is bound with `?` (no string-concatenated values). Fail-soft to zeros.
 */
async function readUsageStats(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  scope: LedgerScope,
  repoIds: number[] | null,
  userLoginsLower: string[] | null,
  cutoffIso: string,
): Promise<UsageStats> {
  if (!env.SIGILIX_PLATFORM_DB) return EMPTY_USAGE_STATS
  if (scope !== "all" && scope.length === 0) return EMPTY_USAGE_STATS
  // A filter that resolved to nothing owned → genuinely zero (never widen).
  if (repoIds !== null && repoIds.length === 0) return EMPTY_USAGE_STATS
  if (userLoginsLower !== null && userLoginsLower.length === 0) return EMPTY_USAGE_STATS
  try {
    const clauses: string[] = []
    const binds: unknown[] = []
    const inst = installationFilter(scope, "installation_id")
    if (inst.clause) {
      clauses.push(inst.clause)
      binds.push(...inst.binds)
    }
    if (repoIds !== null) {
      clauses.push(`repo_id IN (${repoIds.map(() => "?").join(",")})`)
      binds.push(...repoIds)
    }
    if (userLoginsLower !== null) {
      clauses.push(`lower(author_login) IN (${userLoginsLower.map(() => "?").join(",")})`)
      binds.push(...userLoginsLower)
    }
    clauses.push("created_at >= ?")
    binds.push(cutoffIso)

    const sql =
      "SELECT COUNT(DISTINCT repo_id) AS activeRepos," +
      " COUNT(DISTINCT repo_id || '#' || pr_number) AS distinctPrs," +
      " COUNT(DISTINCT lower(author_login)) AS assignedUsers," +
      " COUNT(*) AS totalRows," +
      " SUM(CASE WHEN author_login IS NULL THEN 1 ELSE 0 END) AS unassignedRows" +
      " FROM usage_ledger WHERE " +
      clauses.join(" AND ")

    const row = await env.SIGILIX_PLATFORM_DB.prepare(sql)
      .bind(...binds)
      .first<Record<string, unknown>>()
    if (!row) return EMPTY_USAGE_STATS
    return {
      activeRepos: Number(row.activeRepos) || 0,
      distinctPrs: Number(row.distinctPrs) || 0,
      assignedUsers: Number(row.assignedUsers) || 0,
      totalRows: Number(row.totalRows) || 0,
      unassignedRows: Number(row.unassignedRows) || 0,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metrics-dashboard-usage-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return EMPTY_USAGE_STATS
  }
}

/**
 * The set of `${slugLower}#${pr}` keys authored by the filtered users (scoped +
 * windowed), so the finding-level metrics can be narrowed to a user's own PRs
 * (findings carry no author — this join is how a per-person review-comment view
 * is possible). Fail-soft to an empty set. Only called when a user filter is set.
 */
async function readAuthoredPrKeys(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  scope: LedgerScope,
  repoIds: number[] | null,
  userLoginsLower: string[],
  cutoffIso: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!env.SIGILIX_PLATFORM_DB) return out
  if (scope !== "all" && scope.length === 0) return out
  if (userLoginsLower.length === 0) return out
  if (repoIds !== null && repoIds.length === 0) return out
  try {
    const clauses: string[] = []
    const binds: unknown[] = []
    const inst = installationFilter(scope, "u.installation_id")
    if (inst.clause) {
      clauses.push(inst.clause)
      binds.push(...inst.binds)
    }
    if (repoIds !== null) {
      clauses.push(`u.repo_id IN (${repoIds.map(() => "?").join(",")})`)
      binds.push(...repoIds)
    }
    clauses.push(`lower(u.author_login) IN (${userLoginsLower.map(() => "?").join(",")})`)
    binds.push(...userLoginsLower)
    clauses.push("u.created_at >= ?")
    binds.push(cutoffIso)

    const sql =
      "SELECT r.full_name AS slug, u.pr_number AS pr FROM usage_ledger u" +
      " JOIN repo r ON r.repo_id = u.repo_id WHERE " +
      clauses.join(" AND ")
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(sql)
      .bind(...binds)
      .all<{ slug: unknown; pr: unknown }>()
    for (const r of results) {
      const slug = typeof r.slug === "string" ? r.slug.toLowerCase() : ""
      const pr = Number(r.pr)
      if (slug !== "" && Number.isInteger(pr) && pr > 0) out.add(`${slug}#${pr}`)
    }
    return out
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metrics-dashboard-authored-prs-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return out
  }
}

// ─── KV finding scan (posted findings + acceptance) ───────────

interface ReviewCommentsResult {
  posted: number
  acceptanceRate: number | null
  accepted: number
  severity: SeverityBucket[]
  category: CategoryBucket[]
}

/**
 * Scan the telemetry + review-memory KV corpus for the caller's repo slugs,
 * within the window, and aggregate posted/accepted findings by severity +
 * category. Returns null on any fault or when the corpus can't be read so the
 * caller degrades honestly. Bounded exactly like metrics-fp-rate-route.ts.
 *
 * `prKeyAllowSet` (present only under a user filter) restricts findings to the
 * `${slugLower}#${pr}` PRs authored by the filtered users.
 */
async function scanReviewComments(
  env: Env,
  slugsLower: string[],
  nowMs: number,
  windowDays: number,
  prKeyAllowSet: Set<string> | null,
): Promise<ReviewCommentsResult | null> {
  if (!env.OPENCLAW_STATE) return null
  if (slugsLower.length === 0) {
    // Genuinely nothing to scan (no owned repos, or filtered to none owned).
    return { posted: 0, acceptanceRate: null, accepted: 0, severity: [], category: [] }
  }
  try {
    const [telemetryListed, memoryListed] = await Promise.all([
      listKeys(env, TELEMETRY_PREFIX, TELEMETRY_LIST_SCAN),
      listKeys(env, MEMORY_PREFIX, MEMORY_LIST_SCAN),
    ])

    const telemetryMatched = telemetryListed
      .filter((k) => {
        const lk = k.toLowerCase()
        return slugsLower.some((s) => lk.includes(`:${s}#`))
      })
      .slice(0, MAX_TELEMETRY_FETCH)
    const memoryMatched = memoryListed
      .filter((k) => {
        const lk = k.toLowerCase()
        return slugsLower.some((s) => lk.startsWith(`${MEMORY_PREFIX}${s}:`))
      })
      .slice(0, MAX_MEMORY_FETCH)

    const getJson = (key: string): Promise<unknown> => env.OPENCLAW_STATE.get(key, "json").catch(() => null)

    // Posted findings from telemetry, within window.
    const reviews = (
      await mapWithConcurrency(telemetryMatched, FETCH_CONCURRENCY, async (key) => {
        const createdMs = createdMsFromTelemetryKey(key)
        if (createdMs === null) return null
        return mapTelemetryToReview(await getJson(key), createdMs)
      })
    ).filter((r): r is NonNullable<typeof r> => r !== null)

    // Window filter (no maturity gate — the dashboard counts everything posted
    // in the window). filterReviewsToWindow throws on bad params; guarded above.
    const scoped = filterReviewsToWindow(reviews, nowMs, windowDays, 0)

    const postedFindings: PostedFinding[] = []
    for (const review of scoped) {
      // Guard-skipped non-reviews (the ensemble never ran) have no posted findings.
      if (review.fellBackReason && GUARD_SKIP_REASONS.has(review.fellBackReason)) continue
      if (review.synthFindings === null) continue
      if (prKeyAllowSet !== null) {
        const prKey = `${review.owner}/${review.repo}`.toLowerCase() + `#${review.prNumber}`
        if (!prKeyAllowSet.has(prKey)) continue
      }
      for (const f of review.synthFindings) {
        const fid = await computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline })
        postedFindings.push({ key: findingKey(review.prNumber, fid), score: f.score, roles: f.sourceSpecialists })
      }
    }

    // Dismissed keys from review-memory signals (deduped across the dual keyspace).
    const rawSignals = (
      await mapWithConcurrency(memoryMatched, FETCH_CONCURRENCY, async (key) => mapSignalRecord(await getJson(key)))
    ).flat()
    const dismissedKeys = new Set<string>()
    for (const d of dedupeDismissals(rawSignals)) {
      dismissedKeys.add(findingKey(d.prNumber, d.fid))
    }

    const agg = aggregateReviewComments(postedFindings, dismissedKeys)
    return {
      posted: agg.posted,
      acceptanceRate: agg.acceptanceRate,
      accepted: agg.accepted,
      severity: agg.severity,
      category: agg.category,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "metrics-dashboard-review-comments-scan-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/** Recover the review creation time (ms) from a telemetry key's reverse-ts segment. */
function createdMsFromTelemetryKey(key: string): number | null {
  const rest = key.slice(TELEMETRY_PREFIX.length)
  const sep = rest.indexOf(":")
  if (sep <= 0) return null
  const reverseTs = Number(rest.slice(0, sep))
  if (!Number.isFinite(reverseTs)) return null
  const createdMs = 9_999_999_999_999 - reverseTs
  return Number.isFinite(createdMs) ? createdMs : null
}

// ─── Filter resolution (tenant-safe: NARROW only) ─────────────

interface ResolvedFilters {
  /** repo_ids to filter on, or null when no repo filter was applied. */
  repoIds: number[] | null
  /** repo slugs (lowercased) for the KV scan — the effective, owned set. */
  slugsLower: string[]
  /** lowercased logins to filter on, or null when no user filter was applied. */
  userLoginsLower: string[] | null
}

/**
 * Intersect the requested repo/user filters with the caller's OWNED options.
 * A requested value the caller doesn't own is silently dropped — a filter can
 * only ever narrow within the tenant, never widen past it.
 */
function resolveFilters(
  allowedRepos: AllowedRepo[],
  allowedUsers: string[],
  requestedRepos: string[],
  requestedUsers: string[],
): ResolvedFilters {
  const allSlugsLower = allowedRepos.map((r) => r.name.toLowerCase())

  let repoIds: number[] | null = null
  let slugsLower = allSlugsLower
  if (requestedRepos.length > 0) {
    const matched = new Map<number, string>()
    for (const req of requestedRepos) {
      const reqLower = req.toLowerCase()
      const isNumeric = /^\d+$/.test(req)
      for (const repo of allowedRepos) {
        if (isNumeric ? repo.id === Number(req) : repo.name.toLowerCase() === reqLower) {
          matched.set(repo.id, repo.name.toLowerCase())
        }
      }
    }
    repoIds = [...matched.keys()]
    slugsLower = [...matched.values()]
  }

  let userLoginsLower: string[] | null = null
  if (requestedUsers.length > 0) {
    const allowedLower = new Set(allowedUsers.map((u) => u.toLowerCase()))
    const matched = new Set<string>()
    for (const req of requestedUsers) {
      const reqLower = req.toLowerCase()
      if (allowedLower.has(reqLower)) matched.add(reqLower)
    }
    userLoginsLower = [...matched]
  }

  return { repoIds, slugsLower, userLoginsLower }
}

// ─── Handler ──────────────────────────────────────────────────

/** GET /v1/metrics/dashboard — see file header. */
export async function handleMetricsDashboardRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(request, env, ctx)

  let scope: LedgerScope
  if (session) {
    scope = await resolveSessionScope(env, session)
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response // 401
    scope = apiAuth.caller.installationId === LEGACY_TENANT_INSTALLATION_ID ? "all" : [apiAuth.caller.installationId]
  }

  const url = new URL(request.url)
  const windowDays = parseWindowDays(url.searchParams.get("window"))
  if (windowDays === null) {
    return json({ error: "invalid_window", detail: "window must be one of 7d, 30d, 90d" }, 400)
  }

  const requestedRepos = parseCsvParam(url.searchParams, "repo")
  const requestedUsers = parseCsvParam(url.searchParams, "user")
  // `team` is accepted but a no-op: there is no team↔member model in the store
  // yet, so it cannot expand to member logins. Parsed (so a client can send it)
  // and reflected as an empty facet, never silently changing the result.
  void parseCsvParam(url.searchParams, "team")

  const nowMs = Date.now()
  const cutoffIso = new Date(nowMs - windowDays * DAY_MS).toISOString()

  // Facets + filter-validation options (scoped to the caller, NOT narrowed by
  // the active filters — the UI needs the full option set).
  const [allowedRepos, allowedUsers] = await Promise.all([readAllowedRepos(env, scope), readAllowedUsers(env, scope)])
  const filters = resolveFilters(allowedRepos, allowedUsers, requestedRepos, requestedUsers)

  // usage_ledger aggregates (fail-soft to zeros inside the reader).
  const usage = await readUsageStats(env, scope, filters.repoIds, filters.userLoginsLower, cutoffIso)

  // A user filter needs the author→PR map so finding metrics can be narrowed.
  const prKeyAllowSet =
    filters.userLoginsLower !== null
      ? await readAuthoredPrKeys(env, scope, filters.repoIds, filters.userLoginsLower, cutoffIso)
      : null

  const reviewComments = await scanReviewComments(env, filters.slugsLower, nowMs, windowDays, prKeyAllowSet)

  const body: MetricsDashboardResponse = {
    window: `${windowDays}d`,
    activeRepos: usage.activeRepos,
    mergedPrs: {
      total: usage.distinctPrs,
      avgPerUser: usage.assignedUsers > 0 ? usage.distinctPrs / usage.assignedUsers : 0,
    },
    activeUsers: { assigned: usage.assignedUsers, unassigned: usage.unassignedRows },
    reviewComments: {
      posted: reviewComments?.posted ?? 0,
      acceptanceRate: reviewComments?.acceptanceRate ?? null,
    },
    reviewerTimeSavedHours: reviewComments ? reviewerTimeSavedHours(reviewComments.accepted) : null,
    avgReviewIterationsPerPr: avgReviewIterationsPerPr(usage.totalRows, usage.distinctPrs),
    severity: reviewComments?.severity ?? [],
    category: reviewComments?.category ?? [],
    // No instrumented source — null so the portal renders "Coming soon".
    chatUsage: null,
    medianTime: null,
    toolFindings: null,
    pipelineFailures: null,
    facets: {
      repos: allowedRepos.map((r) => ({ id: r.id, name: r.name })),
      users: allowedUsers.map((login) => ({ login })),
      teams: [],
    },
  }

  return json(body, 200)
}
