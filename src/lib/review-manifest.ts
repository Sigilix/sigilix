// ARC-184 — review provenance manifest.
//
// One KV record per PR, written after every successful submitReview.
// Captures the inputs the model reviewed against (head/base/merge-base
// SHAs, file-list hash, prompt version, model id) and the GitHub
// artifact id needed for stale-marking later (review id or
// fallback issue-comment id).
//
// On `synchronize`/`edited` webhooks, a separate queue handler reads
// this manifest, computes current state, and PATCHes the prior review
// body with a stale-notice block when drift is detected.
//
// Spec: docs/superpowers/specs/2026-05-06-arc-184-review-provenance-stale-markers-design.md
//
// Lifecycle: independent of `pr-last-reviewed:` (incremental-review
// SHA). Different consumers, different invariants — leave that key
// alone.

import type { Env } from "../index"

const KV_KEY_PREFIX = "pr-review-manifest:"
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

export type ReviewTarget =
  | { kind: "review"; reviewId: number }
  | { kind: "issue-comment"; commentId: number }

/**
 * ARC-271: per-finding record persisted in the review manifest so the
 * next push's review can classify each new finding as `new`,
 * `still-open`, or `likely-fixed` against the prior run.
 *
 * `key` is a stable identifier computed from `(lowercased-path,
 * normalized-headline)` — see `computeFindingKey` in
 * `triage-pr-review-ensemble.ts`. Normalization (lowercase + collapse
 * whitespace + strip trailing punctuation) tolerates minor LLM
 * rephrasing across pushes; major rephrasing will produce a new key
 * and surface as `new` (false positive accepted in v1 — better to
 * over-report new than to silently drop signal).
 */
export interface ReviewManifestFinding {
  key: string
  path: string
  headline: string
  score: number
  /** ARC-270 consensus count at the time of the prior review. Carried
   *  forward for telemetry / future "consensus drift" surfaces. */
  consensus: number
}

export interface ReviewManifestV1 {
  v: 1
  prNumber: number
  baseSha: string
  headSha: string
  mergeBaseSha: string | null
  /**
   * SHA-256 hex digest of the sorted changed-file set (with rename
   * pairs), OR the literal sentinel `sha256:overflow:<count>` when the
   * PR has more than 3000 files. Drift detection skips file-list
   * comparison when either side is the overflow sentinel.
   */
  fileListHash: string
  promptVersion: string
  modelId: string
  target: ReviewTarget
  reviewedAt: number
  /**
   * ARC-271: snapshot of the findings posted on this review. Used by
   * the next push's review to compute the new/still-open/likely-fixed
   * delta. Optional — older manifests written before this field was
   * added omit it; readers treat absent as "no prior findings to
   * diff against" (the next review surfaces no delta).
   */
  findings?: ReviewManifestFinding[]
}

export type ReadResult =
  | { kind: "ok"; manifest: ReviewManifestV1 }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "wrong-version" | "shape" | "json-parse" }

// ---------------------------------------------------------------------
// KV serdes
// ---------------------------------------------------------------------

function kvKey(owner: string, repo: string, prNumber: number): string {
  return `${KV_KEY_PREFIX}${owner}/${repo}#${prNumber}`
}

function isReviewTarget(t: unknown): t is ReviewTarget {
  if (!t || typeof t !== "object") return false
  const obj = t as Record<string, unknown>
  if (obj.kind === "review") return typeof obj.reviewId === "number"
  if (obj.kind === "issue-comment") return typeof obj.commentId === "number"
  return false
}

function isReviewManifestFinding(value: unknown): value is ReviewManifestFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.key === "string" && o.key.length > 0 &&
    typeof o.path === "string" && o.path.length > 0 &&
    // CodeRabbit phase-end catch: require non-empty headline. The
    // delta key is `sha256(path | normalized-headline)`, so an
    // empty headline collapses every same-path finding to the same
    // key, breaking still-open/new classification. Also a semantic
    // invariant — every finding should have a descriptive headline.
    typeof o.headline === "string" && o.headline.trim().length > 0 &&
    typeof o.score === "number" &&
    typeof o.consensus === "number"
  )
}

