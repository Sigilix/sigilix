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

export function createAstCache(): AstCache {
  const cache = new Map<string, ParseResult>()
  return {
    get(path: string, source: string, ext: SourceExt): ParseResult {
      const hit = cache.get(path)
      if (hit !== undefined) return hit
      // Byte length (not UTF-16 code-unit length): matches the runner's guard so
      // non-ASCII sources can't sneak past the ceiling.
      const bytes = new TextEncoder().encode(source).length
      const result: ParseResult =
        bytes > LARGE_FILE_BYTES
          ? { ok: false, reason: `${LARGE_FILE_SKIP_PREFIX}${bytes}` }
          : parseSource(source, ext)
      cache.set(path, result)
      return result
    },
    get size(): number {
      return cache.size
    },
  }
}
