// SIG-70/SIG-326 — normalize raw GitHub review comments into tool findings.
//
// Pure: input is the raw JSON GitHub returns from
// `GET /repos/{o}/{r}/pulls/{n}/comments` (inline review comments); output
// is the `NormalizedFinding[]` the worksheet + summary work against. No IO —
// `github.ts` does the fetching and hands the arrays here.

import type { NormalizedFinding, Tool } from "./types"
import type { FixtureFinding, Severity } from "./fixture-types"

export const SIGILIX_BOT = "sigilix[bot]"
export const CODERABBIT_BOT = "coderabbitai[bot]"
export const DEFAULT_GREPTILE_BOTS = ["greptile-apps[bot]", "greptile-app[bot]", "greptile[bot]"] as const

/** The subset of GitHub's review-comment shape we depend on. */
export interface RawComment {
  id: number
  user: { login: string } | null
  path?: string | null
  line?: number | null
  body: string
  html_url: string
  /** Set when this comment is a reply within a thread — not a fresh finding. */
  in_reply_to_id?: number | null
}

// Sigilix posts many comment kinds (overview, mention-reply); only the ones
// carrying this marker are findings. CodeRabbit has no equivalent marker, so
// every inline review comment it authors is treated as a finding.
const SIGILIX_FINDING_MARKER = /<!--\s*sigilix:pr-review-finding\s*-->/
// Self-reported category lives either in a standalone marker or in the fid
// marker's `cat:` field — mirror the two shapes the collector parser reads.
const SIGILIX_CATEGORY_MARKER = /<!--\s*sigilix:category:([a-z-]+)\s*-->/
const SIGILIX_FID_CATEGORY = /<!--\s*sigilix:fid:[0-9a-f]+:cat:([a-z-]+):/
// SIG-397: the hidden numeric severity marker (same shape pr-finding-markers.ts
// parses engine-side). Score → label mapping mirrors the renderer
// (`finding-format.ts`): 5 → P0, 4 → P1, 3 → P2, 1-2 → P3.
const SIGILIX_SEVERITY_MARKER = /<!--\s*sigilix:severity:(\d+)\s*-->/

const EXCERPT_MAX = 280

/**
 * Reduce a comment body to a single human-scannable line: drop HTML comment
 * markers and any leading badge/image markup, then take the first non-empty
 * line and cap it. Used only for the worksheet display — the reviewer follows
 * the `url` for the full comment.
 */
export function summarizeBody(body: string): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, "") // strip HTML comment markers
    .replace(/<a\b[^>]*>|<\/a>/gi, "") // unwrap anchors
    .replace(/<img\b[^>]*>/gi, "") // drop badge images
    .replace(/\r/g, "")
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // Slice by code points, not UTF-16 units, so a cap landing mid-surrogate
    // (emoji — common in CodeRabbit comments) can't corrupt the excerpt.
    const chars = [...line]
    return chars.length > EXCERPT_MAX ? chars.slice(0, EXCERPT_MAX - 1).join("") + "…" : line
  }
  return "(no text)"
}

/** Full body for keyword matching: HTML comment markers dropped, everything else kept. */
export function matchableBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r/g, "")
    .trim()
}

/** Parse the hidden Sigilix severity score into a P-label; null for other tools / no marker. */
export function sigilixSeverity(body: string): Severity | null {
  const m = SIGILIX_SEVERITY_MARKER.exec(body)
  if (!m) return null
  const score = Number(m[1])
  if (score >= 5) return "P0"
  if (score === 4) return "P1"
  if (score === 3) return "P2"
  return "P3"
}

function sigilixCategory(body: string): string | undefined {
  const marker = SIGILIX_CATEGORY_MARKER.exec(body)
  if (marker) return marker[1]
  const fid = SIGILIX_FID_CATEGORY.exec(body)
  if (fid) return fid[1]
  return undefined
}

function toFinding(tool: Tool, ref: string, comment: RawComment, botCategory: string | undefined): NormalizedFinding {
  const finding: NormalizedFinding = {
    ref,
    tool,
    commentId: comment.id,
    path: comment.path ?? null,
    line: comment.line ?? null,
    excerpt: summarizeBody(comment.body),
    url: comment.html_url,
  }
  // exactOptionalPropertyTypes: only attach botCategory when we actually have one.
  if (botCategory !== undefined) finding.botCategory = botCategory
  return finding
}

/** Sort by comment id so re-collection assigns identical refs (diff-stable). */
function byCommentId(a: RawComment, b: RawComment): number {
  return a.id - b.id
}

/**
 * Turn the raw inline review comments of one PR into per-bot findings.
 * Comments not authored by a bot (human reviewers) are dropped; Sigilix
 * comments without the finding marker (overviews, mention replies) are dropped.
 */
export function normalizeFindings(
  comments: RawComment[],
  opts: { greptileLogins?: readonly string[] } = {},
): {
  sigilix: NormalizedFinding[]
  coderabbit: NormalizedFinding[]
  greptile: NormalizedFinding[]
} {
  // A reply within a thread (in_reply_to_id set) is conversation, not a fresh
  // finding — CodeRabbit in particular posts follow-up replies as inline review
  // comments, which would otherwise inflate its finding count and skew the
  // head-to-head. Keep only top-level review comments.
  const topLevel = comments.filter((c) => c.in_reply_to_id == null)
  const sigilixRaw = topLevel
    .filter((c) => c.user?.login === SIGILIX_BOT && SIGILIX_FINDING_MARKER.test(c.body))
    .sort(byCommentId)
  const coderabbitRaw = topLevel.filter((c) => c.user?.login === CODERABBIT_BOT).sort(byCommentId)
  const greptileLogins = new Set(opts.greptileLogins ?? DEFAULT_GREPTILE_BOTS)
  const greptileRaw = topLevel
    .filter((c) => c.user?.login != null && greptileLogins.has(c.user.login))
    .sort(byCommentId)

  const sigilix = sigilixRaw.map((c, i) => toFinding("sigilix", `s${i + 1}`, c, sigilixCategory(c.body)))
  const coderabbit = coderabbitRaw.map((c, i) => toFinding("coderabbit", `c${i + 1}`, c, undefined))
  const greptile = greptileRaw.map((c, i) => toFinding("greptile", `g${i + 1}`, c, undefined))
  return { sigilix, coderabbit, greptile }
}

/**
 * SIG-397: the fixture variant of `normalizeFindings` — identical filtering,
 * sorting, and ref assignment, but each finding also carries the full
 * matchable body and the parsed severity, which the scorer's equivalence
 * rules need (the capped excerpt is too short for keyword matching).
 */
export function normalizeFixtureFindings(
  comments: RawComment[],
  opts: { greptileLogins?: readonly string[] } = {},
): {
  sigilix: FixtureFinding[]
  coderabbit: FixtureFinding[]
  greptile: FixtureFinding[]
} {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const enrich = (finding: NormalizedFinding): FixtureFinding => {
    const raw = byId.get(finding.commentId)
    const body = raw?.body ?? ""
    return {
      ...finding,
      bodyText: matchableBody(body),
      severity: finding.tool === "sigilix" ? sigilixSeverity(body) : null,
    }
  }
  const base = normalizeFindings(comments, opts)
  return {
    sigilix: base.sigilix.map(enrich),
    coderabbit: base.coderabbit.map(enrich),
    greptile: base.greptile.map(enrich),
  }
}
