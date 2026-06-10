// ARC-263 — per-file walkthrough cache for `handlePrOverview`.
//
// Before this module, every PR webhook (opened / synchronize) ran
// the full diff through Ollama, regenerating per-file rows even when
// individual files hadn't changed since the last push. That was a
// material cost on iteration-heavy PRs (commit fixup → push → review,
// 5x cycles burned 5x Ollama calls on the SAME unchanged files).
//
// Caching strategy:
//   - Key:   `pr-overview-file-cache:<owner>/<repo>#<prNumber>:<path-sha256>:<patch-sha256>`
//            Path is hashed too so renames don't collide. (Renaming
//            `src/a.ts` → `src/b.ts` with the same patch content
//            should miss the cache — the customer-visible row says
//            "Renamed from a → b" and that's the model's territory.)
//   - Value: JSON-encoded `{path, score, overview, nextStep}` row,
//            byte-identical to the parser's output shape so we can
//            inject cached rows into the verdict without re-validation.
//   - TTL:   30 days. Old PRs roll off organically; long-lived PRs
//            see their cache silently refresh on next miss.
//
// Race-safety: the cache is advisory. Concurrent overview runs on
// the same PR (different head SHAs, or queue retries) may double-write
// the SAME row — that's a fixed-point overwrite, semantically a no-op.
//
// Failure posture: read / write failures log + return a clean miss,
// they NEVER fail the overview pipeline.

import type { Env } from "@/src/shared/types/env"

export interface CachedFileRow {
  path: string
  score: number
  overview: string
  nextStep: string
}

const CACHE_KEY_PREFIX = "pr-overview-file-cache"
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

/**
 * Compute a SHA-256 hash of the input string, truncated to 24 hex
 * chars (96 bits — plenty for a per-(PR, path) key namespace, keeps
 * the KV key length short and easy to grep in logs).
 */
async function shortSha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", data)
  const bytes = new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < 12; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Build the KV key for a single per-file cache entry. Exported for
 * the test surface; production callers use `readFileCache` /
 * `writeFileCache` which compose this internally.
 */
export async function buildCacheKey(args: {
  owner: string
  repo: string
  prNumber: number
  filename: string
  patch: string
}): Promise<string> {
  const pathHash = await shortSha256Hex(args.filename)
  const patchHash = await shortSha256Hex(args.patch)
  return `${CACHE_KEY_PREFIX}:${args.owner.toLowerCase()}/${args.repo.toLowerCase()}#${args.prNumber}:${pathHash}:${patchHash}`
}

/**
 * Read a single cached row. Returns null on a cache miss, on a
 * KV read failure (logged), or on a malformed cached payload.
 */
export async function readFileCache(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  filename: string
  patch: string
}): Promise<CachedFileRow | null> {
  const { env, ...keyArgs } = args
  const key = await buildCacheKey(keyArgs)
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-file-cache-read-failed",
      owner: args.owner, repo: args.repo, pr_number: args.prNumber,
      filename: args.filename,
      err: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CachedFileRow>
    if (
      typeof parsed.path === "string" &&
      typeof parsed.score === "number" &&
      typeof parsed.overview === "string" &&
      typeof parsed.nextStep === "string"
    ) {
      return parsed as CachedFileRow
    }
    return null
  } catch {
    // Malformed cached payload — treat as miss; the overview pipeline
    // will regenerate and overwrite on success.
    return null
  }
}

/**
 * Write a single cached row. Best-effort — a KV put failure logs +
 * returns. The next overview run on this PR will simply pay the
 * Ollama cost again (idempotent).
 */
export async function writeFileCache(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  filename: string
  patch: string
  row: CachedFileRow
}): Promise<void> {
  const { env, row, ...keyArgs } = args
  const key = await buildCacheKey(keyArgs)
  try {
    await env.OPENCLAW_STATE.put(key, JSON.stringify(row), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-file-cache-write-failed",
      owner: args.owner, repo: args.repo, pr_number: args.prNumber,
      filename: args.filename,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

/**
 * Batch-read the cache for an array of (filename, patch) pairs.
 * Returns `{ hits, misses }` — `hits` is a `Map<filename, row>` of
 * cached rows; `misses` is the subset of files that need Ollama.
 *
 * Files without a `patch` field (binary diffs / >500 KB per GitHub's
 * cutoff) are always misses — there's nothing stable to hash.
 */
export async function batchReadFileCache(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  files: Array<{ filename: string; patch?: string }>
}): Promise<{
  hits: Map<string, CachedFileRow>
  misses: Array<{ filename: string; patch?: string }>
}> {
  const hits = new Map<string, CachedFileRow>()
  const misses: Array<{ filename: string; patch?: string }> = []
  // Parallel reads — KV's per-request consistency is per-key, so
  // there's no ordering concern.
  await Promise.all(args.files.map(async (f) => {
    if (typeof f.patch !== "string" || f.patch.length === 0) {
      misses.push(f)
      return
    }
    const row = await readFileCache({
      env: args.env,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      filename: f.filename,
      patch: f.patch,
    })
    if (row !== null) {
      hits.set(f.filename, row)
    } else {
      misses.push(f)
    }
  }))
  return { hits, misses }
}

/**
 * Batch-write fresh rows for the misses that came back from Ollama.
 * Best-effort; per-row write failures isolated by `writeFileCache`.
 * Caller passes the misses array + a `path → row` resolver.
 */
export async function batchWriteFileCache(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  misses: Array<{ filename: string; patch?: string }>
  rows: ReadonlyArray<CachedFileRow>
}): Promise<{ written: number }> {
  const byPath = new Map<string, CachedFileRow>()
  for (const r of args.rows) byPath.set(r.path, r)
  let written = 0
  await Promise.all(args.misses.map(async (m) => {
    if (typeof m.patch !== "string" || m.patch.length === 0) return
    const row = byPath.get(m.filename)
    if (!row) return // model didn't emit a row for this file — skip
    await writeFileCache({
      env: args.env,
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
      filename: m.filename, patch: m.patch, row,
    })
    written += 1
  }))
  return { written }
}
