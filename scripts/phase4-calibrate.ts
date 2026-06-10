#!/usr/bin/env -S npx tsx
// SIG-280 PR C — Phase 4 review-memory soften CALIBRATION fit.
//
//   npx tsx scripts/phase4-calibrate.mjs [--repo=owner/repo] [--write] [--out=DIR]
//
// Reads the two production corpora from KV (OPENCLAW_STATE):
//
//   1. `review-memory-claim-shadow:*` — the claim-matched findings the
//      bot RAISED (the denominator candidates). Each record carries
//      `prNumber` + `matches[]` (ShadowMatchRow with `fid` + `claimType`);
//      the record's creation time is recovered from the key's reverse-ts.
//   2. `review-memory:*` — the dismissal SIGNALS (the positive labels).
//      Each record's `signals[]` carry `{ fid, prNumber }`.
//
// Joins them with the leakage-safe distinct-PR rule (a shadow row is a
// dismissal success iff a signal with the same fid exists at the SAME or
// a LATER PR — excluding the dismissal that BUILT the memory), fits the
// Beta(1,9) lower bound per claim type, and prints the params blob plus a
// ready-to-run `wrangler kv key put`. With `--write` it PUTs the blob to
// `calibration-params:v1:claim-types` via the Cloudflare API.
//
// The believability math (Beta(1,9) lower bound, distinct-PR join,
// 14-day maturity lag) lives in src/lib/review-memory/calibration-fit.ts
// and is unit-tested — this script is only the KV I/O + reporting shell.
//
// Auth (env):
//   CLOUDFLARE_ACCOUNT_ID  — owns OPENCLAW_STATE KV
//   CLOUDFLARE_API_TOKEN   — Workers KV Read (+ Write when --write)

import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"

import {
  computeClaimCalibration,
  type CalibrationShadowRecord,
  type CalibrationDismissal,
} from "@/src/lib/review-memory/calibration-fit"
import { CALIBRATION_PARAMS_KV_KEY } from "@/src/lib/review-memory/calibration"

const KV_NAMESPACE_ID = "df689379ea6240f7808997a75ceaed7e"
const SHADOW_PREFIX = "review-memory-claim-shadow:"
const MEMORY_PREFIX = "review-memory:"
const CF_API_BASE = "https://api.cloudflare.com/client/v4"
const KV_LIST_PAGE_SIZE = 1000
const KV_REQUEST_TIMEOUT_MS = 30_000
const REVERSE_TS_BASE = 9_999_999_999_999

const args = parseArgs(process.argv.slice(2))
const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
const cfApiToken = process.env.CLOUDFLARE_API_TOKEN
const missing = [
  ["CLOUDFLARE_ACCOUNT_ID", cfAccountId],
  ["CLOUDFLARE_API_TOKEN", cfApiToken],
].filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`error: missing required env var(s): ${missing.join(", ")}`)
  process.exit(1)
}
// --repo is MANDATORY (Codex P2): the leakage-safe join compares raw PR
// NUMBERS (signal.prNumber >= shadow.prNumber) and dedupes the denominator
// by PR number — both are per-repo. Fitting across multiple repos in one
// pass would collapse repo-A #50 and repo-B #50 into one observation and
// let one repo's dismissal mark another's denominator successful. Multi-
// tenant calibration must stratify per repo; until then fit ONE repo per
// run. (DeepSeek-v4-pro: within-repo only — Simpson's paradox.)
if (!args.repo) {
  console.error(
    "error: --repo=owner/repo is required — the PR-number join is per-repo; " +
      "fit one repo per run (re-run per repo for multi-tenant).",
  )
  process.exit(1)
}
// Validate the repo format strictly (Sigilix dogfood finding): the value is
// lower-cased + compared against the shadow event's `owner/repo`, so a
// malformed string just silently matches nothing. Reject it up front with a
// clear error rather than producing a confusing empty fit.
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(args.repo)) {
  console.error(`error: --repo must be "owner/repo" (got: ${args.repo})`)
  process.exit(1)
}

