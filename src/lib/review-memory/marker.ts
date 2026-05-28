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
  ReviewMemoryClaimMarkerData,
  ReviewMemoryClaimType,
  ReviewMemorySeverityLabel,
  SigilixCommentMarker,
} from "./types"
import {
  ALL_REVIEW_MEMORY_CATEGORIES,
  ALL_REVIEW_MEMORY_CLAIM_TYPES,
  ALL_REVIEW_MEMORY_SEVERITIES,
} from "./types"
import type { SpecialistRole } from "../ensemble-router"

const FID_HEX_WIDTH = 16
const PATH_HEX_WIDTH = 12
const RULE_ID_NULL_SENTINEL = "none"
/** SIG-276: at most 3 claims ride a marker (matches the extractor cap). */
const MAX_MARKER_CLAIMS = 3

const CATEGORY_SET: ReadonlySet<ReviewMemoryCategory> = new Set(
  ALL_REVIEW_MEMORY_CATEGORIES,
)
const SEVERITY_SET: ReadonlySet<ReviewMemorySeverityLabel> = new Set(
  ALL_REVIEW_MEMORY_SEVERITIES,
)
const CLAIM_TYPE_SET: ReadonlySet<ReviewMemoryClaimType> = new Set(
  ALL_REVIEW_MEMORY_CLAIM_TYPES,
)
/** Strict decimal-only guard for the serialized confPct / version fields
 *  — keeps `Number()` from accepting hex (`0x10`) or empty inputs on a
 *  hand-corrupted marker, matching the serializer's decimal output. */
const DECIMAL_RE = /^\d+$/

function isClaimType(v: string): v is ReviewMemoryClaimType {
  return (CLAIM_TYPE_SET as ReadonlySet<string>).has(v)
}

/**
 * SIG-276: serialize up to {@link MAX_MARKER_CLAIMS} claims into the
 * marker's `:claims:` payload. Each claim is `type~confPct~version`,
 * joined by `,`. `confPct` is the confidence as an integer percent
 * (0-100) so the payload stays regex-bounded and float-free. Unknown
 * claim types and out-of-range fields are dropped defensively even
 * though the extractor already validated — the marker is the durable
 * record and must never carry a value the parser would reject.
 */
function serializeClaims(
  claims: ReadonlyArray<ReviewMemoryClaimMarkerData>,
): string {
  return claims
    .filter(
      (c) =>
        CLAIM_TYPE_SET.has(c.type) &&
        c.confidence >= 0 &&
        c.confidence <= 1 &&
        Number.isInteger(c.extractorVersion) &&
        c.extractorVersion >= 0,
    )
    .slice(0, MAX_MARKER_CLAIMS)
    .map(
      (c) =>
        `${c.type}~${Math.round(c.confidence * 100)}~${c.extractorVersion}`,
    )
    .join(",")
}

/**
 * SIG-276: parse the marker `:claims:` payload back into bounded claim
 * data. Drops any entry with the wrong arity, an unknown type, or an
 * out-of-range numeric field (forward-compat with future enum values,
 * mirroring the `loc` precedent). Returns `undefined` when nothing
 * survives so the caller can omit the `claims` key entirely.
 */
function parseClaimsSegment(
  raw: string | undefined,
): ReviewMemoryClaimMarkerData[] | undefined {
  if (!raw) return undefined
  const out: ReviewMemoryClaimMarkerData[] = []
  for (const part of raw.split(",")) {
    const seg = part.split("~")
    if (seg.length !== 3) continue
    const [type, pctRaw, verRaw] = seg
    if (!type || !isClaimType(type)) continue
    if (!pctRaw || !DECIMAL_RE.test(pctRaw)) continue
    if (!verRaw || !DECIMAL_RE.test(verRaw)) continue
    const pct = Number(pctRaw)
    const ver = Number(verRaw)
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) continue
    if (!Number.isInteger(ver) || ver < 0) continue
    out.push({
      type,
      confidence: pct / 100,
      extractorVersion: ver,
    })
    if (out.length >= MAX_MARKER_CLAIMS) break
  }
  return out.length > 0 ? out : undefined
}

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
 *
 * SIG-170: `loc` is an optional tag (`inline` | `unanchored`). When
 * omitted the marker keeps the pre-SIG-170 shape (`fid:cat:sev:path`)
 * so legacy parsers continue to recognize it without a flag flip.
 * When provided the marker appends `:loc:<value>` after `path`.
 *
 * SIG-276: `claims` is an optional list of write-time finding
 * classifications. When non-empty it appends a `:claims:<payload>`
 * segment AFTER `loc`; the segment is omitted entirely when no claim
 * survives serialization, so legacy/claimless markers are byte-identical
 * to before.
 */
