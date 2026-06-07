// SIG-336: per-review parse-once AST cache.
//
// The review path has several INDEPENDENT acorn consumers — the security rule
// runner (`runner.ts`), `graph-extract`, `helper-coverage`, `durable-object-
// spans`, and the logic-claim refutation gate (`validate-logic-claim-
// refutation.ts`) — that each called `parseSource` on the SAME source text with
// no shared cache. Worse, the logic-claim gate re-parsed the cited file once PER
// FINDING and applied no large-file guard, so a PR with several logic findings
// (or a finding citing a huge generated file) stacked synchronous acorn CPU
// toward the worker's 300s `cpu_ms` ceiling — the `exceededCpu` review-failure
// observed on PR #364.
//
// This cache parses each distinct path at most ONCE per review and applies the
// shared `LARGE_FILE_BYTES` skip uniformly. It is keyed by path: within a single
// review every consumer sees the same source snapshot for a given path, so path
// is a sound key. Parse failures AND large-file skips are memoized too, so a
// known-bad / oversized file is never re-attempted.

import { parseSource, LARGE_FILE_BYTES, type SourceExt, type ParseResult } from "./parser"

/** Discriminator prefix on the skip result's `reason`, so a consumer that wants
 *  distinct "skipped because large" telemetry (vs a genuine parse error) can
 *  branch on it. `parseSource` itself never produces this prefix. */
export const LARGE_FILE_SKIP_PREFIX = "file-too-large:"

/** CodeRabbit (PR #392): reason prefix returned when the same path is requested
 *  with a DIFFERENT source/ext than the cached entry — a cache-key invariant
 *  violation. Serving the stale AST would be wrong, so we fail safe (`ok:false`),
 *  which every consumer already treats as fail-open/skip. */
export const AST_CACHE_CONFLICT_PREFIX = "ast-cache-key-conflict:"

export interface AstCache {
  /**
   * Parse `source` (interpreted as `ext`) once per `path`, memoizing the result.
   * A source larger than `LARGE_FILE_BYTES` is NOT parsed — it returns
   * `{ ok: false, reason: "file-too-large:<bytes>" }`, mirroring the security
   * runner's pre-parse skip, so callers fail open exactly as before. The result
   * (ok, parse-error, or large-skip) is cached, so repeated `get(path, …)` calls
   * cost nothing.
   */
  get(path: string, source: string, ext: SourceExt): ParseResult
  /** Count of distinct paths actually parsed/skipped (cache size) — for tests/telemetry. */
  readonly size: number
}

type CacheEntry = { source: string; ext: SourceExt; result: ParseResult }

// Sigilix (PR #392): one shared encoder — `new TextEncoder()` per call is pure
// churn. TextEncoder is stateless, so a module-level instance is safe to reuse
// across reviews/isolates.
const encoder = new TextEncoder()

export function createAstCache(): AstCache {
  const cache = new Map<string, CacheEntry>()
  return {
    get(path: string, source: string, ext: SourceExt): ParseResult {
      const hit = cache.get(path)
      if (hit !== undefined) {
        // CodeRabbit (PR #392): keying by path assumes one review = one source
        // snapshot per path. If a caller ever requests the same path with a
        // different source/ext, serving the cached AST would be stale — fail safe
        // (`ok:false` → consumers fail open / skip) rather than silently wrong.
        // In practice consumers pass the same astFilesByPath string reference, so
        // `hit.source !== source` short-circuits on identity (near-free).
        if (hit.ext !== ext || hit.source !== source) {
          return { ok: false, reason: `${AST_CACHE_CONFLICT_PREFIX}${path}` }
        }
        return hit.result
      }
      // Size guard against the BYTE length (not UTF-16 code-unit length), so a
      // non-ASCII source can't sneak past the ceiling. Sigilix (PR #392): UTF-8
      // is at most 3 bytes per UTF-16 code unit, so if `length * 3 <= ceiling`
      // the file CANNOT exceed it — parse directly and skip the full-string
      // `encode()` allocation (the common small-file case). Only encode in the
      // slow branch, where we genuinely need the exact byte count.
      let result: ParseResult
      if (source.length * 3 <= LARGE_FILE_BYTES) {
        result = parseSource(source, ext)
      } else {
        const bytes = encoder.encode(source).length
        result =
          bytes > LARGE_FILE_BYTES
            ? { ok: false, reason: `${LARGE_FILE_SKIP_PREFIX}${bytes}` }
            : parseSource(source, ext)
      }
      cache.set(path, { source, ext, result })
      return result
    },
    get size(): number {
      return cache.size
    },
  }
}
