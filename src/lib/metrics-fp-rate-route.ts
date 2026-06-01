// SIG-114 PR 5: GET /metrics/fp-rate — authenticated live read of the
// per-specialist dismissal-based false-positive rate (the "floor" metric
// from PR 1), computed on-request over the worker's KV binding.
//
// Reuses the pure, unit-tested core (src/lib/fp-rate/*): the only new code is
// reading KV via `env.OPENCLAW_STATE` (instead of the offline CF API) +
// auth + JSON. Per-repo (Simpson's paradox — `?repo=owner/repo` mandatory).
//
// Cost: an authed, low-QPS ops endpoint. It lists the telemetry keyspace
// (bounded) + the repo's review-memory, then fetches matching records with a
// concurrency cap. If the corpus outgrows the bound, move the compute to the
// scheduled() cron + cache the result (this endpoint then reads the cache).

import type { Env } from "../index"
import { requireBearerToken } from "./auth-bearer"
import { attributeDismissals, dedupeDismissals, buildFindingIndex, findingKey } from "./fp-rate/attribute"
import { computeFpRates } from "./fp-rate/compute"
import { filterReviewsToWindow } from "./fp-rate/window"
import { createdMsFromKey, mapSignalRecord, mapTelemetryToReview } from "./fp-rate/ingest"
import type { FpRateDismissal, FpRateReview } from "./fp-rate/types"

const TELEMETRY_PREFIX = "ensemble-review-telemetry:"
const MEMORY_PREFIX = "review-memory:"
// Per-request scan caps. Each matched key costs one KV `get` subrequest, so
// the caps are sized so telemetry + memory gets JOINTLY stay well under the
// Workers 1000-subrequest/request limit (700 + 200 + a few `list` calls). The
// 30d telemetry TTL keeps the live corpus small (≈hundreds), so a single repo
// hitting the cap is the signal to move this compute to the cron + cache it
// (the endpoint would then read the cache). When the cap IS hit, the response
// flags `scanCapped: true` so a sampled (most-recent-N) result is visible.
const MAX_TELEMETRY_KEYS = 700
const MAX_MEMORY_KEYS = 200
const KV_LIST_PAGE = 1000
/** Concurrency cap for the per-key KV gets (wall-clock; doesn't change the total). */
const FETCH_CONCURRENCY = 25

const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 90
const DEFAULT_MATURITY_DAYS = 14
const DEFAULT_MIN_N = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function parseIntParam(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

/** List keys for a prefix via the KV binding, paginated up to `cap` keys. */
async function listKeys(env: Env, prefix: string, cap: number): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  while (names.length < cap) {
    const opts: KVNamespaceListOptions = cursor
      ? { prefix, limit: KV_LIST_PAGE, cursor }
      : { prefix, limit: KV_LIST_PAGE }
    const page = await env.OPENCLAW_STATE.list(opts)
    for (const k of page.keys) names.push(k.name)
    if (page.list_complete || !page.cursor) break
    cursor = page.cursor
  }
  return names.slice(0, cap)
}

