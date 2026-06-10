// SIG-114 — offline per-specialist false-positive-rate report.
//
// Thin IO layer: reads ensemble-review-telemetry:* + review-memory:* from the
// prod KV namespace via the Cloudflare API, maps raw records to the FP-rate
// core shapes (src/lib/fp-rate/ingest.ts), and prints a CSV + markdown report.
// All logic lives in the pure, unit-tested core (src/lib/fp-rate/*). NO prod
// source change — the join works on the already-persisted
// synthesizer.provenance.sourceSpecialists.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     npm run fp-rate-report -- --repo=owner/repo [--window-days=30] \
//       [--maturity-days=14] [--min-n=30] [--format=both] [--out=path]
//
// --repo is MANDATORY: the rate is computed per repo (Simpson's paradox);
// fit one repo per run. Design: .claude/handoff/sig-114-fp-rate-design.md

import { writeFileSync } from "node:fs"
import { attributeDismissals, dedupeDismissals } from "@/lib/fp-rate/attribute"
import { computeFpRates } from "@/lib/fp-rate/compute"
import { formatCsv, formatMarkdown } from "@/lib/fp-rate/format"
import { filterReviewsToWindow } from "@/lib/fp-rate/window"
import { createdMsFromKey, mapSignalRecord, mapTelemetryToReview } from "@/lib/fp-rate/ingest"
import type { FpRateDismissal, FpRateReview } from "@/lib/fp-rate/types"

const KV_NAMESPACE_ID = "df689379ea6240f7808997a75ceaed7e"
const CF_API_BASE = "https://api.cloudflare.com/client/v4"
const KV_LIST_PAGE_SIZE = 1000
const KV_REQUEST_TIMEOUT_MS = 30_000
const TELEMETRY_PREFIX = "ensemble-review-telemetry:"
const MEMORY_PREFIX = "review-memory:"

const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
const cfApiToken = process.env.CLOUDFLARE_API_TOKEN

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

if (!cfAccountId || !cfApiToken) die("missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN")
const repoArg = (args.repo ?? "").trim().toLowerCase()
if (!/^[^/\s]+\/[^/\s]+$/.test(repoArg)) {
  die("--repo=owner/repo is required (one repo per run — the rate is per-repo)")
}
const windowDays = Number(args["window-days"] ?? 30)
const maturityDays = Number(args["maturity-days"] ?? 14)
const minN = Number(args["min-n"] ?? 30)
const format = (args.format ?? "both").toLowerCase()
const nowMs = args.now ? Number(args.now) : Date.now()
// Validate numeric args: bare Number() yields NaN on garbage, which would
// silently empty the window and exit 0 (the failure ingest.ts guards against).
if (!Number.isFinite(windowDays) || windowDays <= 0) die("--window-days must be a positive number")
if (!Number.isFinite(maturityDays) || maturityDays < 0) die("--maturity-days must be >= 0")
if (maturityDays >= windowDays) die("--maturity-days must be < --window-days (else the window is empty)")
if (!Number.isFinite(minN) || minN < 0) die("--min-n must be >= 0")
if (!Number.isFinite(nowMs)) die("--now must be a finite epoch-ms value")

async function cfFetch(url: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${cfApiToken}` }, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function listKvKeys(prefix: string): Promise<string[]> {
  const all: string[] = []
  let cursor = ""
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: String(KV_LIST_PAGE_SIZE) })
    if (cursor) params.set("cursor", cursor)
    const url = `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?${params}`
    const res = await cfFetch(url)
    if (!res.ok) die(`KV list failed (${res.status}) for prefix ${prefix}`)
    const json = (await res.json()) as {
      success?: boolean
      errors?: unknown
      result?: Array<{ name: string }>
      result_info?: { cursor?: string }
    }
    // CF v4 can return HTTP 200 with success:false — fail loudly, don't treat
    // an error envelope as an empty page (mirrors phase4-calibrate.ts).
    if (json.success === false) die(`KV list error for prefix ${prefix}: ${JSON.stringify(json.errors)}`)
    const page = json.result ?? []
    for (const k of page) all.push(k.name)
    cursor = json.result_info?.cursor ?? ""
    if (!cursor || page.length === 0) break
  }
  return all
}

/** Count of value fetches that failed for a reason OTHER than 404 (lossy run). */
let failedFetches = 0

async function getKvJson<T>(key: string): Promise<T | null> {
  const url = `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
  const res = await cfFetch(url)
  if (res.status === 404) return null // genuinely absent
  if (!res.ok) {
    // A transient 429/500/403 is NOT "absent" — dropping it silently would
    // under-count both numerator and denominator (a wrong number). Surface it.
    failedFetches += 1
    console.error(`warn: KV get failed (${res.status}) for ${key} — record skipped`)
    return null
  }
  try {
    return (await res.json()) as T
  } catch {
    failedFetches += 1
    console.error(`warn: KV get parse failed for ${key} — record skipped`)
    return null
  }
}

