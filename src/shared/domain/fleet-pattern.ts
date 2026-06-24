// SIG-507 — fleet-intelligence pattern extraction: THE privacy boundary.
//
// Converts one review finding into an ANONYMIZED, categorical pattern signature that may be
// aggregated across tenants. Hard invariant: the output is built ONLY from a fixed vocabulary —
// the finding category, a canonical sub-type (matched from a closed list), a severity bucket, and
// boolean proof flags. It NEVER contains the finding's headline, cited code, file path, identifiers,
// or literals. Raw code never crosses the tenant boundary; only this signature does.
//
// Pure leaf: imports only the finding-category vocabulary. The cross-tenant aggregation (k-anonymity
// gate K=5, HyperLogLog tenant-count, surfacing) is built on top of this primitive — but the
// guarantee that nothing identifiable leaves the tenant lives HERE, where it is unit-tested.

import { FINDING_CATEGORIES, type FindingCategory } from "./finding-category"

// Canonical sub-types — a CLOSED vocabulary. A finding contributes a sub-type only if its headline
// matches one of these patterns; otherwise the signature is category-only. This is what guarantees
// no identifier/literal from the source headline can ever appear in the emitted signature.
const SUBTYPE_RULES: ReadonlyArray<{ subType: string; match: RegExp }> = [
  { subType: "sql-injection", match: /\bsql\s*injection|\bsqli\b/i },
  { subType: "command-injection", match: /\b(command|shell|os)\s*injection|\brce\b/i },
  { subType: "xss", match: /\bxss\b|cross[- ]site\s*script/i },
  { subType: "ssrf", match: /\bssrf\b|server[- ]side\s*request/i },
  { subType: "path-traversal", match: /\bpath\s*traversal|directory\s*traversal/i },
  {
    subType: "missing-authz",
    match: /\b(missing|no|without|broken|bypass\w*)\s+(authoriz\w*|authentic\w*|access\s*control|permission)/i,
  },
  // bidirectional: "api key written to log" AND "logs the api key" (secret-in-log is a known gap)
  {
    subType: "secret-exposure",
    match:
      /\b(secret|api\s*key|credential|password|token)\b[^.]{0,40}\b(log\w*|expos\w*|leak\w*|hardcod\w*|plaintext|print\w*)|\b(log\w*|expos\w*|leak\w*|print\w*|writ\w*)\b[^.]{0,40}\b(secret|api\s*key|credential|password|token)\b/i,
  },
  { subType: "weak-crypto", match: /\bmd5\b|\bsha1\b|\becb\b|weak\s*(crypto|cipher|hash)|insecure\s*random/i },
  {
    subType: "missing-await",
    match: /\bmissing\s+await\b|\bunawaited\b|\bnot\s+awaited\b|\b(forgot\w*|missing|absent)\b[^.]{0,25}\bawait\b/i,
  },
  {
    subType: "race-condition",
    match: /\brace\s*condition|\btoctou\b|time[- ]of[- ]check|concurrenc\w*\s*(bug|issue|hazard)/i,
  },
  { subType: "off-by-one", match: /\boff[- ]by[- ]one\b|\bfencepost\b|boundary\s*(error|condition)/i },
  {
    subType: "null-deref",
    match:
      /\bnull\s*(pointer|deref\w*|reference)|cannot\s+read\s+propert|\b(missing|no|absent)\s+null\s*(check|guard)|null\s*(check|guard)\s+(missing|absent)/i,
  },
  {
    subType: "unvalidated-input",
    match: /\b(missing|no|lack\w*|without)\s+(input\s+)?validation|\bunvalidated\b|\bunsanitiz\w*/i,
  },
  {
    subType: "resource-leak",
    match: /\b(resource|memory|file\s*handle|connection)\s*leak|\bunclosed\b|never\s+(closed|released)/i,
  },
  { subType: "error-swallowed", match: /\b(swallow\w*|silenc\w*|ignor\w*|empty)\s*(error|exception|catch)/i },
  { subType: "integer-overflow", match: /\b(integer|numeric|int)\s*overflow\b/i },
  { subType: "missing-tests", match: /\b(missing|no|lack\w*|without)\s+test\w*|\buntested\b|test\s*coverage/i },
]

export interface FleetFindingInput {
  category: string
  /** Free-text headline — read ONLY to derive a canonical sub-type; never emitted. */
  headline?: string
  /** Review severity score (1–5). */
  score?: number
  /** Proven by sealed execution (the REPRODUCED tier). */
  reproduced?: boolean
  /** The fix for this finding was verified. */
  verified?: boolean
}

export interface FleetPattern {
  category: FindingCategory
  /** Canonical sub-type from the closed vocabulary, or null (category-only). Never free text. */
  subType: string | null
  /** Severity bucket 1–5 (clamped). */
  severity: number
  reproduced: boolean
  verified: boolean
  /** The cross-tenant aggregation key — built ONLY from the controlled vocabulary above. */
  signature: string
}

/** Map a headline to a canonical sub-type, or null. Reads free text but emits only fixed vocab. */
export function canonicalSubType(headline: string | undefined): string | null {
  if (!headline) return null
  for (const r of SUBTYPE_RULES) if (r.match.test(headline)) return r.subType
  return null
}

const clampSeverity = (n: number | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 1

/**
 * Extract an anonymized fleet pattern from a finding, or null if the category isn't recognized.
 * PRIVACY INVARIANT: the result is built ONLY from the finding category, a canonical sub-type (closed
 * vocabulary), a severity bucket, and boolean flags — never the headline, cited code, or paths.
 */
export function extractFleetPattern(f: FleetFindingInput): FleetPattern | null {
  const category = f.category as FindingCategory
  if (!FINDING_CATEGORIES.has(category)) return null
  const subType = canonicalSubType(f.headline)
  return {
    category,
    subType,
    severity: clampSeverity(f.score),
    reproduced: f.reproduced === true,
    verified: f.verified === true,
    signature: `${category}:${subType ?? "other"}`,
  }
}
