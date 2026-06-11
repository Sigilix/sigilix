// ARC-176: shared glob → regex compiler used by both `sigilix-config`'s
// `pathFilters` and `deterministic-checks`' per-rule `paths`. Extracted
// from `deterministic-checks.ts` after sigilix-bot caught the
// segment-boundary bug on PR #52 — the fixed version lives here so
// future call sites get the same correct semantics for free.
//
// Globstar semantics (using `gs` to avoid the JSDoc closing token):
//   - "gs/" mid-pattern emits `(?:.*/)?` — match zero or more complete
//     path segments. So src/<gs>/foo.ts matches src/foo.ts AND
//     src/sub/foo.ts but NOT src/barfoo.ts (segment boundary required).
//   - "/gs" at end of pattern emits `(?:/.*)?` — match zero or more
//     trailing segments. So dist/<gs> matches dist itself AND
//     dist/anything/below.
//   - bare gs (no adjacent slash) → `.*` for back-compat with rare
//     middle-of-segment usage.
//
// Bare star matches anything except slash (single segment); question
// mark is one non-slash character. Other regex metacharacters are
// escaped.

/**
 * Translate a single glob pattern into an anchored RegExp.
 */
export function compileGlob(pattern: string): RegExp {
  let regex = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    // gs followed by slash (mid-pattern): match zero or more segments
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      regex += "(?:.*/)?"
      i += 3
      continue
    }
    // slash followed by gs at end of pattern: match zero or more
    // trailing segments (and the leading slash is optional so
    // `dist/gs` matches `dist`)
    if (ch === "/" && pattern[i + 1] === "*" && pattern[i + 2] === "*" && i + 3 === pattern.length) {
      regex += "(?:/.*)?"
      i += 3
      continue
    }
    // bare gs — fall through; rare usage, treat as `.*`
    if (ch === "*" && pattern[i + 1] === "*") {
      regex += ".*"
      i += 2
      continue
    }
    if (ch === "*") {
      regex += "[^/]*"
      i++
      continue
    }
    if (ch === "?") {
      regex += "[^/]"
      i++
      continue
    }
    if (ch !== undefined) {
      regex += ch.replace(/[\\^$.|*+?()[\]{}]/g, "\\$&")
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}

/**
 * `true` iff `path` matches at least one of the patterns. Empty
 * pattern array returns `true` so callers can use it as "match
 * everything when no filter set." Bad globs (regex compilation
 * failures) are skipped, not thrown — keeps user-config glitches
 * from breaking review.
 */
export function pathMatchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true
  for (const p of patterns) {
    try {
      if (compileGlob(p).test(path)) return true
    } catch {
      // Bad glob → skip. We don't surface this; ARC-176 callers can
      // inspect `compileFailures` from a separate compile-once helper
      // if they care about reporting mistakes.
    }
  }
  return false
}

/**
 * sigilix.json `pathFilters` semantics differ from
 * `deterministic-checks` per-rule `paths`:
 *   - sigilix.json `pathFilters` is a UNIFIED include/exclude list:
 *     plain pattern excludes, `!pattern` re-includes (override). The
 *     orchestrator uses this to drop matching files from the diff
 *     BEFORE specialist fanout.
 *   - deterministic-checks `paths` is a simple "scope this rule to
 *     these paths" — only the include side, no negation.
 *
 * `shouldReview` implements the sigilix.json semantics:
 *   - No filters → review (true).
 *   - All filters non-negated: exclude if any matches.
 *   - Negation prefix `!` re-includes a path otherwise excluded.
 *   - Order matters in the `!` case: a later `!pat` overrides an
 *     earlier matching exclude.
 *
 * Examples:
 *   ["dist/<gs>"]                  → reviews everything except dist/
 *   ["<gs>.lock", "!critical.lock"] → reviews everything except .lock
 *                                     files, but DOES review
 *                                     `critical.lock` specifically
 */
export function shouldReview(path: string, filters: string[]): boolean {
  if (filters.length === 0) return true
  let excluded = false
  for (const raw of filters) {
    if (raw.startsWith("!")) {
      const include = raw.slice(1)
      if (include.length === 0) continue
      try {
        if (compileGlob(include).test(path)) {
          excluded = false
        }
      } catch {
        // bad include glob → skip
      }
    } else {
      try {
        if (compileGlob(raw).test(path)) {
          excluded = true
        }
      } catch {
        // bad exclude glob → skip
      }
    }
  }
  return !excluded
}
