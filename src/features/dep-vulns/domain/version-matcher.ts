// ARC-186: range-aware version matcher.
//
// Per spec v3 §6: a finding emits ONLY when the version falls inside
// one of the advisory's `ranges[].vulnerable_range` AND is NOT yet
// patched-in for that specific range. A naive `version >= patched_in`
// global cutoff would mis-suppress multi-major vulnerabilities (a
// 2.0.5 vuln gets falsely suppressed because `2.0.5 >= 1.4.2` even
// though the fix for the 2.x line is `2.1.3`). The matcher walks
// each range entry and emits only when ALL of:
//   - version is inside the vulnerable_range
//   - version is < patched_in for that SAME range
//   - version is not in non_vulnerable_versions
//   - version is a valid semver after normalization

import type { AdvisoryRecord } from "./advisory-db"
import { satisfies, normalizeVersion } from "./semver-matcher"

export interface MatchResult {
  match: "range-vulnerable" | "patched" | "out-of-range" | "explicit-safe" | "invalid-version"
  /** The matched vulnerable range (when match is "range-vulnerable"). */
  matchedRange?: string
  /** The patched_in value for the matched range (when match is "range-vulnerable"). */
  patchedIn?: string
}

/**
 * Match `version` against an advisory. Returns a tagged result. The
 * caller emits a finding only when `match === "range-vulnerable"`.
 */
export function matchVersion(version: string, advisory: AdvisoryRecord): MatchResult {
  const normalized = normalizeVersion(version)
  if (normalized === null) return { match: "invalid-version" }

  // Explicit safe-list takes precedence — if the operator has
  // documented a specific version as known-safe, suppress regardless
  // of range matches.
  if (advisory.non_vulnerable_versions?.includes(normalized)) {
    return { match: "explicit-safe" }
  }

  // Walk each range. A version is `range-vulnerable` ONLY if it's
  // inside the vulnerable_range (which by spec is `<patched_in` —
  // exclusive upper bound). A version is `patched-in-range` if it's
  // OUTSIDE the range AND `>= patched_in` for that same range —
  // semantically "this used to be vulnerable but the user is at/above
  // the fix line." Otherwise the range doesn't apply, and we look at
  // the next one. After all ranges, if no range applied, the version
  // is `out-of-range` (e.g. ancient version below the lowest range,
  // or way past all majors).
  // Walk each range. A version is `range-vulnerable` ONLY if it's
  // inside the vulnerable_range (which by spec is `<patched_in` —
  // exclusive upper bound). A version is `patched` if it's exactly
  // at `patched_in` for any range (the user is at the fix line).
  // Otherwise the range doesn't apply, and we look at the next one.
  // After all ranges, if no range matched, the version is
  // `out-of-range`.
  let foundUnpatched: { range: string; patchedIn: string } | null = null
  let foundPatchedExact = false

  for (const range of advisory.ranges) {
    if (satisfies(normalized, range.vulnerable_range)) {
      foundUnpatched = { range: range.vulnerable_range, patchedIn: range.patched_in }
      break
    }
    if (normalized === range.patched_in) {
      foundPatchedExact = true
    }
  }

  if (foundUnpatched) {
    return {
      match: "range-vulnerable",
      matchedRange: foundUnpatched.range,
      patchedIn: foundUnpatched.patchedIn,
    }
  }
  if (foundPatchedExact) {
    return { match: "patched" }
  }
  return { match: "out-of-range" }
}