export async function buildSigilixMarker(args: {
  ruleId: string | null
  path: string
  line: number
  headline: string
  category: ReviewMemoryCategory
  severity: ReviewMemorySeverityLabel
  loc?: "inline" | "unanchored"
  claims?: ReadonlyArray<ReviewMemoryClaimMarkerData>
}): Promise<string> {
  const fid = await computeFid({
    ruleId: args.ruleId,
    path: args.path,
    line: args.line,
    headline: args.headline,
  })
  const fullPathHash = await computePathSha256(args.path)
  const pathSha12 = truncateHashHex(fullPathHash, PATH_HEX_WIDTH)
  let body = `<!-- sigilix:fid:${fid}:cat:${args.category}:sev:${args.severity}:path:${pathSha12}`
  if (args.loc !== undefined) body += `:loc:${args.loc}`
  if (args.claims && args.claims.length > 0) {
    const serialized = serializeClaims(args.claims)
    if (serialized.length > 0) body += `:claims:${serialized}`
  }
  return `${body} -->`
}

// SIG-170: marker is grammar-extended with an optional `:loc:<value>`
// trailer. The `loc` segment is captured non-greedily and made
// optional so legacy 4-segment markers (`fid:cat:sev:path`) still
// match — preserving the dismissal-pipeline contract from PR #142 +
// SIG-173.
// SIG-276: a further optional `:claims:<payload>` trailer follows `loc`.
// The payload char-class covers the serialized form
// (`type~confPct~ver,...`): lowercase, digits, `~`, `,`, `-`. Both
// optional groups stay non-capturing-prefixed so legacy 4- and
// 5-segment markers continue to match unchanged.
const MARKER_REGEX =
  /<!-- sigilix:fid:([0-9a-f]{16}):cat:([a-z]+):sev:([a-z]+):path:([0-9a-f]{12})(?::loc:([a-z]+))?(?::claims:([a-z0-9~,\-]+))? -->/g

const KNOWN_LOC_VALUES: ReadonlySet<string> = new Set(["inline", "unanchored"])

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
  const [, fid, cat, sev, pathSha12, locRaw, claimsRaw] = last
  if (!fid || !cat || !sev || !pathSha12) return null
  if (!CATEGORY_SET.has(cat as ReviewMemoryCategory)) return null
  if (!SEVERITY_SET.has(sev as ReviewMemorySeverityLabel)) return null
  // SIG-170: only surface `loc` when it matches a known value. Unknown
  // values are silently dropped (forward-compat with future location
  // classes); the marker is still considered well-formed because the
  // dismissal pipeline only branches on `fid`/`cat`/`sev`.
  const loc = locRaw && KNOWN_LOC_VALUES.has(locRaw)
    ? (locRaw as "inline" | "unanchored")
    : undefined
  // SIG-276: parse the optional claims payload. Malformed/unknown
  // entries are dropped; an all-dropped payload yields `undefined` so
  // the `claims` key is omitted entirely (keeps `toEqual` shape stable
  // for claimless markers).
  const claims = parseClaimsSegment(claimsRaw)
  return {
    fid,
    cat: cat as ReviewMemoryCategory,
    sev: sev as ReviewMemorySeverityLabel,
    pathSha12,
    ...(loc ? { loc } : {}),
    ...(claims ? { claims } : {}),
  }
}

// ─── SIG-170: unanchored-finding fingerprint helpers ───────────────

