// ARC-186: dependency-vulnerability advisory database — schema +
// loader + validator. Bundled JSON snapshot (the co-located
// `./dep-vulns.json`) shipped at build time. v1 is a partial
// snapshot — see spec v3 §10a for the retention policy and the
// quarterly-refresh model. Build-time CI check enforces the 500 KB
// cap (see `scripts/check-advisory-db-size.sh`).
//
// Schema is range-scoped: each advisory has one or more
// `{vulnerable_range, patched_in}` entries so multi-major
// vulnerabilities (e.g. patched in 1.4.2 AND 2.1.3) can be matched
// without the false-negative trap of a global-min `patched >= X`
// rule (Codex BLOCKING #1 on the spec review).

import bundledDb from "./dep-vulns.json"

export type SeverityClass = "low" | "medium" | "high" | "critical"

export interface AdvisoryRangeRecord {
  /** Semver range string, e.g. ">=1.0.0 <1.4.2". */
  vulnerable_range: string
  /** Specific patched version that closes THIS range, e.g. "1.4.2". */
  patched_in: string
}

export interface AdvisoryRecord {
  id: string
  source: "github" | "npm" | "snyk" | "aikido"
  ecosystem: "npm"
  package_name: string
  ranges: AdvisoryRangeRecord[]
  non_vulnerable_versions?: string[]
  severity_class: SeverityClass
  aikido_score?: number
  summary: string
  fix_guidance?: string
}

export interface AdvisoryDbMetadata {
  snapshotDate: string
  sourceHash: string
  advisoryCount: number
  schemaVersion: 1
  note?: string
}

export interface AdvisoryDb {
  metadata: AdvisoryDbMetadata
  advisories: AdvisoryRecord[]
}

const VALID_SEVERITY: ReadonlySet<SeverityClass> = new Set(["low", "medium", "high", "critical"])
const VALID_SOURCES: ReadonlySet<AdvisoryRecord["source"]> = new Set([
  "github", "npm", "snyk", "aikido",
])

function isAdvisoryRangeRecord(v: unknown): v is AdvisoryRangeRecord {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.vulnerable_range === "string" && o.vulnerable_range.length > 0
    && typeof o.patched_in === "string" && o.patched_in.length > 0
}

function isAdvisoryRecord(v: unknown): v is AdvisoryRecord {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== "string" || o.id.length === 0) return false
  if (typeof o.source !== "string" || !VALID_SOURCES.has(o.source as AdvisoryRecord["source"])) return false
  if (o.ecosystem !== "npm") return false
  if (typeof o.package_name !== "string" || o.package_name.length === 0) return false
  if (!Array.isArray(o.ranges) || o.ranges.length === 0) return false
  for (const r of o.ranges) if (!isAdvisoryRangeRecord(r)) return false
  if (typeof o.severity_class !== "string" || !VALID_SEVERITY.has(o.severity_class as SeverityClass)) return false
  if (typeof o.summary !== "string" || o.summary.length === 0) return false
  return true
}

function validateMetadata(v: unknown): AdvisoryDbMetadata | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.snapshotDate !== "string") return null
  if (typeof o.sourceHash !== "string") return null
  if (typeof o.advisoryCount !== "number") return null
  if (o.schemaVersion !== 1) return null
  const out: AdvisoryDbMetadata = {
    snapshotDate: o.snapshotDate,
    sourceHash: o.sourceHash,
    advisoryCount: o.advisoryCount,
    schemaVersion: 1,
  }
  if (typeof o.note === "string") out.note = o.note
  return out
}

/**
 * Validate + load the bundled advisory DB. Throws on a malformed
 * record so the build fails loudly (rather than silently shipping a
 * broken DB to production). Validate-once-at-startup pattern — the
 * Worker's queue handler imports the result, no per-request cost.
 */
export function loadAdvisoryDb(): AdvisoryDb {
  const raw = bundledDb as unknown
  if (!raw || typeof raw !== "object") {
    throw new Error("dep-vulns: bundled DB is not an object")
  }
  const obj = raw as Record<string, unknown>
  const metadata = validateMetadata(obj.metadata)
  if (!metadata) throw new Error("dep-vulns: bundled DB metadata is malformed")
  if (!Array.isArray(obj.advisories)) {
    throw new Error("dep-vulns: bundled DB advisories field must be an array")
  }
  for (const a of obj.advisories) {
    if (!isAdvisoryRecord(a)) {
      throw new Error(`dep-vulns: malformed advisory record: ${JSON.stringify(a).slice(0, 200)}`)
    }
  }
  if (metadata.advisoryCount !== obj.advisories.length) {
    throw new Error(
      `dep-vulns: metadata.advisoryCount (${metadata.advisoryCount}) doesn't match advisories.length (${obj.advisories.length})`,
    )
  }
  return {
    metadata,
    advisories: obj.advisories as AdvisoryRecord[],
  }
}