function isReviewManifestV1(value: unknown): value is ReviewManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.v !== 1) return false
  if (typeof o.prNumber !== "number") return false
  if (typeof o.baseSha !== "string" || o.baseSha.length === 0) return false
  if (typeof o.headSha !== "string" || o.headSha.length === 0) return false
  if (!(o.mergeBaseSha === null || typeof o.mergeBaseSha === "string")) return false
  if (typeof o.fileListHash !== "string" || o.fileListHash.length === 0) return false
  if (typeof o.promptVersion !== "string" || o.promptVersion.length === 0) return false
  if (typeof o.modelId !== "string" || o.modelId.length === 0) return false
  if (!isReviewTarget(o.target)) return false
  if (typeof o.reviewedAt !== "number") return false
  // ARC-271: `findings` is optional and bounded — older manifests omit
  // it. When present, every entry must be well-formed; a malformed
  // entry invalidates the whole manifest so we don't read partially
  // corrupt delta state.
  if (o.findings !== undefined) {
    if (!Array.isArray(o.findings)) return false
    if (!o.findings.every(isReviewManifestFinding)) return false
  }
  return true
}

/**
 * Read the per-PR review manifest, returning a tagged result so the
 * caller can emit `review-manifest-invalid` telemetry with the reason
 * (Codex spec catch — bare `null` would lose that signal).
 *
 * Never throws — KV errors degrade to `{kind: "missing"}` so the
 * stale-mark gate fails-closed on read failures.
 */
export async function readReviewManifest(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReadResult> {
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(kvKey(owner, repo, prNumber))
  } catch {
    return { kind: "missing" }
  }
  if (raw === null) return { kind: "missing" }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid", reason: "json-parse" }
  }
  if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).v !== 1) {
    return { kind: "invalid", reason: "wrong-version" }
  }
  if (!isReviewManifestV1(parsed)) {
    return { kind: "invalid", reason: "shape" }
  }
  return { kind: "ok", manifest: parsed }
}

/**
 * Persist the manifest. Returns `false` on KV write failure (caller
 * may emit `review-manifest-write-failed` telemetry). Never throws.
 */
