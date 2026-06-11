#!/usr/bin/env node
// Phase 4 bake-off harness — paired comparison of Phase 4 ensemble
// review vs. Phase 3 single-agent review on the same PR/SHA.
//
//   node scripts/phase4-bakeoff.mjs [--limit=N] [--out=DIR] [--repo=owner/repo]
//
// Reads `ensemble-review-telemetry:*` records from production KV
// (OPENCLAW_STATE = df689379ea6240f7808997a75ceaed7e), pages newest-
// first (reverse-timestamped keys). For each ensemble record:
//
//   1. Pulls the corresponding Phase 3 review FROM GITHUB (the live
//      review submitted by arc-copilot on the same PR + SHA). Phase
//      3's PR review path doesn't write KV telemetry — the review on
//      GitHub IS the source of truth.
//   2. Joins ensemble + Phase 3 by (owner, repo, prNumber, headSha).
//   3. Computes paired comparison metrics: finding counts, max
//      severity, overlap estimate (file+line match), ensemble-only,
//      phase3-only, per-specialist breakdown.
//   4. Writes per-pair JSON + a _summary.json.
//
// Designed for the v3.1 LOCKED Phase 4b workflow:
//   - Step 2 of Phase 4b roadmap (this script)
//   - Step 3 = human-labeled sample evaluation; this script outputs
//     enough detail for that to happen quickly.
//
// Auth (three env vars required — OLLAMA is NOT used by this script):
//   CLOUDFLARE_ACCOUNT_ID   — owns OPENCLAW_STATE KV
//   CLOUDFLARE_API_TOKEN    — Workers KV Read on the namespace
//   GH_TOKEN or GITHUB_TOKEN — for fetching Phase 3 reviews from
//                             GitHub (any PAT with public_repo or a
//                             repo-scoped token for private repos)

import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"

const KV_NAMESPACE_ID = "df689379ea6240f7808997a75ceaed7e"
const KEY_PREFIX = "ensemble-review-telemetry:"
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
const GITHUB_API_BASE = "https://api.github.com"
const KV_LIST_PAGE_SIZE = 1000
const KV_REQUEST_TIMEOUT_MS = 30_000
const GITHUB_REQUEST_TIMEOUT_MS = 15_000

const args = parseArgs(process.argv.slice(2))
const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
const cfApiToken = process.env.CLOUDFLARE_API_TOKEN
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const missingEnv = [
  ["CLOUDFLARE_ACCOUNT_ID", cfAccountId],
  ["CLOUDFLARE_API_TOKEN", cfApiToken],
  ["GH_TOKEN or GITHUB_TOKEN", githubToken],
]
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (missingEnv.length > 0) {
  console.error(`error: missing required env var(s): ${missingEnv.join(", ")}`)
  process.exit(1)
}
if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 0)) {
  console.error(`error: --limit must be a non-negative integer (got ${args.limit})`)
  process.exit(1)
}

const runId = new Date().toISOString().replace(/[:.]/g, "-")
const outDir = args.out ? resolve(args.out) : resolve(`bakeoff-runs/phase4-${runId}`)
await mkdir(outDir, { recursive: true })

console.log(`[bakeoff] phase 4 run ${runId}`)
console.log(`[bakeoff] output: ${outDir}`)
console.log(`[bakeoff] listing keys with prefix '${KEY_PREFIX}'…`)

const keys = await listKvKeys(KEY_PREFIX)
console.log(`[bakeoff] found ${keys.length} ensemble telemetry record(s)`)

let kept = keys
if (args.repo) {
  kept = kept.filter((k) => k.includes(`:${args.repo.toLowerCase()}#`))
  console.log(`[bakeoff] repo=${args.repo} → ${kept.length} record(s)`)
}
if (args.limit !== null) {
  if (kept.length > args.limit) kept = kept.slice(0, args.limit)
  console.log(`[bakeoff] limit=${args.limit} → ${kept.length} record(s)`)
}

if (kept.length === 0) {
  console.log("[bakeoff] nothing to compare — exiting clean")
  process.exit(0)
}