/**
 * Normalise a finding body for fingerprint stability across prompt-
 * template tweaks. Lowercase + collapse runs of whitespace to a single
 * space + strip trailing punctuation. Goal (per research §Q2 + §Recommendation
 * #2): wording shifts that don't change the underlying claim should NOT
 * rotate the fingerprint and orphan the in-place comment.
 *
 * Pure — exported for tests.
 */
export function normaliseBodyForFingerprint(body: string): string {
  return body
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/u, "")
}

/**
 * SIG-170: stable 16-hex content fingerprint for unanchored / body-
 * fallback findings. Inputs (per research §Recommendation #2):
 *
 *   ruleId | category | path | normalisedBody
 *
 * - `ruleId` (the existing `evidenceId` on `PrReviewFinding` when
 *   present) — the same Semgrep / CodeQL precedent the inline marker
 *   uses; nulls canonicalise to the `"none"` sentinel.
 * - `category` — narrows collisions when ruleId is absent.
 * - `path` — repo-relative path (the only positional anchor the
 *   "unanchored" case has).
 * - `normalisedBody` — `normaliseBodyForFingerprint(body)`; survives
 *   case / whitespace / trailing-punctuation drift from prompt tweaks.
 *
 * DELIBERATELY EXCLUDED:
 *   - raw `line` — defeats the whole point of unanchored (the line
 *     moved or disappeared; including it rotates the fingerprint on
 *     every push that touches the file).
 *   - raw `bodySnippet(0, 80)` — rotates every prompt-template tweak.
 *
 * 16 hex chars (64 bits) matches reviewdog + CodeQL + the existing
 * inline-marker `fid` width.
 */
export async function computeUnanchoredFingerprint(args: {
  ruleId: string | null | undefined
  category: ReviewMemoryCategory
  path: string
  body: string
}): Promise<string> {
  const ruleId = args.ruleId ?? RULE_ID_NULL_SENTINEL
  const path = args.path.trim()
  const normalisedBody = normaliseBodyForFingerprint(args.body)
  const canonical = `${ruleId}|${args.category}|${path}|${normalisedBody}`
  const full = await sha256Hex(canonical)
  return truncateHashHex(full, FID_HEX_WIDTH)
}

/**
 * SIG-170: build a marker for an unanchored / body-fallback comment.
 * Differs from `buildSigilixMarker` in two ways:
 *
 *   1. `fid` is computed via `computeUnanchoredFingerprint` (content-
 *      based) rather than line-anchored — survives line drift.
 *   2. The `:loc:unanchored` tag is always emitted, so the upsert
 *      pipeline can distinguish unanchored comments from inline ones
 *      during marker-scan recovery.
 *
 * The dismissal pipeline (PR #142 + SIG-173) finds these markers via
 * the same `extractSigilixMarker` parser — the only contract change is
 * the optional `loc` field on the returned `SigilixCommentMarker`.
 */
export async function buildSigilixUnanchoredMarker(args: {
  ruleId: string | null | undefined
  category: ReviewMemoryCategory
  severity: ReviewMemorySeverityLabel
  path: string
  body: string
}): Promise<{ marker: string; fingerprint: string }> {
  const fingerprint = await computeUnanchoredFingerprint({
    ruleId: args.ruleId,
    category: args.category,
    path: args.path,
    body: args.body,
  })
  const fullPathHash = await computePathSha256(args.path)
  const pathSha12 = truncateHashHex(fullPathHash, PATH_HEX_WIDTH)
  const marker = `<!-- sigilix:fid:${fingerprint}:cat:${args.category}:sev:${args.severity}:path:${pathSha12}:loc:unanchored -->`
  return { marker, fingerprint }
}

/**
 * SIG-170: scan a comment body for a sigilix marker and return the
 * `fid` field. Thin convenience over `extractSigilixMarker` so the
 * upsert's marker-scan recovery doesn't need to import the parser
 * directly. Returns null when no well-formed marker is present.
 *
 * Pure — exported for tests.
 */
export function findFingerprintInCommentBody(body: string): string | null {
  const parsed = extractSigilixMarker(body)
  return parsed ? parsed.fid : null
}
