// ARC-186: tree-shaken semver surface for the dependency-vulnerability
// scanner. Re-exports only the functions the matcher actually uses so
// esbuild can drop the rest of the `semver` package from the Worker
// bundle. Cloudflare Workers runtime safe — `semver` itself uses no
// Node-only APIs (verified by reviewing the package's source).
//
// Pin: `semver@7.6.3` — exact pin in package.json (no caret/tilde).
// Matcher upgrades are explicit code changes, never silent npm-audit
// bumps, since vuln-matching correctness is too sensitive for drift.

import semverSatisfies from "semver/functions/satisfies"
import semverGte from "semver/functions/gte"
import semverValid from "semver/functions/valid"
import semverCoerce from "semver/functions/coerce"

/**
 * Returns true when `version` satisfies the semver `range`.
 *
 * `includePrerelease: false` by default — most vuln advisories
 * specify stable versions, and matching prereleases produces noise.
 */
export function satisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range, { includePrerelease: false })
}

/** Returns true when `version` is greater than or equal to `other`. */
export function gte(version: string, other: string): boolean {
  return semverGte(version, other)
}

/**
 * Returns the cleaned semver version string when `version` is a valid
 * semver, or null otherwise. Unlike raw `semver.valid`, this also
 * coerces v-prefix and other near-misses (e.g. `v1.2.3` → `1.2.3`,
 * `1.2` → `1.2.0`) when possible. Returns null for inputs that can't
 * be coerced (empty string, `garbage`, etc.).
 */
export function normalizeVersion(version: string): string | null {
  const trimmed = version.trim()
  if (trimmed.length === 0) return null
  const direct = semverValid(trimmed)
  if (direct !== null) return direct
  const coerced = semverCoerce(trimmed)
  return coerced ? coerced.version : null
}
