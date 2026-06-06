import {
  FINDING_CATEGORIES,
  type FindingCategory,
} from "./triage-pr-review"

const FINDING_BLOCK_MARKER = "<!-- sigilix:pr-review-finding -->"

/**
 * SIG-217/SIG-185: parse the hidden content-fingerprint marker emitted on
 * Sigilix finding comments. Returns the 64-hex SHA-256 or undefined when
 * absent (legacy/comment-fallback bodies).
 */
export function parseFindingFingerprint(body: string): string | undefined {
  const m = /<!-- sigilix:fingerprint:([0-9a-f]{64}) -->/.exec(body)
  return m ? m[1] : undefined
}

/**
 * SIG-147/SIG-185: parse the hidden category marker used by the precision
 * profile. Defaults to "logic" to match the renderer's legacy fallback.
 */
export function parseFindingCategory(body: string): FindingCategory {
  const m = /<!-- sigilix:category:([a-z-]+) -->/.exec(body)
  return m && FINDING_CATEGORIES.has(m[1] as FindingCategory)
    ? (m[1] as FindingCategory)
    : "logic"
}

/** SIG-217: parse the hidden numeric severity marker. */
export function parseFindingSeverity(body: string): number | undefined {
  const m = /<!-- sigilix:severity:(\d+) -->/.exec(body)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isInteger(n) ? n : undefined
}

export interface FindingOutcomeMarker {
  patternHash: string
  category: FindingCategory
}

/**
 * Parse every mappable precision-profile outcome marker in a body. Formal
 * review/comment-fallback bodies can contain multiple finding blocks; inline
 * comments normally contain one. Dedupes by `(fingerprint, category)` so one
 * copied block cannot double-count within the same webhook delivery.
 */
export function parseFindingOutcomeMarkers(body: string): FindingOutcomeMarker[] {
  const chunks = body.includes(FINDING_BLOCK_MARKER)
    ? body.split(FINDING_BLOCK_MARKER).slice(1)
    : [body]
  const seen = new Set<string>()
  const out: FindingOutcomeMarker[] = []
  for (const chunk of chunks) {
    const patternHash = parseFindingFingerprint(chunk)
    if (!patternHash) continue
    const category = parseFindingCategory(chunk)
    const key = `${patternHash}:${category}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ patternHash, category })
  }
  return out
}
