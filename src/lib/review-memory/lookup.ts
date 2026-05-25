// ARC-189 — Lookup pipeline (Task 5).
//
// Reads category + path-category KV records, applies activation
// thresholds (spec §4.5), and returns the top-N memories ready for
// prompt injection.
//
// Activation rules (spec §4.5):
//   - category-scope:    ≥ minSignalThreshold dismiss signals in
//                        trailing maxSignalAgeDays (default 90d)
//   - path-category:     same, AND ≥ 1 signal in trailing 30 days
//
// Best-effort under KV no-CAS — the most-recent signal may not be
// visible yet, so activation may lag by one review. Acceptable per
// spec §4.5 — single-write-loss races are absorbed by the threshold.

import type {
  ResolvedReviewMemoryConfig,
  ReviewMemoryCategory,
  ReviewMemoryFinding,
  ReviewMemoryRecord,
  ReviewMemorySkipReason,
} from "./types"
import { ALL_REVIEW_MEMORY_CATEGORIES } from "./types"
import { computePathSha256 } from "./marker"
import { readMemory } from "./storage"
import { weightedSignalCount } from "./dismissal-weights"
import type { Env } from "../../index"

const PATH_RECENCY_DAYS = 30

interface RunArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  paths: readonly string[]
  config: ResolvedReviewMemoryConfig
}

type RunResult =
  | { skipped: true; reason: ReviewMemorySkipReason; findings: [] }
  | {
      skipped: false
      findings: ReviewMemoryFinding[]
      durationMs: number
    }

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

/**
 * Pure activation predicate. Spec §4.5 + §4.6.
 *
 * @param scope - "category" runs only the trailing-90d threshold
 *                check; "path-category" additionally requires a
 *                recent (≤30d) signal so dormant paths don't keep
 *                injecting after the team has moved on.
 *
 * SIG-173: the threshold check uses a WEIGHTED count via
 * `weightedSignalCount` so `too-minor` signals push past the bar 1.5×
 * faster than `not-a-bug` / unlabeled / textual-only signals. See
 * `dismissal-weights.ts` for the table + rationale. Today's textual
 * capture pipeline doesn't tag a reason, so its signals all weight 1.0
 * — identical behavior to pre-SIG-173 for the existing call sites.
 */
export function isMemoryActive(
  record: ReviewMemoryRecord,
  scope: "category" | "path-category",
  config: ResolvedReviewMemoryConfig,
  nowMs: number,
): boolean {
  const cutoffMs = nowMs - config.maxSignalAgeDays * 24 * 60 * 60 * 1000
  const recent = record.signals.filter((s) => {
    const ts = Date.parse(s.ts)
    return Number.isFinite(ts) && ts >= cutoffMs && s.kind === "dismissed-textual"
  })
  if (weightedSignalCount(recent) < config.minSignalThreshold) return false
  if (scope === "path-category") {
    const pathRecencyCutoff = nowMs - PATH_RECENCY_DAYS * 24 * 60 * 60 * 1000
    const hasRecent = recent.some((s) => Date.parse(s.ts) >= pathRecencyCutoff)
    if (!hasRecent) return false
  }
  return true
}

/**
 * Sort memories deterministically + cap at `maxN`. Pure.
 *
 * Order: `(lastSignalTs desc, signalCount desc, category asc)`. The
 * three-key sort guarantees a stable output for the same input set.
 */
export function selectTopMemories(
  findings: readonly ReviewMemoryFinding[],
  maxN: number,
): ReviewMemoryFinding[] {
  const copy = [...findings]
  copy.sort((a, b) => {
    const tsA = Date.parse(a.lastSignalTs)
    const tsB = Date.parse(b.lastSignalTs)
    if (tsA !== tsB) return tsB - tsA
    if (a.signalCount !== b.signalCount) return b.signalCount - a.signalCount
    return a.category.localeCompare(b.category)
  })
  return copy.slice(0, maxN)
}

function pickLastSignalTs(record: ReviewMemoryRecord): string {
  let bestMs = -Infinity
  let bestTs: string = record.lastUpdatedTs
  for (const s of record.signals) {
    const ts = Date.parse(s.ts)
    if (Number.isFinite(ts) && ts > bestMs) {
      bestMs = ts
      bestTs = s.ts
    }
  }
  return bestTs
}

function categoriesActive(
  config: ResolvedReviewMemoryConfig,
): ReadonlySet<ReviewMemoryCategory> {
  if (config.categories.length === 0) {
    return new Set(ALL_REVIEW_MEMORY_CATEGORIES)
  }
  return new Set(config.categories)
}

/**
 * Run the lookup pipeline. Returns `{ skipped: true, reason }` for
 * gates / disabled / no-paths; `{ skipped: false, findings, durationMs }`
 * on the run path. Never throws.
 */