const nowMs = Date.now()
const runId = new Date(nowMs).toISOString().replace(/[:.]/g, "-")

console.log(`[calibrate] run ${runId} — repo ${args.repo}`)
const repoLc = args.repo.toLowerCase()

// ─── Corpus A: claim-matched shadow rows (denominator candidates) ──────
// Scoped to --repo by the event PAYLOAD's owner/repo (precise — not a
// key-substring match, which could catch a repo whose name is a substring
// of another).
console.log(`[calibrate] listing '${SHADOW_PREFIX}'…`)
const shadowKeys = await listKvKeys(SHADOW_PREFIX)
const shadowRecords: CalibrationShadowRecord[] = []
for (const key of shadowKeys) {
  const value = await getKvJson(key)
  if (!value || typeof value !== "object" || !Array.isArray(value.matches)) continue
  if (`${value.owner}/${value.repo}`.toLowerCase() !== repoLc) continue
  const prNumber = Number(value.prNumber)
  if (!Number.isInteger(prNumber)) continue
  const createdMs = createdMsFromKey(key, SHADOW_PREFIX)
  if (createdMs === null) {
    console.warn(`[calibrate] skipping malformed shadow key: ${key}`)
    continue
  }
  shadowRecords.push({
    prNumber,
    createdMs,
    rows: value.matches
      .filter((m: unknown): m is { fid: string; claimType?: unknown } =>
        !!m && typeof (m as { fid?: unknown }).fid === "string",
      )
      .map((m) => ({ fid: m.fid, claimType: (m.claimType ?? null) as CalibrationShadowRecord["rows"][number]["claimType"] })),
  })
}
console.log(`[calibrate] ${shadowRecords.length} shadow record(s) for ${args.repo}`)

// ─── Corpus B: dismissal signals (positive labels) ─────────────────────
// The dismissal keyspace is keyed by repo:<id> / owner-slash-repo (NOT the
// owner/repo#pr the shadow keys use) and the records carry no owner/repo
// field, so it cannot be --repo-filtered here. SINGLE-TENANT assumption
// (Codex P2): the namespace holds one repo's dismissals today, so reading
// all is correct — the fid + per-repo PR-number join already scopes the
// labels to the shadow repo. Multi-tenant MUST key dismissals by repo id.
console.log(`[calibrate] listing '${MEMORY_PREFIX}'…`)
const memoryKeys = (await listKvKeys(MEMORY_PREFIX)).filter(
  (k) => !k.startsWith(SHADOW_PREFIX) && !k.startsWith(CALIBRATION_PARAMS_KV_KEY),
)
console.log(`[calibrate] ${memoryKeys.length} memory record(s) (all repos — single-tenant)`)

const dismissals: CalibrationDismissal[] = []
for (const key of memoryKeys) {
  const value = await getKvJson(key)
  if (!value || typeof value !== "object" || !Array.isArray(value.signals)) continue
  for (const s of value.signals) {
    if (s && typeof s.fid === "string" && Number.isInteger(Number(s.prNumber))) {
      dismissals.push({ fid: s.fid, prNumber: Number(s.prNumber) })
    }
  }
}
console.log(`[calibrate] ${dismissals.length} dismissal signal(s)`)

// ─── Fit ───────────────────────────────────────────────────────────────
const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs })

console.log("")
console.log("[calibrate] per-claim-type params:")
for (const [type, p] of Object.entries(blob)) {
  console.log(
    `  ${type}: n=${p.n} s=${p.s} lowerBound=${p.lowerBound.toFixed(4)} ` +
      `trustworthyN=${p.trustworthyN} cold=${p.cold}`,
  )
}
if (Object.keys(blob).length === 0) {
  console.log("  (no claim type has any mature observations yet)")
}

const blobJson = JSON.stringify(blob)
const outDir = args.out ? resolve(args.out) : resolve(`bakeoff-runs/phase4-calibrate-${runId}`)
await mkdir(outDir, { recursive: true })
const outFile = join(outDir, "calibration-params.json")
await writeFile(outFile, JSON.stringify(blob, null, 2))
console.log("")
console.log(`[calibrate] wrote ${outFile}`)