/** KV value gets are independent — fetch them concurrency-capped to cut
 * wall-clock (~200 reviews: 20-40s sequential -> a few seconds) while staying
 * well under the CF API rate limit (Sigilix dogfood finding). */
const KV_FETCH_CONCURRENCY = 10
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

async function loadReviews(): Promise<FpRateReview[]> {
  const keys = await listKvKeys(TELEMETRY_PREFIX)
  // Filter to this repo by the key suffix `:owner/repo#pr` before fetching.
  const repoKeys = keys.filter((k) => k.toLowerCase().includes(`:${repoArg}#`))
  const reviews = await mapWithConcurrency(repoKeys, KV_FETCH_CONCURRENCY, async (key) => {
    const createdMs = createdMsFromKey(key, TELEMETRY_PREFIX)
    if (createdMs === null) return null
    return mapTelemetryToReview(await getKvJson<unknown>(key), createdMs)
  })
  return reviews.filter((r): r is FpRateReview => r !== null)
}

async function loadDismissals(): Promise<{ deduped: FpRateDismissal[]; raw: number }> {
  const keys = await listKvKeys(MEMORY_PREFIX)
  // Legacy owner/repo keyspace is repo-scoped by string and dual-written with
  // the canonical repo:<id> keyspace; reading it + dedupe-by-commentId is
  // complete. (repo:<id> needs the numeric id, unavailable offline by name.)
  const repoKeys = keys.filter((k) => k.toLowerCase().startsWith(`${MEMORY_PREFIX}${repoArg}:`))
  const perKey = await mapWithConcurrency(repoKeys, KV_FETCH_CONCURRENCY, async (key) =>
    mapSignalRecord(await getKvJson<unknown>(key)),
  )
  const all = perKey.flat()
  return { deduped: dedupeDismissals(all), raw: all.length }
}

async function main() {
  const [reviews, dismissalsRes] = await Promise.all([loadReviews(), loadDismissals()])
  const scoped = filterReviewsToWindow(reviews, nowMs, windowDays, maturityDays)
  const attr = await attributeDismissals(scoped, dismissalsRes.deduped, nowMs)
  const report = computeFpRates(attr, { minN })

  const md = formatMarkdown(report, {
    repo: repoArg,
    windowDays,
    maturityDays,
    generatedIso: new Date(nowMs).toISOString(),
    totalDismissals: dismissalsRes.deduped.length,
  })
  const csv = formatCsv(report)

  if (args.out) {
    writeFileSync(`${args.out}.md`, md + "\n")
    writeFileSync(`${args.out}.csv`, csv + "\n")
    console.error(`wrote ${args.out}.md and ${args.out}.csv`)
  }
  if (format === "csv") console.log(csv)
  else if (format === "md") console.log(md)
  else console.log(md + "\n\n```csv\n" + csv + "\n```")

  // Print the (partial) report first, THEN fail non-zero so an automated
  // pipeline doesn't consume an incomplete report as if it were complete.
  // Set process.exitCode (not process.exit) so the just-printed report fully
  // flushes to stdout before the process exits — process.exit() can truncate
  // buffered output in CI (CodeRabbit; Node docs).
  if (failedFetches > 0) {
    console.error(`WARNING: ${failedFetches} KV fetch(es) failed (non-404) — the report above may be INCOMPLETE (counts under-reported).`)
    process.exitCode = 1
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))
