#!/usr/bin/env -S npx tsx
// SIG-161 PR 4b — labeling-corpus collector.
//
// Pulls every inline-posted Sigilix bot finding from a list of GitHub
// PRs into a single JSONL stream. Output is the per-finding input for
// the labeling workflow defined in
// `.claude/research/sig-161-labeling/LABELING_GUIDE.md`. Each line is
// one finding with the metadata the labeler needs (PR / file / line /
// category / score / self-reported confidence / evidence-citation
// fields) plus a stable `findingId` for joining to labels.csv.
//
// Usage (defaults to the Sigilix dogfood + Rubberfit cross-tenant mix
// the design's §7b prescribes):
//
//   npm run collect-sig-161-findings -- \
//     --repo Sigilix/sigilix:60 \
//     --repo Rubberfit/rubberfit:30 \
//     --out .claude/research/sig-161-labeling/findings-source.jsonl
//
// The `--repo OWNER/REPO:N` syntax pulls the last N closed/open PRs
// from that repo. Multiple `--repo` flags accumulate. `gh` CLI must be
// authenticated for both repos.
//
// Side-effect-free relative to the worker — this is an offline data-
// collection script, no production env touched. The output is the
// IMMUTABLE corpus the labeling exercise judges against; once committed
// to `.claude/research/sig-161-labeling/findings-source.jsonl` it is
// not re-generated unless the design's stratification mix changes (in
// which case the diff is auditable in git).

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const exec = promisify(execFile)

// ─── CLI args ────────────────────────────────────────────────────

interface CliArgs {
  repos: Array<{ owner: string; repo: string; limit: number }>
  out: string
  verbose: boolean
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      repo: { type: "string", multiple: true },
      out: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  const repoFlags = (values.repo as string[] | undefined) ?? []
  if (repoFlags.length === 0) {
    throw new Error(
      "at least one --repo OWNER/REPO:N flag is required (e.g. --repo Sigilix/sigilix:60)",
    )
  }
  const repos = repoFlags.map((flag) => {
    const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(flag)
    if (!m) {
      throw new Error(
        `--repo flag must match OWNER/REPO:N; got ${JSON.stringify(flag)}`,
      )
    }
    return { owner: m[1]!, repo: m[2]!, limit: Number(m[3]!) }
  })

  const out = (values.out as string | undefined) ??
    ".claude/research/sig-161-labeling/findings-source.jsonl"

  return { repos, out: resolve(out), verbose: !!values.verbose }
}

// ─── gh CLI helpers ──────────────────────────────────────────────

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function ghJson<T>(args: string[]): Promise<T> {
  const raw = await gh(args)
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(
      `gh ${args.join(" ")} returned non-JSON output: ${(err as Error).message}`,
    )
  }
}

// ─── GitHub data shapes ─────────────────────────────────────────

interface GhPrSummary {
  number: number
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  headRefOid: string
  createdAt: string
  url: string
}

interface GhReviewComment {
  /** Inline review-comment id (numeric). Used as part of `findingId`. */
  id: number
  user: { login: string } | null
  path: string
  line: number | null
  start_line: number | null
  body: string
  pull_request_review_id: number | null
  created_at: string
  html_url: string
}

// ─── Output shape ────────────────────────────────────────────────

/**
 * One row of `findings-source.jsonl` — what the labeler sees.
 *
 * `findingId` is deterministic: SHA-256 of `(owner|repo|prNumber|comment_id)`.
 * Joins to `labels.csv` (founder fills `label` + `labelReason`).
 *
 * All metadata fields are parsed from the bot's comment body (which
 * Sigilix renders via `formatFindingComment` — see `src/lib/triage-pr-review.ts`).
 * Fields we couldn't parse are `undefined`; the labeling guide says
 * to label from the body + diff, not from metadata, so missing fields
 * are not blocking.
 */
interface FindingRow {
  findingId: string
  owner: string
  repo: string
  prNumber: number
  prUrl: string
  headSha: string
  path: string
  line: number | null
  startLine: number | null
  commentId: number
  commentUrl: string
  createdAt: string
  // Parsed from the comment body
  category?: string
  score?: number
  confidence?: number
  headline?: string
  body?: string
  // Sigilix marker fields (parsed from the HTML comment marker)
  sigilixFid?: string
  sigilixSev?: string
}

