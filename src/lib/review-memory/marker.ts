// ARC-189 — Sigilix comment marker (Task 2).
//
// Every Sigilix-authored inline review comment carries a hidden HTML
// marker line at the end of the body:
//
//   <!-- sigilix:fid:<sha16>:cat:<category>:sev:<severity>:path:<sha12> -->
//
// The capture pipeline (Task 9) reads the marker on the parent
// comment when a reviewer replies with a dismissal-shaped message.
//
// Width choices (spec §4.3):
//   - `fid` is sha16 (16 hex chars / 64 bits). Birthday-bound
//     collision becomes material at ~4B markers across all repos
//     — non-issue at any realistic scale. fid is the
//     dismissal-correlation primary key.
//   - `path` is sha12 (12 hex chars / 48 bits). Collision risk ~1 in
//     16M for a 100-file repo, ~1 in 7000 for a 1M-file mono-repo.
//     Acceptable because KV keys (storage.ts) use the FULL SHA-256
//     for precise dedupe; the 12-hex truncation here is a
//     human-readable hint only.
//
// Null-canonical form (Codex MINOR on plan v2): when `ruleId` is null
// or undefined, the canonical fid input string substitutes the literal
// sentinel `"none"`. A finding with no ruleId AND a finding with
// literal ruleId="none" therefore share the same fid bucket — an
// acceptable collision documented in the spec.

import type {
  ReviewMemoryCategory,
  ReviewMemorySeverityLabel,
  SigilixCommentMarker,
} from "./types"
import { ALL_REVIEW_MEMORY_CATEGORIES, ALL_REVIEW_MEMORY_SEVERITIES } from "./types"
import type { SpecialistRole } from "../ensemble-router"

const FID_HEX_WIDTH = 16
const PATH_HEX_WIDTH = 12
const RULE_ID_NULL_SENTINEL = "none"

const CATEGORY_SET: ReadonlySet<ReviewMemoryCategory> = new Set(
  ALL_REVIEW_MEMORY_CATEGORIES,
)
const SEVERITY_SET: ReadonlySet<ReviewMemorySeverityLabel> = new Set(
  ALL_REVIEW_MEMORY_SEVERITIES,
)

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += b.toString(16).padStart(2, "0")
  }
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", enc)
  return bytesToHex(new Uint8Array(buf))
}

/**
 * Truncate a hex string to exactly `n` characters. The literal-arg
 * type prevents accidental width drift at call sites.
 */
export function truncateHashHex(hex: string, n: 12 | 16): string {
  return hex.slice(0, n)
}

/**
 * Stable 16-hex fingerprint over the canonical
 * `(ruleId|"none", path, line, headline)` tuple.
 */
export async function computeFid(args: {
  ruleId: string | null
  path: string
  line: number
  headline: string
}): Promise<string> {
  const ruleId = args.ruleId ?? RULE_ID_NULL_SENTINEL
  const canonical = `${ruleId}|${args.path}|${args.line}|${args.headline}`
  const full = await sha256Hex(canonical)
  return truncateHashHex(full, FID_HEX_WIDTH)
}

/**
 * Full 64-hex SHA-256 of the repo-relative path. Used by storage.ts
 * for KV key derivation (precise dedupe); truncated to sha12 for
 * marker emission + prompt rendering.
 */
export async function computePathSha256(path: string): Promise<string> {
  return sha256Hex(path)
}

/**
 * Maps the internal `SpecialistRole` to the public
 * `ReviewMemoryCategory` literal. Today's mapping is 1:1 — but the
 * indirection lets future internal renames stay internal without
 * migrating already-emitted comment markers.
 */
export function categoryFromRoleHint(role: SpecialistRole): ReviewMemoryCategory {
  switch (role) {
    case "security":
      return "security"
    case "logic":
      return "logic"
    case "performance":
      return "performance"
    case "tests":
      return "tests"
  }
}

/**
 * Maps `PrReviewFinding.score: number ∈ [1,5]` to a severity tier
 * for the marker. Banding (spec §4.3 emission rules):
 *   - score ≥ 5 → "error"
 *   - score ≥ 3 → "warning"
 *   - score < 3 → "info"
 *
 * NOTE: this banding is for EMISSION only — it labels the marker so
 * the capture pipeline + telemetry can group dismissals by tier.
 * The runtime soften action (Task 10b) operates on the original
 * numeric `score`, not on the banded tier.
 */
export function markerSeverityFromScore(score: number): ReviewMemorySeverityLabel {
  if (score >= 5) return "error"
  if (score >= 3) return "warning"
  return "info"
}

/**
 * Build the canonical marker string. Caller appends to the comment
 * body on its own line at the end (typically after a blank line).
 */
export async function buildSigilixMarker(args: {
  ruleId: string | null
  path: string
  line: number
  headline: string
  category: ReviewMemoryCategory
  severity: ReviewMemorySeverityLabel
}): Promise<string> {
  const fid = await computeFid({
    ruleId: args.ruleId,
    path: args.path,
    line: args.line,
    headline: args.headline,
  })
  const fullPathHash = await computePathSha256(args.path)
  const pathSha12 = truncateHashHex(fullPathHash, PATH_HEX_WIDTH)
  return `<!-- sigilix:fid:${fid}:cat:${args.category}:sev:${args.severity}:path:${pathSha12} -->`
}

const MARKER_REGEX =
  /<!-- sigilix:fid:([0-9a-f]{16}):cat:([a-z]+):sev:([a-z]+):path:([0-9a-f]{12}) -->/g

/**
 * Parse the LAST sigilix marker from a comment body. Returns null on
 * any malformed shape (wrong hex width, unknown cat, unknown sev,
 * missing field, no marker present).
 *
 * Defensive: scans all matches and returns the last (allows future
 * comment-edit flows to append a fresher marker without breaking
 * lookup; v1 only ever emits one marker per comment).
 */
export function extractSigilixMarker(
  commentBody: string,
): SigilixCommentMarker | null {
  if (!commentBody || typeof commentBody !== "string") return null
  // Reset lastIndex on the global regex for each parse.
  MARKER_REGEX.lastIndex = 0
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = MARKER_REGEX.exec(commentBody)) !== null) {
    last = match
  }
  if (!last) return null
  const [, fid, cat, sev, pathSha12] = last
  if (!fid || !cat || !sev || !pathSha12) return null
  if (!CATEGORY_SET.has(cat as ReviewMemoryCategory)) return null
  if (!SEVERITY_SET.has(sev as ReviewMemorySeverityLabel)) return null
  return {
    fid,
    cat: cat as ReviewMemoryCategory,
    sev: sev as ReviewMemorySeverityLabel,
    pathSha12,
  }
}
