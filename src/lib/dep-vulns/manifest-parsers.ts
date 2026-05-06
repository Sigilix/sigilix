// ARC-186: npm manifest parsers — `package.json` + `package-lock.json`.
//
// Top-level only in v1: transitive dependencies are not walked. Hoist
// filter (Codex MAJOR #2): npm v7+ flattens transitive deps into
// `node_modules/<name>` entries, so the lockfile alone can't tell
// "root dep" from "deep transitive". The parser intersects lockfile
// entries with the root `package.json`'s declared keys (deps + dev +
// peer) to produce the authoritative "what root deps resolved to
// what version" map.
//
// Both formats supported:
//   - npm v6: `dependencies.<name>.version` (top-level only)
//   - npm v7+: `packages["node_modules/<name>"].version`
//
// Scoped packages (`node_modules/@scope/pkg`) normalize to `@scope/pkg`.

export interface PackageJsonShape {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/**
 * Parse a `package.json` body. Returns null on invalid JSON or
 * non-object top-level.
 */
export function parsePackageJson(raw: string): PackageJsonShape | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const out: PackageJsonShape = {}
  if (typeof obj.name === "string") out.name = obj.name
  if (typeof obj.version === "string") out.version = obj.version
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const v = obj[key]
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const recordOut: Record<string, string> = {}
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string") recordOut[k] = val
      }
      if (Object.keys(recordOut).length > 0) out[key] = recordOut
    }
  }
  return out
}

/**
 * Compute the union of root dependency names (deps + dev + peer)
 * from a parsed package.json. Used by `parsePackageLock` as the
 * hoist filter.
 */
export function rootDepNames(pkg: PackageJsonShape | null): Set<string> {
  const out = new Set<string>()
  if (!pkg) return out
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const r = pkg[key]
    if (!r) continue
    for (const name of Object.keys(r)) out.add(name)
  }
  return out
}

const NODE_MODULES_PREFIX = "node_modules/"

function normalizeLockKey(key: string): string | null {
  if (!key.startsWith(NODE_MODULES_PREFIX)) return null
  const tail = key.slice(NODE_MODULES_PREFIX.length)
  // Reject deep paths (`node_modules/foo/node_modules/bar`) — those
  // are nested transitives in v6 lockfiles or nested-package fields
  // in v7+ that shouldn't apply to root deps.
  if (tail.includes("/node_modules/")) return null
  return tail
}

/**
 * Parse a `package-lock.json` body to a `Map<name, version>` of the
 * resolved versions for ROOT dependencies only. `rootDeps` is the
 * authoritative set of root dep names (from `rootDepNames(pkg)`); any
 * lockfile entry not in this set is treated as a hoisted transitive
 * and filtered out. Returns an empty map on invalid JSON or unknown
 * lockfile shape.
 */
export function parsePackageLock(raw: string, rootDeps: Set<string>): Map<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Map()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map()
  const obj = parsed as Record<string, unknown>

  // Dispatch on lockfileVersion. Default to v6 if absent (older lockfiles).
  const version = typeof obj.lockfileVersion === "number" ? obj.lockfileVersion : 1
  const out = new Map<string, string>()

  if (version >= 2) {
    // npm v7+: packages["node_modules/<name>"]
    const packages = obj.packages
    if (!packages || typeof packages !== "object" || Array.isArray(packages)) return out
    for (const [key, val] of Object.entries(packages)) {
      if (key === "" || key === ".") continue // root package self-entry
      const name = normalizeLockKey(key)
      if (name === null) continue
      if (!rootDeps.has(name)) continue
      if (!val || typeof val !== "object") continue
      const v = (val as Record<string, unknown>).version
      if (typeof v === "string" && v.length > 0) {
        out.set(name, v)
      }
    }
    return out
  }

  // npm v6 and earlier: dependencies.<name>.version (top-level only;
  // we don't recurse into nested .dependencies which are transitive).
  const deps = obj.dependencies
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) return out
  for (const [name, val] of Object.entries(deps)) {
    if (!rootDeps.has(name)) continue
    if (!val || typeof val !== "object") continue
    const v = (val as Record<string, unknown>).version
    if (typeof v === "string" && v.length > 0) {
      out.set(name, v)
    }
  }
  return out
}