export async function handleFpRateMetricsRoute(request: Request, env: Env): Promise<Response> {
  // Shares the validator-metrics bearer token (same ops surface as /metrics/validation).
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) return json({ error: "metrics_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  const params = new URL(request.url).searchParams
  // Accept one OR several owner/repo slugs (repeatable `?repo=` and/or a single
  // comma-separated `?repo=a/b,c/d`). Multiple slugs MUST be aliases of the SAME
  // GitHub repo: a rename (e.g. arc-and-anchor/sigilix -> sigilix/sigilix, the
  // SIG-243 tenant rename) splits the corpus — review telemetry is keyed under
  // the slug-at-review-time while review-memory dismissals are (dual-)written
  // under the current slug, so a single slug loads one side with zero of the
  // other. The (prNumber, fid) attribution is repo-independent once both sides
  // are in memory, and PR numbers are continuous across a rename, so unioning
  // the alias key-filters reconstructs the full joinable corpus.
  // Validate EVERY parsed segment explicitly — including empties from stray
  // leading/trailing/double commas — instead of silently dropping them with
  // filter(Boolean): the empty-rejection must not depend on operation ordering
  // (Sigilix #273). A stray comma is a malformed request, not a tolerated no-op.
  const segments = params
    .getAll("repo")
    .flatMap((r) => r.split(","))
    .map((r) => r.trim().toLowerCase())
  if (segments.length === 0 || segments.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r))) {
    return json(
      {
        error: "invalid_repo",
        detail: "?repo=owner/repo is required (rate is per-repo; pass repeated or comma-separated ?repo= for rename aliases of the same repo)",
      },
      400,
    )
  }
  // Already-validated; `repos` is just the de-duplicated set used for filtering.
  const repos = [...new Set(segments)]
  // Cross-repo attribution guard (code-reviewer + Codex on #273): PR numbers are
  // repo-local and `fid` is not repo-scoped, so unioning genuinely DIFFERENT
  // repos would cross-attribute findings. Real rename aliases share the repo
  // NAME — a transfer/rename changes the owner (arc-and-anchor/sigilix ->
  // sigilix/sigilix), not the name — so require every alias to share the name
  // segment. (Known limitation: a by-NAME rename `foo/bar -> foo/baz` must be
  // queried one slug at a time; this read path has no repo-id resolver to prove
  // two differently-named slugs are the same repo, and a footgun beats a wrong
  // number on the believability ruler.)
  const repoNames = new Set(repos.map((r) => r.slice(r.indexOf("/") + 1)))
  if (repoNames.size > 1) {
    return json(
      {
        error: "alias_repo_mismatch",
        detail: `?repo= aliases must be the same GitHub repo (same name, differing only in owner); got distinct names: ${[...repoNames].join(", ")}`,
      },
      400,
    )
  }
  const windowDays = parseIntParam(params.get("window"), DEFAULT_WINDOW_DAYS)
  const maturityDays = parseIntParam(params.get("maturity"), DEFAULT_MATURITY_DAYS)
  const minN = parseIntParam(params.get("min-n"), DEFAULT_MIN_N)
  if (windowDays === null || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
    return json({ error: "invalid_window", detail: `window must be 1-${MAX_WINDOW_DAYS} days` }, 400)
  }
  if (maturityDays === null || maturityDays < 0 || maturityDays >= windowDays) {
    return json({ error: "invalid_maturity", detail: "maturity must be >= 0 and < window" }, 400)
  }
  if (minN === null || minN < 0) return json({ error: "invalid_min_n" }, 400)

  // A non-404 KV get failure is swallowed to null (the record is skipped); we
  // count it so a lossy/under-counted run is visible rather than masquerading
  // as a genuinely small corpus.
  let failedFetches = 0
  const getJson = (key: string): Promise<unknown> =>
    env.OPENCLAW_STATE.get(key, "json").catch(() => {
      failedFetches += 1
      return null
    })

  // Telemetry: list (bounded), keep this repo's keys, fetch + map. If the list
  // hit the cap there may be older records beyond it (sampled most-recent N).
  const telemetryListed = await listKeys(env, TELEMETRY_PREFIX, MAX_TELEMETRY_KEYS)
  const memoryListed = await listKeys(env, MEMORY_PREFIX, MAX_MEMORY_KEYS)
  const scanCapped = telemetryListed.length >= MAX_TELEMETRY_KEYS || memoryListed.length >= MAX_MEMORY_KEYS

  const telemetryKeys = telemetryListed.filter((k) => {
    const lk = k.toLowerCase()
    return repos.some((r) => lk.includes(`:${r}#`))
  })
  const reviews = (
    await mapWithConcurrency(telemetryKeys, FETCH_CONCURRENCY, async (key): Promise<FpRateReview | null> => {
      const createdMs = createdMsFromKey(key, TELEMETRY_PREFIX)
      if (createdMs === null) return null
      return mapTelemetryToReview(await getJson(key), createdMs)
    })
  ).filter((r): r is FpRateReview => r !== null)

  // Dismissals: the legacy owner/repo keyspace is repo-scoped + dual-written.
  const memoryKeys = memoryListed.filter((k) => {
    const lk = k.toLowerCase()
    return repos.some((r) => lk.startsWith(`${MEMORY_PREFIX}${r}:`))
  })
  const rawSignals = (
    await mapWithConcurrency(memoryKeys, FETCH_CONCURRENCY, async (key): Promise<FpRateDismissal[]> =>
      mapSignalRecord(await getJson(key)),
    )
  ).flat()
  const dismissals = dedupeDismissals(rawSignals)
  if (failedFetches > 0) {
    console.error(JSON.stringify({ event: "fp-rate-metrics-lossy-read", repos, failedFetches }))
  }

  const nowMs = Date.now()
  const scoped = filterReviewsToWindow(reviews, nowMs, windowDays, maturityDays)

  // Opt-in attribution diagnostic (`?diagnose=1`, read-only): when dismissals
  // fail to attribute, surface WHY — PR non-overlap vs fid drift — without raw
  // KV access. For each unmatched dismissal: is its PR even in the score>=4
  // finding index (prInIndex), and what fids does that PR carry (samePrIndexFids)?
  // prInIndex=false → PR-miss (no score>=4 review finding loaded for that PR);
  // prInIndex=true with differing fids → fid drift (line/headline mismatch).
  let diagnostics: Record<string, unknown> | undefined
  if (params.get("diagnose") === "1") {
    const index = await buildFindingIndex(scoped)
    const idxByPr = new Map<number, string[]>()
    for (const ref of index.values()) {
      const arr = idxByPr.get(ref.prNumber) ?? []
      arr.push(ref.fid.slice(0, 10))
      idxByPr.set(ref.prNumber, arr)
    }
    const range = (ns: number[]): number[] => (ns.length ? [Math.min(...ns), Math.max(...ns)] : [])
    // Slug distribution across the FULL listed keyspace (BEFORE the repo filter):
    // which owner/repo slugs is telemetry actually written under, and over what
    // PR range? This settles whether recent reviews write telemetry under an
    // unexpected slug, a stale one, or not at all (SIG-306 — rename regression).
    const telBySlug = new Map<string, number[]>()
    for (const k of telemetryListed) {
      const m = /ensemble-review-telemetry:\d+:(.+?)#(\d+)/.exec(k)
      if (!m) continue
      const slug = (m[1] ?? "").toLowerCase()
      const arr = telBySlug.get(slug) ?? []
      arr.push(Number(m[2]))
      telBySlug.set(slug, arr)
    }
    const memBySlug = new Map<string, number>()
    for (const k of memoryListed) {
      const slug = (k.split(":")[1] ?? "").toLowerCase()
      memBySlug.set(slug, (memBySlug.get(slug) ?? 0) + 1)
    }
    diagnostics = {
      loadedReviews: scoped.length,
      loadedReviewsPrRange: range(scoped.map((r) => r.prNumber)),
      indexSize: index.size,
      indexPrRange: range([...idxByPr.keys()]),
      dismissalPrRange: range(dismissals.map((d) => d.prNumber)),
      telemetrySlugs: Object.fromEntries(
        [...telBySlug].map(([s, prs]) => [s, { count: prs.length, prRange: range(prs) }]),
      ),
      memorySlugs: Object.fromEntries(memBySlug),
      telemetryListedTotal: telemetryListed.length,
      scanCapped,
      sampleUnmatched: dismissals
        .filter((d) => !index.has(findingKey(d.prNumber, d.fid)))
        .slice(0, 10)
        .map((d) => ({
          prNumber: d.prNumber,
          fid: d.fid.slice(0, 10),
          prInIndex: idxByPr.has(d.prNumber),
          samePrIndexFids: idxByPr.get(d.prNumber) ?? [],
        })),
    }
  }

  const attr = await attributeDismissals(scoped, dismissals, nowMs)
  const report = computeFpRates(attr, { minN })

  return json(
    {
      // `repo` stays a single string for back-compat (comma-joined when several
      // aliases were unioned); `repos` is the parsed alias list.
      repo: repos.join(","),
      repos,
      windowDays,
      maturityDays,
      minN,
      generatedAt: new Date(nowMs).toISOString(),
      reviewsScanned: report.reviewsScanned,
      reviewsRealFanout: report.reviewsRealFanout,
      reviewsZeroPostedFindings: report.reviewsZeroPostedFindings,
      totalDismissals: dismissals.length,
      unattributed: report.unattributed,
      // True if the KV scan hit its cap (result is the most-recent N, may not
      // cover the full window) or if a KV get failed (under-counted).
      scanCapped,
      failedFetches,
      // Honest contract: a dismissal-based rate is a LOWER BOUND on true FP
      // (not every FP is dismissed); the curated eval set (npm run fp-eval) is
      // the ceiling. `meetsTarget` is worst-case (unlabeled counted as hard).
      note: "dismissal-based FP rate — a lower bound on true FP; floor + trend, not a ceiling",
      rows: report.rows,
      ...(diagnostics ? { diagnostics } : {}),
    },
    200,
  )
}