if (args.write) {
  console.log(`[calibrate] --write: PUT ${CALIBRATION_PARAMS_KV_KEY} → KV…`)
  await putKvValue(CALIBRATION_PARAMS_KV_KEY, blobJson)
  console.log(`[calibrate] wrote params to KV. Soften activates per-type as values warm.`)
} else {
  console.log("[calibrate] dry run — to publish:")
  console.log(
    `  wrangler kv key put --namespace-id=${KV_NAMESPACE_ID} ` +
      `'${CALIBRATION_PARAMS_KV_KEY}' '${blobJson}'`,
  )
  console.log("  (or re-run with --write)")
}

// ─── helpers ───────────────────────────────────────────────────────────

interface ParsedArgs {
  repo: string | null
  write: boolean
  out: string | null
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { repo: null, write: false, out: null }
  for (const arg of argv) {
    if (arg === "--write") { out.write = true; continue }
    if (!arg.startsWith("--") || !arg.includes("=")) {
      throw new Error(`invalid argument '${arg}' — expected --key=value or --write`)
    }
    const eq = arg.indexOf("=")
    const k = arg.slice(2, eq)
    const v = arg.slice(eq + 1)
    if (k === "repo") out.repo = v
    else if (k === "out") out.out = v
    else throw new Error(`unknown flag --${k}`)
  }
  return out
}

/**
 * Recover the event creation time (ms) from a reverse-ts key segment.
 * Returns null on a malformed key (CodeRabbit: a parse failure must NOT
 * default to 0, which would look ancient and bypass the maturity gate —
 * letting a garbage record into the calibration denominator). The caller
 * skips records with a null createdMs.
 */
function createdMsFromKey(key: string, prefix: string): number | null {
  const rest = key.slice(prefix.length)
  const sep = rest.indexOf(":")
  if (sep <= 0) return null
  const reverseTs = Number(rest.slice(0, sep))
  if (!Number.isFinite(reverseTs)) return null
  const createdMs = REVERSE_TS_BASE - reverseTs
  return Number.isFinite(createdMs) ? createdMs : null
}

async function listKvKeys(prefix: string): Promise<string[]> {
  const all: string[] = []
  let cursor = ""
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: String(KV_LIST_PAGE_SIZE) })
    if (cursor) params.set("cursor", cursor)
    const url = `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?${params}`
    const json = await cfJson(url)
    if (!json.success) throw new Error(`KV list failed: ${formatCfErrors(json)}`)
    for (const entry of json.result) all.push(entry.name)
    cursor = json.result_info?.cursor ?? ""
    if (!cursor || json.result.length === 0) break
  }
  return all
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- KV values are arbitrary JSON; callers narrow.
async function getKvJson(key: string): Promise<any | null> {
  const url = `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfApiToken}` }, signal: ctrl.signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`KV get HTTP ${res.status} on ${key}`)
    return JSON.parse(await res.text())
  } catch (err) {
    // Skip a single record with malformed JSON (best-effort, observable), but
    // RETHROW transport/HTTP failures (CodeRabbit): silently dropping them
    // would bias the calibration denominator/labels — a fit must run on
    // complete data or fail loudly, never quietly produce skewed params.
    if (err instanceof SyntaxError) {
      console.warn(`[calibrate] JSON parse failed for key ${key}`)
      return null
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function putKvValue(key: string, value: string): Promise<void> {
  const url = `${CF_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${cfApiToken}`, "content-type": "text/plain" },
      body: value,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`KV put HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

interface CfListResponse {
  success: boolean
  result: Array<{ name: string }>
  result_info?: { cursor?: string }
  errors?: Array<{ code: number; message: string }>
}

async function cfJson(url: string): Promise<CfListResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfApiToken}`, accept: "application/json" },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Cloudflare API HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return (await res.json()) as CfListResponse
  } finally {
    clearTimeout(timer)
  }
}

function formatCfErrors(json: CfListResponse): string {
  if (!Array.isArray(json.errors)) return JSON.stringify(json).slice(0, 300)
  return json.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
}
