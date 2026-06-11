// SIG-184 PR 2 — in-isolate cached JWKS fetcher for the runner OIDC verifier.
//
// PR 1's verify.ts takes an injectable `fetchJwks`; its default hits GitHub on
// EVERY verify. This wraps GitHub's well-known JWKS in a bounded, single-flight,
// per-isolate cache (the `gate-config.ts` pattern) so steady-state ingest pays
// no JWKS fetch. Deliberately NOT `caches.default` (zero usage in this repo) and
// NOT KV — a ~2-key blob shared globally needs neither cross-isolate persistence
// nor per-binding scoping, so a plain module-global is enough.
//
// Key-rotation safety is a TWO-part contract with the route:
//   1. a bounded TTL caps steady-state staleness, and
//   2. the route retries an `unknown-kid` verify ONCE with `forceRefetch` so a
//      freshly-rotated GitHub key isn't rejected as stale.
// To stop `unknown-kid` spam (random kids in forged tokens) from amplifying into
// a GitHub-JWKS DoS, a forced refetch is THROTTLED: it actually refetches at
// most once per FORCE_REFETCH_COOLDOWN_MS; within the cooldown it serves cache.

import { GITHUB_OIDC_JWKS_URL, type Jwk } from "./types"

/** TTL for cached keys. GitHub rotates its signing keys rarely. */
const JWKS_TTL_MS = 10 * 60_000
/** A forced refetch fires at most once per this window per isolate. */
const FORCE_REFETCH_COOLDOWN_MS = 60_000
const DEFAULT_TIMEOUT_MS = 3000

type CacheEntry = { kind: "value"; keys: Jwk[]; expiresAt: number } | { kind: "pending"; promise: Promise<Jwk[]> }

// Module-global, isolate-scoped. JWKS is a single global blob (not per-binding),
// so a plain variable suffices (simpler than gate-config's per-KV WeakMap).
let cache: CacheEntry | null = null
let lastForcedRefetchMs = 0

/** One uncached GET of GitHub's JWKS, with an AbortController deadline. */
async function fetchFromGitHub(timeoutMs: number): Promise<Jwk[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(GITHUB_OIDC_JWKS_URL, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`jwks ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    return Array.isArray(body.keys) ? body.keys : []
  } finally {
    clearTimeout(timer)
  }
}

/** Refresh the cache (single-flight) and resolve with the keys. */
function refresh(timeoutMs: number, nowMs: number): Promise<Jwk[]> {
  // Build the pending slot first so the failure handler can check OUR identity.
  const entry = { kind: "pending" as const, promise: undefined as unknown as Promise<Jwk[]> }
  entry.promise = fetchFromGitHub(timeoutMs)
    .then((keys) => {
      cache = { kind: "value", keys, expiresAt: nowMs + JWKS_TTL_MS }
      return keys
    })
    .catch((err) => {
      // Identity-aware: drop ONLY our own pending slot, never a newer
      // pending/value installed by a concurrent refresh — a stale failure must
      // not clobber a live slot. Rethrow so verify.ts maps it to
      // `jwks-fetch-failed`.
      if (cache === entry) cache = null
      throw err
    })
  cache = entry
  return entry.promise
}

/**
 * Build a `fetchJwks` for `VerifyOpts`.
 *
 * - normal call: serve fresh cached keys, await an in-flight refresh, or fetch.
 * - `forceRefetch`: bypass the cache to pick up a rotated key — but THROTTLED to
 *   one real refetch per cooldown so forged `unknown-kid` tokens can't amplify
 *   into a GitHub-JWKS DoS. Within the cooldown it serves whatever is cached
 *   (which, right after a forced refetch, is fresh and already has the new key).
 */
export function makeCachedFetchJwks(opts?: {
  forceRefetch?: boolean
  timeoutMs?: number
  /** Test seam for deterministic TTL/cooldown. Defaults to `Date.now`. */
  now?: () => number
}): () => Promise<Jwk[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts?.now ?? Date.now
  return () => {
    const nowMs = now()
    if (opts?.forceRefetch) {
      // An in-flight refresh is ALREADY a fresh GitHub fetch — coalesce with it
      // instead of starting a second one (keeps single-flight under concurrency).
      if (cache?.kind === "pending") return cache.promise
      if (nowMs - lastForcedRefetchMs >= FORCE_REFETCH_COOLDOWN_MS) {
        // Attempt-stamp (not success-stamp) so the fetch RATE stays bounded even
        // while GitHub's JWKS is failing; a legit runner caught by a transient
        // blip during a key rotation gets a 503-retry from the route, not a 401.
        lastForcedRefetchMs = nowMs
        return refresh(timeoutMs, nowMs)
      }
      // throttled — fall through to serve the cache / a normal fetch.
    }
    if (cache?.kind === "value" && cache.expiresAt > nowMs) return Promise.resolve(cache.keys)
    if (cache?.kind === "pending") return cache.promise
    return refresh(timeoutMs, nowMs)
  }
}

/**
 * Whether a forced refetch would ACTUALLY fire right now (cooldown elapsed),
 * vs be throttled to the stale cache. The route uses this to distinguish a
 * genuine `unknown-kid` (→ 401) from one where a freshly-rotated key may simply
 * be behind a cooling-down cache (→ 503 retry, so a legit CI run isn't failed).
 */
export function forcedRefetchAvailable(now?: () => number): boolean {
  const nowMs = (now ?? Date.now)()
  return nowMs - lastForcedRefetchMs >= FORCE_REFETCH_COOLDOWN_MS
}

/** Test-only: reset the module-global cache + cooldown. */
export function __resetJwksCacheForTests(): void {
  cache = null
  lastForcedRefetchMs = 0
}