const SIGILIX_BOT = "sigilix[bot]"

const FINDING_MARKER = /<!--\s*sigilix:pr-review-finding\s*-->/

// Match the heading line emitted by `formatFindingComment` (SIG-164):
//   "🟠 P1 · **testing:** Some headline · _confidence: 3/5_"
// Severity badge varies (`🔴 P0`, `🟠 P1`, `🟡 P2`, `🟢 P3`, sometimes
// just `**cat:**`). The regex captures category, headline, and
// confidence; severity is read from the badge separately if needed.
const HEADING_RE =
  /^(?:[^\s]+\s+P\d\s+·\s+)?\*\*([a-z-]+):\*\*\s+(.+?)\s+·\s+_confidence:\s+(\d)\/5_\s*$/m

// Parse the embedded marker, e.g.
//   <!-- sigilix:fid:6133bdb79f7b71af:cat:tests:sev:warning:path:a2a171449d86 -->
const MARKER_RE =
  /<!--\s*sigilix:fid:([0-9a-f]+):cat:([a-z-]+):sev:([a-z]+):path:([0-9a-f]+)\s*-->/

const SEVERITY_TO_SCORE: Record<string, number> = {
  critical: 5,
  blocker: 5,
  warning: 4,
  info: 3,
  hint: 2,
  nit: 1,
}

function parseFinding(args: {
  owner: string
  repo: string
  prNumber: number
  prUrl: string
  headSha: string
  comment: GhReviewComment
}): FindingRow | null {
  const { comment, owner, repo, prNumber, prUrl, headSha } = args

  if (!comment.user || comment.user.login !== SIGILIX_BOT) return null
  if (!FINDING_MARKER.test(comment.body)) return null

  const headingMatch = HEADING_RE.exec(comment.body)
  const markerMatch = MARKER_RE.exec(comment.body)

  const findingId = createHash("sha256")
    .update(`${owner}|${repo}|${prNumber}|${comment.id}`)
    .digest("hex")
    .slice(0, 16)

  const row: FindingRow = {
    findingId,
    owner,
    repo,
    prNumber,
    prUrl,
    headSha,
    path: comment.path,
    line: comment.line,
    startLine: comment.start_line,
    commentId: comment.id,
    commentUrl: comment.html_url,
    createdAt: comment.created_at,
  }

  if (headingMatch) {
    row.category = headingMatch[1]
    row.headline = headingMatch[2]
    const confRaw = Number(headingMatch[3])
    if (Number.isFinite(confRaw) && confRaw >= 1 && confRaw <= 5) {
      row.confidence = confRaw
    }
  }

  if (markerMatch) {
    row.sigilixFid = markerMatch[1]
    if (!row.category) row.category = markerMatch[2]
    row.sigilixSev = markerMatch[3]
    const sevScore = SEVERITY_TO_SCORE[markerMatch[3]!]
    if (sevScore !== undefined) row.score = sevScore
  }

  // Body excerpt: the comment body minus the heading line + the
  // trailing marker line. The labeler reads this verbatim.
  row.body = comment.body
    .replace(FINDING_MARKER, "")
    .replace(HEADING_RE, "")
    .replace(MARKER_RE, "")
    .trim()
    .slice(0, 4000)

  return row
}

// ─── Per-repo fetcher ────────────────────────────────────────────

async function listPrs(
  owner: string,
  repo: string,
  limit: number,
  verbose: boolean,
): Promise<GhPrSummary[]> {
  // `gh pr list` returns the most recent PRs by default; use --state all
  // so we pick up MERGED PRs (the bulk of the labeling corpus is
  // already-merged dogfood).
  const fields = "number,title,state,headRefOid,createdAt,url"
  const out = await ghJson<GhPrSummary[]>([
    "pr",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    fields,
  ])
  if (verbose) {
    console.error(`[collect] ${owner}/${repo}: ${out.length} PRs`)
  }
  return out
}