const summary = []
for (let i = 0; i < kept.length; i++) {
  const key = kept[i]
  const tag = `${i + 1}/${kept.length} ${key}`
  try {
    console.log(`[bakeoff] [${tag}] fetching ensemble record`)
    const ensemble = await getKvJson(key)
    if (!ensemble || typeof ensemble !== "object") {
      console.warn(`[bakeoff] [${tag}] ensemble payload not an object — skipping`)
      continue
    }
    const { owner, repo, prNumber, headSha } = ensemble
    if (!owner || !repo || !prNumber || !headSha) {
      console.warn(`[bakeoff] [${tag}] missing owner/repo/prNumber/headSha — skipping`)
      continue
    }

    console.log(`[bakeoff] [${tag}] fetching phase3 review from GitHub`)
    const phase3 = await fetchPhase3Review({ owner, repo, prNumber, headSha })

    const comparison = comparePair(phase3, ensemble)
    const pairRecord = {
      runId,
      pairKey: `${owner}/${repo}#${prNumber}@${headSha}`,
      owner,
      repo,
      prNumber,
      headSha,
      phase3,
      phase4: {
        source: "ensemble-review-telemetry",
        mode: ensemble.mode,
        fellBackToPhase3: ensemble.fellBackToPhase3,
        fellBackReason: ensemble.fellBackReason ?? null,
        routerDecision: ensemble.routerDecision ?? null,
        verdict: ensemble.shadowVerdict ?? null,
        synthesizer: ensemble.synthesizer ?? null,
        specialistVerdicts: ensemble.specialistVerdicts ?? [],
        postValidation: ensemble.postValidation ?? null,
        retrievalCacheStats: ensemble.retrievalCacheStats ?? null,
        totalMs: ensemble.totalMs,
      },
      comparison,
    }

    const fname = sanitizeKey(key) + ".json"
    await writeFile(join(outDir, fname), JSON.stringify(pairRecord, null, 2))
    summary.push({
      pairKey: pairRecord.pairKey,
      phase3FindingsCount: comparison.phase3FindingsCount,
      phase4FindingsCount: comparison.phase4FindingsCount,
      phase3MaxScore: comparison.phase3MaxScore,
      phase4MaxScore: comparison.phase4MaxScore,
      overlapEstimate: comparison.overlapEstimate,
      phase4Only: comparison.phase4Only,
      phase3Only: comparison.phase3Only,
      ensembleSpecialistsBreakdown: comparison.ensembleSpecialistsBreakdown,
      ensembleFellBack: ensemble.fellBackToPhase3,
      phase3Available: phase3 !== null,
    })
    console.log(
      `[bakeoff] [${tag}] paired — phase3:${comparison.phase3FindingsCount}f phase4:${comparison.phase4FindingsCount}f overlap:${comparison.overlapEstimate}`,
    )
  } catch (e) {
    console.error(`[bakeoff] [${tag}] failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const summaryPayload = {
  runId,
  generatedAt: new Date().toISOString(),
  totalPairs: summary.length,
  aggregates: aggregate(summary),
  records: summary,
}
await writeFile(join(outDir, "_summary.json"), JSON.stringify(summaryPayload, null, 2))

console.log("")
console.log(`[bakeoff] wrote ${summary.length} paired record(s) to ${outDir}`)
console.log(`[bakeoff] aggregate: ${JSON.stringify(summaryPayload.aggregates, null, 2)}`)
console.log(`[bakeoff] summary: ${join(outDir, "_summary.json")}`)

// ─── helpers ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { limit: null, repo: null, out: null }
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) {
      throw new Error(`invalid argument '${arg}' — expected --key=value`)
    }
    const eq = arg.indexOf("=")
    const k = arg.slice(2, eq)
    const v = arg.slice(eq + 1)
    if (k === "limit") {
      out.limit = /^\d+$/.test(v) ? Number(v) : Number.NaN
    } else if (k === "repo") {
      out.repo = v
    } else if (k === "out") {
      out.out = v
    } else {
      throw new Error(`unknown flag --${k}`)
    }
  }
  return out
}

async function listKvKeys(prefix) {
  const all = []
  let cursor = ""
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: String(KV_LIST_PAGE_SIZE) })
    if (cursor) params.set("cursor", cursor)
    const url = `${CLOUDFLARE_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?${params}`
    const json = await cloudflareJsonGet(url)
    if (!json.success) throw new Error(`KV list failed: ${formatCfErrors(json)}`)
    if (!Array.isArray(json.result)) throw new Error("KV list returned non-array result")
    for (const entry of json.result) all.push(entry.name)
    cursor = json.result_info?.cursor ?? ""
    if (!cursor || json.result.length === 0) break
  }
  return all.sort() // reverse-timestamped keys → newest first lexicographically
}

async function getKvJson(key) {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfApiToken}` },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`KV get HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return JSON.parse(await res.text())
  } finally {
    clearTimeout(timer)
  }
}

async function cloudflareJsonGet(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${cfApiToken}`,
        accept: "application/json",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Cloudflare API HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function formatCfErrors(json) {
  if (!Array.isArray(json.errors)) return JSON.stringify(json).slice(0, 300)
  return json.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
}

/**
 * Fetch the Phase 3 review for this PR + SHA from GitHub. Returns null
 * if no matching review exists (e.g., Phase 3 hasn't run on this SHA
 * for some reason — shouldn't happen in shadow mode but is possible
 * if Phase 3 itself failed silently).
 */
// Bot logins this script accepts as "ours" when filtering Phase 3
// reviews to compare against. Includes the current Sigilix brand AND
// every legacy alias from the rebrand chain so historical bake-off data
// remains comparable across the rename boundary. Stored lowercased so
// the membership check is case-insensitive — GitHub bot logins are
// canonically lowercase but defending against drift here is cheap and
// avoids a silent zero-match if casing ever differs (CR PR #39 catch).
const SELF_BOT_LOGINS = new Set(["sigilix[bot]", "arc-copilot[bot]", "openclaw[bot]"].map((s) => s.toLowerCase()))

async function fetchPhase3Review({ owner, repo, prNumber, headSha }) {
  // Reviews list endpoint is paginated; default 30, max 100. Walk
  // every page so the matching self-bot review is never silently
  // missed because it lives past the first page (CR + arc PR #36 catch).
  const reviews = await githubGetPaginated(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`)
  // Filter to reviews on this SHA, by Sigilix (or a legacy alias), with
  // our dedupe marker. Login compared lowercased — see SELF_BOT_LOGINS.
  const matching = reviews.filter(
    (r) =>
      r.commit_id === headSha &&
      typeof r.user?.login === "string" &&
      SELF_BOT_LOGINS.has(r.user.login.toLowerCase()) &&
      typeof r.body === "string" &&
      r.body.includes("<!-- openclaw:pr-review -->"),
  )
  if (matching.length === 0) return null
  // Pick the latest (highest submitted_at) — there should usually be
  // exactly one but defensively handle multiples.
  matching.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
  const chosen = matching[0]

  // Pull inline comments for this review to reconstruct the findings list.
  const inline = await fetchReviewInlineComments({ owner, repo, prNumber, reviewId: chosen.id })

  return {
    source: "github_review",
    reviewId: chosen.id,
    submittedAt: chosen.submitted_at,
    state: chosen.state,
    body: chosen.body,
    findings: inline.map((c) => ({
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? "RIGHT",
      body: c.body,
      score: extractScoreFromBody(c.body),
    })),
  }
}

async function fetchReviewInlineComments({ owner, repo, prNumber, reviewId }) {
  // GitHub only exposes per-review comments via the dedicated endpoint;
  // the PR-comments endpoint conflates reviews. Use the per-review one.
  // Also paginated (default 30, max 100). Use the same paginated helper
  // and THROW on non-ok so silent [] doesn't skew comparison metrics
  // in Phase 4's favor when GitHub returns 401/403/429 (arc PR #36 catch).
  return githubGetPaginated(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`)
}

/**
 * Walk a paginated GitHub REST endpoint, returning the concatenated
 * list of items. Uses `?per_page=100` to minimize round trips and
 * follows the `Link: rel="next"` header for full coverage. THROWS on
 * non-2xx so callers can't silently miss pages (arc + CR PR #36 catch).
 */
async function githubGetPaginated(baseUrl) {
  const all = []
  // Add per_page=100 to the URL (preserve any existing query params).
  const url0 = new URL(baseUrl)
  url0.searchParams.set("per_page", "100")
  let nextUrl = url0.toString()
  while (nextUrl) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), GITHUB_REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(nextUrl, {
        headers: {
          authorization: `Bearer ${githubToken}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`GitHub API HTTP ${res.status} on ${nextUrl}: ${text.slice(0, 500)}`)
      }
      const page = await res.json()
      if (Array.isArray(page)) all.push(...page)
      nextUrl = parseLinkHeaderNext(res.headers.get("link"))
    } finally {
      clearTimeout(timer)
    }
  }
  return all
}

/**
 * Extract the `rel="next"` URL from a GitHub Link header. Returns
 * null when no next page (last page or single page).
 *
 * Header looks like:
 *   <https://api.github.com/...?page=2>; rel="next", <...>; rel="last"
 */
function parseLinkHeaderNext(header) {
  if (!header) return null
  const parts = header.split(",")
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/**
 * Phase 3 review comments are formatted with category prefix +
 * sometimes a `**score: N**` line. Extract score via heuristic regex;
 * return null when not found.
 */
function extractScoreFromBody(body) {
  if (typeof body !== "string") return null
  const m = body.match(/\*\*score:?\s*(\d)\*\*/i) ?? body.match(/\bscore\s*[:=]\s*(\d)\b/i)
  return m ? Number(m[1]) : null
}

// ─── pairing + comparison ─────────────────────────────────────────────

/**
 * Compute paired comparison metrics. Conservative — uses file+line for
 * overlap estimation; a more sophisticated match could compare headlines
 * or summary text but that's downstream tooling territory.
 */
function comparePair(phase3, ensemble) {
  const phase3Findings = phase3?.findings ?? []
  const phase4Verdict = ensemble.shadowVerdict
  const phase4Findings = phase4Verdict?.findings ?? []

  const phase3Keys = new Set(phase3Findings.map(positionKey))
  const phase4Keys = new Set(phase4Findings.map(positionKey))

  const overlap = [...phase3Keys].filter((k) => phase4Keys.has(k)).length
  const phase4Only = phase4Findings.filter((f) => !phase3Keys.has(positionKey(f))).length
  const phase3Only = phase3Findings.filter((f) => !phase4Keys.has(positionKey(f))).length

  const phase3MaxScore = maxScore(phase3Findings)
  const phase4MaxScore = maxScore(phase4Findings)

  // Per-specialist breakdown: how many findings each specialist
  // contributed (regardless of whether they were dedupe-merged into the
  // synthesizer's final verdict). Useful for "which specialist actually
  // produced value" analysis in phase 4b.
  const ensembleSpecialistsBreakdown = {}
  for (const sv of ensemble.specialistVerdicts ?? []) {
    if (sv.verdict?.findings) {
      ensembleSpecialistsBreakdown[sv.role] = sv.verdict.findings.length
    } else {
      ensembleSpecialistsBreakdown[sv.role] = 0
    }
  }

  return {
    phase3FindingsCount: phase3Findings.length,
    phase4FindingsCount: phase4Findings.length,
    phase3MaxScore,
    phase4MaxScore,
    overlapEstimate: overlap,
    phase4Only,
    phase3Only,
    ensembleSpecialistsBreakdown,
  }
}

function positionKey(finding) {
  return `${finding.path}:${finding.line ?? "?"}`
}

function maxScore(findings) {
  let max = 0
  for (const f of findings) {
    const s = typeof f.score === "number" ? f.score : 0
    if (s > max) max = s
  }
  return max
}

function aggregate(summary) {
  const total = summary.length
  if (total === 0) return { total: 0 }
  let phase3Findings = 0
  let phase4Findings = 0
  let totalOverlap = 0
  let totalPhase4Only = 0
  let totalPhase3Only = 0
  let phase4Sev4Plus = 0
  let phase3Sev4Plus = 0
  let phase3Available = 0
  let ensembleFellBack = 0
  for (const r of summary) {
    phase3Findings += r.phase3FindingsCount
    phase4Findings += r.phase4FindingsCount
    totalOverlap += r.overlapEstimate
    totalPhase4Only += r.phase4Only
    totalPhase3Only += r.phase3Only
    if (r.phase4MaxScore >= 4) phase4Sev4Plus++
    if (r.phase3MaxScore >= 4) phase3Sev4Plus++
    if (r.phase3Available) phase3Available++
    if (r.ensembleFellBack) ensembleFellBack++
  }
  return {
    total,
    phase3Available,
    ensembleFellBack,
    avgPhase3Findings: round(phase3Findings / total),
    avgPhase4Findings: round(phase4Findings / total),
    avgOverlap: round(totalOverlap / total),
    avgPhase4Only: round(totalPhase4Only / total),
    avgPhase3Only: round(totalPhase3Only / total),
    prsWithPhase4Sev4Plus: phase4Sev4Plus,
    prsWithPhase3Sev4Plus: phase3Sev4Plus,
    deltaSev4PlusPrs: phase4Sev4Plus - phase3Sev4Plus,
  }
}

function round(n) {
  return Math.round(n * 100) / 100
}

function sanitizeKey(key) {
  return key.replace(/[^A-Za-z0-9._-]/g, "_")
}