export async function writeReviewManifest(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  manifest: ReviewManifestV1,
): Promise<boolean> {
  try {
    await env.OPENCLAW_STATE.put(
      kvKey(owner, repo, prNumber),
      JSON.stringify(manifest),
      { expirationTtl: TTL_SECONDS },
    )
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------
// Drift predicate
// ---------------------------------------------------------------------

export interface CurrentReviewState {
  headSha: string
  baseSha: string
  fileListHash: string
  promptVersion: string
}

export type StaleReason = "head" | "base" | "file-list" | "prompt-version"

export interface StaleResult {
  stale: boolean
  reasons: StaleReason[]
}

const OVERFLOW_PREFIX = "sha256:overflow:"

function isOverflowSentinel(s: string): boolean {
  return s.startsWith(OVERFLOW_PREFIX)
}

/**
 * Pure drift predicate. Returns the set of reasons the prior review
 * is no longer authoritative for the current PR state.
 *
 * Head-SHA short-circuit: when `manifest.headSha === current.headSha`,
 * we treat the manifest as the up-to-date one and ignore other deltas.
 * This is a Cloudflare-KV eventual-consistency mitigation — the
 * "current" view we're comparing against could be a same-edge stale
 * read of the manifest's fields right after the writer landed.
 *
 * File-list hash is excluded from comparison whenever either side is
 * the overflow sentinel — overflow vs overflow can't be reliably
 * compared (different counts may still be the same set), and overflow
 * vs normal would mark stale every time a 3000-cap PR shrinks below
 * the cap (and vice versa). Head/base/prompt-version still detect.
 */
export function detectReviewStale(
  manifest: ReviewManifestV1,
  current: CurrentReviewState,
): StaleResult {
  if (manifest.headSha === current.headSha) {
    return { stale: false, reasons: [] }
  }
  const reasons: StaleReason[] = []
  if (manifest.headSha !== current.headSha) reasons.push("head")
  if (manifest.baseSha !== current.baseSha) reasons.push("base")
  if (
    !isOverflowSentinel(manifest.fileListHash) &&
    !isOverflowSentinel(current.fileListHash) &&
    manifest.fileListHash !== current.fileListHash
  ) {
    reasons.push("file-list")
  }
  if (manifest.promptVersion !== current.promptVersion) reasons.push("prompt-version")
  return { stale: reasons.length > 0, reasons }
}

// ---------------------------------------------------------------------
// File-list hash
// ---------------------------------------------------------------------

export interface PrFileEntry {
  filename: string
  previous_filename: string | null
  status: string
}

export interface PrFileList {
  overflow: boolean
  entries: PrFileEntry[]
}

/**
 * Compute the SHA-256 hex digest of the sorted changed-file set.
 * Returns the literal `sha256:overflow:<count>` sentinel when the
 * input list is flagged as overflowing the 3000-entry cap.
 *
 * Serialization: each line is `${filename}\0${previous_filename ?? ""}\n`.
 * Sort key is `filename` (lexicographic byte order). Renames are
 * stable because both names contribute to the hashed line.
 */
export async function computeFileListHash(list: PrFileList): Promise<string> {
  if (list.overflow) {
    return `${OVERFLOW_PREFIX}${list.entries.length}`
  }
  const sorted = [...list.entries].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
  const lines = sorted.map((f) => `${f.filename}\0${f.previous_filename ?? ""}\n`).join("")
  const bytes = new TextEncoder().encode(lines)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const arr = new Uint8Array(digest)
  let hex = ""
  for (const b of arr) hex += b.toString(16).padStart(2, "0")
  return hex
}

// ---------------------------------------------------------------------
// Stale-block render + apply
// ---------------------------------------------------------------------

const MARKER_START = "<!-- sigilix:stale-marker:start -->"
const MARKER_END = "<!-- sigilix:stale-marker:end -->"
const SIGILIX_HEAD = "<!-- sigilix:pr-review -->"

const GH_BODY_LIMIT = 65000

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const STALE_BLOCK_RE = new RegExp(
  `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`,
  "m",
)

const SIGILIX_HEAD_RE = new RegExp(`^(${escapeRegex(SIGILIX_HEAD)}\\n)`)

/**
 * Render the bracketed stale-notice block. Block content is
 * Markdown-only (GitHub note callout); only the marker comments are
 * HTML, which GitHub preserves through PATCH round-trips.
 */
export function renderStaleBlock(
  manifest: ReviewManifestV1,
  current: CurrentReviewState,
): string {
  const oldHead = manifest.headSha.slice(0, 7)
  const oldBase = manifest.baseSha.slice(0, 7)
  const newHead = current.headSha.slice(0, 7)
  const newBase = current.baseSha.slice(0, 7)
  return [
    MARKER_START,
    "> [!WARNING]",
    `> **This review is stale.** Reviewed head \`${oldHead}\` against base \`${oldBase}\`. PR is now at \`${newHead}\` against base \`${newBase}\`. Run \`/sigilix review\` to re-review the current diff, or wait — Sigilix will refresh on the next push.`,
    MARKER_END,
  ].join("\n")
}

/**
 * Insert (or replace) the stale block in `body`, preserving everything
 * else. Idempotent on re-application — running twice yields the same
 * body. Truncates the original body if the combined output would
 * exceed GitHub's 65535-char body limit (defense in depth; Sigilix
 * bodies almost never approach this).
 *
 * Uses literal-marker matching (the angle brackets and dashes are
 * required), so accidental prose containing `sigilix:stale-marker:start`
 * inside a code fence does not collide.
 */
export function applyStaleBlock(body: string, block: string): string {
  let next: string
  if (STALE_BLOCK_RE.test(body)) {
    // Replace existing block in place. The regex captures a trailing
    // newline if present (`\n?`); always restore one so the surrounding
    // body retains identical structure across re-applications
    // (idempotent length).
    next = body.replace(STALE_BLOCK_RE, `${block}\n`)
  } else if (SIGILIX_HEAD_RE.test(body)) {
    next = body.replace(SIGILIX_HEAD_RE, `$1\n${block}\n`)
  } else {
    next = `${block}\n\n${body}`
  }
  if (next.length <= GH_BODY_LIMIT) return next

  // Truncate the original body to fit, preserving the full block + a
  // pointer marker. The block sits after the sigilix head when
  // present; otherwise at the very top.
  const TRUNCATED_NOTICE = "\n\n_[review body truncated to fit stale notice; full review in PR review history]_\n"
  const overrun = next.length - GH_BODY_LIMIT + TRUNCATED_NOTICE.length
  // Find the index *just after* the inserted block so we trim only
  // user/Sigilix content, never the block itself.
  const blockIdx = next.indexOf(MARKER_END)
  const blockEnd = blockIdx === -1 ? 0 : blockIdx + MARKER_END.length
  const head = next.slice(0, blockEnd)
  const tail = next.slice(blockEnd)
  const trimmedTail = tail.slice(0, Math.max(0, tail.length - overrun))
  return head + trimmedTail + TRUNCATED_NOTICE
}