async function listPrComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GhReviewComment[]> {
  // `gh api --paginate` walks every page; we want all review comments
  // from sigilix[bot] (filter post-fetch — the GitHub API doesn't
  // support a user-filter param).
  const raw = await gh([
    "api",
    "--paginate",
    `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
  ])
  // `--paginate` concatenates JSON arrays as separate top-level array
  // tokens; merge them into one array.
  const merged: GhReviewComment[] = []
  for (const chunk of splitConcatenatedJsonArrays(raw)) {
    merged.push(...(JSON.parse(chunk) as GhReviewComment[]))
  }
  return merged
}

/**
 * Split a string of concatenated top-level JSON arrays (`[…][…][…]`)
 * into the individual array strings. `gh api --paginate` emits this
 * shape on multi-page reads. Pure — exported for tests.
 */
export function splitConcatenatedJsonArrays(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === "[") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "]") {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

// ─── Main ────────────────────────────────────────────────────────

async function collectFromRepo(
  args: { owner: string; repo: string; limit: number; verbose: boolean },
): Promise<FindingRow[]> {
  const { owner, repo, limit, verbose } = args
  const prs = await listPrs(owner, repo, limit, verbose)
  const all: FindingRow[] = []
  for (const pr of prs) {
    try {
      const comments = await listPrComments(owner, repo, pr.number)
      let kept = 0
      for (const c of comments) {
        const row = parseFinding({
          owner, repo, prNumber: pr.number, prUrl: pr.url, headSha: pr.headRefOid,
          comment: c,
        })
        if (row) {
          all.push(row)
          kept++
        }
      }
      if (verbose) {
        console.error(`[collect]   ${owner}/${repo}#${pr.number}: ${kept} findings`)
      }
    } catch (err) {
      console.error(
        `[collect]   ${owner}/${repo}#${pr.number}: skipped — ${(err as Error).message}`,
      )
    }
  }
  return all
}

async function main(): Promise<void> {
  const args = parseCli(process.argv)
  const all: FindingRow[] = []
  for (const { owner, repo, limit } of args.repos) {
    const rows = await collectFromRepo({ owner, repo, limit, verbose: args.verbose })
    all.push(...rows)
  }

  // Stable sort: by (owner, repo, prNumber, commentId) so re-runs
  // produce identical files when the corpus hasn't changed (line-diff
  // friendly for the labeled CSV).
  all.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1
    if (a.prNumber !== b.prNumber) return a.prNumber - b.prNumber
    return a.commentId - b.commentId
  })

  await mkdir(dirname(args.out), { recursive: true })
  const jsonl = all.map((r) => JSON.stringify(r)).join("\n") + "\n"
  await writeFile(args.out, jsonl, "utf8")

  // Per-category summary so the founder can eyeball the stratification.
  const byCategory: Record<string, number> = {}
  const byConfidence: Record<string, number> = { unknown: 0 }
  for (const r of all) {
    const c = r.category ?? "unknown"
    byCategory[c] = (byCategory[c] ?? 0) + 1
    const k = r.confidence === undefined ? "unknown" : String(r.confidence)
    byConfidence[k] = (byConfidence[k] ?? 0) + 1
  }
  console.error(`[collect] wrote ${all.length} findings → ${args.out}`)
  console.error(`[collect] by category: ${JSON.stringify(byCategory)}`)
  console.error(`[collect] by confidence: ${JSON.stringify(byConfidence)}`)
}

// Run when executed as a script (not when imported by tests).
//
// Detect via import.meta.url comparing against the resolved process.argv[1].
// Compiled tsx puts both as file:// URLs.
const isMain = (() => {
  try {
    const argv1 = process.argv[1]
    if (!argv1) return false
    // `pathToFileURL` produces a valid `file://` URL on every platform —
    // a `file://${resolve(path)}` template fails on Windows where
    // `resolve` returns `C:\foo\bar` rather than `/foo/bar`. CodeRabbit
    // catch on PR 4b.
    const argvUrl = pathToFileURL(resolve(argv1)).href
    return import.meta.url === argvUrl
  } catch {
    return false
  }
})()

if (isMain) {
  void main().catch((err) => {
    console.error(`[collect] fatal: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
}

// Exports for unit tests.
export { parseFinding, type FindingRow }