export async function runReviewMemoryLookup(args: RunArgs): Promise<RunResult> {
  const { env, owner, repo, prNumber, paths, config } = args
  // Gate: env-level retrieval flag
  if (env.OPENCLAW_REVIEW_MEMORY_ENABLED !== "on") {
    emitTelemetry("review-memory-lookup-skipped", {
      owner, repo, prNumber, reason: "retrieval-disabled-env",
    })
    return { skipped: true, reason: "retrieval-disabled-env", findings: [] }
  }
  // Gate: sigilix.json `enabled: true` AND captureOnly does NOT
  // imply retrieval. Per spec §5.2 truth table.
  if (!config.enabled) {
    emitTelemetry("review-memory-lookup-skipped", {
      owner, repo, prNumber, reason: "retrieval-disabled-config",
    })
    return { skipped: true, reason: "retrieval-disabled-config", findings: [] }
  }
  if (paths.length === 0) {
    emitTelemetry("review-memory-lookup-skipped", {
      owner, repo, prNumber, reason: "no-paths-to-query",
    })
    return { skipped: true, reason: "no-paths-to-query", findings: [] }
  }

  const t0 = Date.now()
  const activeCats = categoriesActive(config)
  const findings: ReviewMemoryFinding[] = []

  // Category-scope reads (one per active category)
  const catReads: Promise<ReviewMemoryRecord | null>[] = []
  const catLookups: ReviewMemoryCategory[] = []
  for (const cat of ALL_REVIEW_MEMORY_CATEGORIES) {
    if (!activeCats.has(cat)) continue
    catReads.push(
      readMemory(env, owner, repo, { kind: "category", category: cat }),
    )
    catLookups.push(cat)
  }

  // Path-category reads (paths × active categories)
  // Hash each path once up-front and reuse across the cat fan-out.
  const pathHashes = await Promise.all(
    paths.map((p) => computePathSha256(p)),
  )
  const pathReads: Promise<ReviewMemoryRecord | null>[] = []
  const pathLookups: Array<{ category: ReviewMemoryCategory; pathSha256: string }> = []
  for (let i = 0; i < paths.length; i++) {
    const sha = pathHashes[i]
    if (!sha) continue
    for (const cat of ALL_REVIEW_MEMORY_CATEGORIES) {
      if (!activeCats.has(cat)) continue
      pathReads.push(
        readMemory(env, owner, repo, {
          kind: "path-category",
          category: cat,
          pathSha256: sha,
        }),
      )
      pathLookups.push({ category: cat, pathSha256: sha })
    }
  }

  const [catSettled, pathSettled] = await Promise.all([
    Promise.allSettled(catReads),
    Promise.allSettled(pathReads),
  ])

  const nowMs = Date.now()

  for (let i = 0; i < catSettled.length; i++) {
    const result = catSettled[i]
    if (!result || result.status !== "fulfilled" || !result.value) continue
    const record = result.value
    const cat = catLookups[i]
    if (!cat) continue
    if (!isMemoryActive(record, "category", config, nowMs)) continue
    const recent = record.signals.filter((s) => {
      const ts = Date.parse(s.ts)
      return (
        Number.isFinite(ts) &&
        ts >= nowMs - config.maxSignalAgeDays * 24 * 60 * 60 * 1000 &&
        s.kind === "dismissed-textual"
      )
    })
    findings.push({
      scope: "category",
      category: cat,
      signalCount: recent.length,
      lastSignalTs: pickLastSignalTs(record),
      suggestedAction: "soften",
    })
  }

  for (let i = 0; i < pathSettled.length; i++) {
    const result = pathSettled[i]
    if (!result || result.status !== "fulfilled" || !result.value) continue
    const record = result.value
    const lookup = pathLookups[i]
    if (!lookup) continue
    if (!isMemoryActive(record, "path-category", config, nowMs)) continue
    const recent = record.signals.filter((s) => {
      const ts = Date.parse(s.ts)
      return (
        Number.isFinite(ts) &&
        ts >= nowMs - config.maxSignalAgeDays * 24 * 60 * 60 * 1000 &&
        s.kind === "dismissed-textual"
      )
    })
    findings.push({
      scope: "path-category",
      category: lookup.category,
      pathSha12: lookup.pathSha256.slice(0, 12),
      signalCount: recent.length,
      lastSignalTs: pickLastSignalTs(record),
      suggestedAction: "soften",
    })
  }

  const top = selectTopMemories(findings, config.maxInjectedMemories)
  const durationMs = Date.now() - t0
  emitTelemetry("review-memory-lookup-ran", {
    owner, repo, prNumber,
    memoriesFound: findings.length,
    memoriesInjected: top.length,
    durationMs,
  })
  return { skipped: false, findings: top, durationMs }
}
