// Proactive primary review (greptile-style). Reviews the PR in
// isolation — does its own pass independent of CR or any other
// reviewer. Each finding is anchored to a specific line, scored 1-5,
// and tagged with a category (logic / style / security / etc.) that
// leads the inline comment.
//
// Submits a single review via POST /pulls/{n}/reviews so all findings
// arrive as one coherent unit on GitHub. Approval state is derived from
// the max finding score:
//
//   findings empty   → APPROVE
//   any findings     → REQUEST_CHANGES
//
// Strict, two-state. Paired with synchronize-driven re-reviews
// (PR #28): user pushes fixes → arc re-reviews → if findings now
// empty, flips to APPROVE. The closed loop replaces the previous
// "APPROVE with score-3 nits posted as advisory inline comments,"
// which read as contradictory (green check + 'fix this' comments).
//
// Triggers (wired in src/index.ts):
//   pull_request.opened              first review pass when PR opens
//   pull_request.synchronize         re-run after each push
//
// Dedupe is keyed on (prNumber, headSha) — same head sha + same PR =
// skip. New push = new sha = re-runs.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import {
  GitHubClient,
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { PR_REVIEW_SCHEMA } from "./schemas"
import { PR_REVIEW_PROMPT } from "../prompts/pr-review"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const DEDUPE_PREFIX = "pr-review:"

/**
 * Build the per-(PR, headSha) dedupe-lock KV key used by
 * `handlePrReview`. Exported so the ARC-178 slash-command rerun
 * handler can clear the lock before re-enqueueing — without this,
 * `/sigilix review` would silently no-op on any PR that already
 * has a posted review for the current head.
 */
export function buildPrReviewDedupeKey(args: {
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): string {
  return `${DEDUPE_PREFIX}${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`
}

const LIMITS = {
  // Bumped from 22_000 to 80_000 (2026-05-04) — the prior cap was
  // truncating large PR diffs to ~14% of their actual content, which
  // (a) starved the model of signal on big PRs and (b) coincided with
  // observed JSON-output-discipline degradation on PR #24 (3.1k lines
  // added). 80k stays comfortably under Cloudflare Workers prompt budget
  // AND under GLM-5.1's effective context for clean structured output.
  // jsonrepair is already wired in via parseFirstJsonObject for the
  // "lightly malformed JSON" case; this just gives the model less reason
  // to malform output in the first place.
  prDiff: 80_000,
  prBody: 4_000,
  crCommentsBlock: 8_000,
  crCommentBody: 1_200,
}

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES"

export type FindingCategory =
  | "logic"
  | "security"
  | "performance"
  | "error-handling"
  | "testing"
  | "complexity"
  | "style"
  | "syntax"
  | "docs"

export const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "logic",
  "security",
  "performance",
  "error-handling",
  "testing",
  "complexity",
  "style",
  "syntax",
  "docs",
])

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  score: number
  category: FindingCategory
  headline: string
  body: string
}

export interface PrReviewVerdict {
  summary: string
  confidence: number
  confidenceReason: string
  findings: PrReviewFinding[]
}

export interface TriagePrReviewArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
}

export async function handlePrReview(args: TriagePrReviewArgs): Promise<void> {
  const { owner, repo, prNumber, headSha, installationId, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[pr-review] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      headSha: headSha.slice(0, 7),
    })
  }

  since("start")

  // Concurrent-run guard with try/finally release so queue retries
  // can re-attempt on failure. Keyed on (prNumber, headSha) — a new
  // push (different SHA) gets a different key and re-runs as expected.
  const dedupeKey = buildPrReviewDedupeKey({ owner, repo, prNumber, headSha })
  const seen = await env.OPENCLAW_STATE.get(dedupeKey)
  if (seen) {
    console.log(`pr-review already ran for ${dedupeKey} — skipping`)
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
    expirationTtl: 7 * 24 * 60 * 60, // 7 days — long enough to outlive retries on success
  })

  let posted = false
  try {
    const client = await buildClient(env, installationId)
    since("auth-ready")

    const [meta, diff] = await Promise.all([
      client.getPullRequest(owner, repo, prNumber),
      client.getPullRequestDiff(owner, repo, prNumber),
    ])
    since("pr-fetched")

    // Stale-head guard: with synchronize-driven re-reviews, a slow job
    // for SHA A can finish AFTER SHA B's job has already posted. The
    // diff fetch above returns the *current* PR head (B), but we'd
    // submit the review against the queued commit_id (A) — bad anchors,
    // and arc would appear to regress B's verdict. Skip if head moved.
    // The finally block below releases this SHA's dedupe key, but B
    // has its own dedupe key (key is per-SHA) so B isn't affected.
    if (meta.head?.sha && meta.head.sha !== headSha) {
      console.log(
        `pr-review skipping stale job: queued ${headSha}, current ${meta.head.sha}`,
      )
      return
    }

    const prompt = buildPrompt({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    since("ollama-start")
    const response = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    })
    since("ollama-done")

    const verdict = parsePrReviewResponse(response)
    if (!verdict) {
      // Throw — don't silently return. Silent return acks the queue
      // message and produces no formal review and no visible failure
      // signal (PR #19's actual failure mode). Throwing routes through
      // the queue handler's MAX_RETRIES + "queue job dropped" log so
      // operators see the failure, and a transient Ollama hiccup gets
      // a re-attempt before being declared dead.
      console.error("pr-review verdict did not parse", {
        owner,
        repo,
        prNumber,
        responseLength: response.length,
      })
      throw new Error("pr-review verdict did not parse")
    }

    const reviewBody = buildReviewSubmission({
      verdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
    })

    const submitted = await client.submitReview(owner, repo, prNumber, reviewBody)
    posted = true
    since(`review-submitted-${submitted.state}`)
    console.log(
      `pr-review submitted on ${owner}/${repo}#${prNumber}: ${submitted.state} (confidence=${verdict.confidence}/5, ${verdict.findings.length} findings)`
    )
  } finally {
    // Release the lock unless we actually posted a review. On a
    // successful post, the 7-day TTL stays — we don't want CR's
    // submitted-event firing a duplicate review on the same head SHA.
    if (!posted) {
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
  }
}

interface PromptCtx {
  prNumber: number
  title: string
  body: string
  diff: string
}

function buildPrompt(ctx: PromptCtx): string {
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_REVIEW_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.title}`,
    "Body:",
    truncate(ctx.body || "(no description)", LIMITS.prBody),
    "",
    "[PR DIFF]",
    truncate(ctx.diff, LIMITS.prDiff),
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence.",
  ]
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model's primary-review response. Tolerates clean JSON,
 * fenced JSON, AND prose-wrapped JSON via balanced-brace extraction.
 * Returns null on shape errors so callers can fail loudly. Pure —
 * exported for tests.
 */
export function parsePrReviewResponse(text: string): PrReviewVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const confidenceRaw = Number(obj.confidence)
  if (!Number.isFinite(confidenceRaw) || confidenceRaw < 1 || confidenceRaw > 5) return null
  const confidence = Math.round(confidenceRaw)

  const confidenceReason =
    typeof obj.confidenceReason === "string" ? obj.confidenceReason.trim() : ""

  const findings: PrReviewFinding[] = []
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
  for (const f of rawFindings) {
    if (!f || typeof f !== "object") continue
    const finding = f as Record<string, unknown>
    const path = typeof finding.path === "string" ? finding.path.trim() : ""
    const line = Number(finding.line)
    const headline = typeof finding.headline === "string" ? finding.headline.trim() : ""
    const body = typeof finding.body === "string" ? finding.body.trim() : ""
    const scoreRaw = Number(finding.score)
    const categoryRaw = typeof finding.category === "string" ? finding.category.trim().toLowerCase() : ""
    if (!path || !Number.isFinite(line) || line <= 0) continue
    if (!headline || !body) continue
    if (!Number.isFinite(scoreRaw) || scoreRaw < 1 || scoreRaw > 5) continue
    // Default to "logic" when the model omits or returns an unknown
    // category — better than dropping the finding entirely. The schema
    // enforces the enum at decode time, so this fallback only catches
    // schema-bypass paths (jsonrepair, etc.).
    const category: FindingCategory = FINDING_CATEGORIES.has(categoryRaw as FindingCategory)
      ? (categoryRaw as FindingCategory)
      : "logic"
    const startLineRaw = Number(finding.startLine)
    const validStartLine =
      Number.isFinite(startLineRaw) && startLineRaw > 0 && startLineRaw < line
        ? Math.floor(startLineRaw)
        : null
    const finalFinding: PrReviewFinding = {
      path,
      line: Math.floor(line),
      score: Math.max(1, Math.min(5, Math.round(scoreRaw))),
      category,
      headline,
      body,
    }
    if (validStartLine != null) finalFinding.startLine = validStartLine
    findings.push(finalFinding)
    if (findings.length >= 8) break
  }

  return { summary, confidence, confidenceReason, findings }
}

interface BuildReviewArgs {
  verdict: PrReviewVerdict
  prAuthor: string | null
  headSha: string
  /**
   * Findings that passed the hallucination guard but failed the
   * line-validity check. The inline-comments path can't anchor them
   * (GitHub would 422), so they get rolled into the review body as
   * markdown grouped by file. Without this, unanchored findings were
   * silently dropped on the success path of the orchestrator (only
   * the submit-fallback path recovered them). CodeRabbit + Sigilix
   * both caught the regression on PR #38.
   *
   * Default `[]` — the common case where every finding anchored
   * cleanly. When non-empty:
   *   - The chosen review event takes ALL findings into account
   *     (anchored + unanchored), so a verdict with only-unanchored
   *     blocking findings doesn't post as APPROVE.
   *   - The body grows with an `### Additional findings (could not
   *     anchor to diff)` section listing the unanchored set.
   */
  unanchored?: PrReviewFinding[]
}

/**
 * Translate a parsed verdict into the GitHub review submission body.
 * Approval logic is strict + two-state:
 *   - findings empty → APPROVE
 *   - any findings   → REQUEST_CHANGES
 *
 * Score still sorts/orders findings in the body but no longer changes
 * the verdict. Paired with synchronize-driven re-reviews (PR #28):
 * user pushes fixes → arc re-reviews → if findings now empty, flips
 * to APPROVE. Closed loop, no contradictory APPROVE-with-inline-fixes.
 *
 * Top-level body becomes a sticky summary with confidence + the model's
 * own confidenceReason so a reviewer skimming the PR sees OpenClaw's
 * read at a glance. Pure — exported for tests.
 */
export function buildReviewSubmission({
  verdict,
  prAuthor,
  headSha,
  unanchored = [],
}: BuildReviewArgs): SubmitReviewBody {
  // Event derivation merges anchored + unanchored so a verdict whose
  // only blocking findings happen to be unanchored doesn't post APPROVE
  // (CR + Sigilix PR #38 catch).
  const event = chooseReviewEvent([...verdict.findings, ...unanchored])
  const body = formatReviewBody(verdict, prAuthor, event, unanchored)
  const comments: SubmitReviewComment[] = verdict.findings.map((f) => {
    const c: SubmitReviewComment = {
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: formatFindingComment(f),
    }
    if (f.startLine != null) {
      c.start_line = f.startLine
      c.start_side = "RIGHT"
    }
    return c
  })
  const submission: SubmitReviewBody = {
    event,
    body,
    commit_id: headSha,
  }
  if (comments.length > 0) submission.comments = comments
  return submission
}

interface BuildFallbackArgs {
  verdict: PrReviewVerdict
  unanchored: PrReviewFinding[]
  prAuthor: string | null
  headSha: string
}

/**
 * Greptile-style submit-review fallback: when the inline-anchored review
 * (POST /reviews with `comments`) is rejected by GitHub, retry the same
 * review WITHOUT inline anchors, embedding every finding in the body as
 * markdown grouped by file. Recovers the verdict instead of losing it.
 *
 * Findings come from two sources:
 *   1. `verdict.findings` — passed every validator (line-valid, anchored)
 *   2. `unanchored` — passed the hallucination guard but failed
 *      `deriveSide()` (e.g., model picked a line outside the diff). With
 *      no inline anchoring in fallback mode, the position-validity gate
 *      no longer matters — these still describe real concerns.
 *
 * Both lists are merged, grouped by `path`, and rendered as a Markdown
 * `### Findings` section. The dedupe marker `<!-- openclaw:pr-review -->`
 * is preserved at the top so existing dedupe-by-marker logic still
 * recognizes the comment.
 *
 * Pure — exported for tests.
 */
export function buildFallbackSubmission({
  verdict,
  unanchored,
  headSha,
}: BuildFallbackArgs): SubmitReviewBody {
  // Event derivation merges anchored + unanchored — same fix as
  // `buildReviewSubmission`. Without this, a verdict whose only
  // blocking findings are unanchored would post APPROVE while the
  // body lists blockers (CR + Sigilix PR #38 catch).
  const event = chooseReviewEvent([...verdict.findings, ...unanchored])
  const body = buildFallbackBody(verdict, unanchored)
  return {
    event,
    body,
    commit_id: headSha,
    // No `comments` array — every finding lives in `body`.
  }
}

export function buildFallbackBody(
  verdict: PrReviewVerdict,
  unanchored: PrReviewFinding[]
): string {
  const all = [...verdict.findings, ...unanchored]
  if (all.length === 0) {
    // No inline findings to relocate; the standard prose body is fine.
    // Still flow through formatReviewBody to keep the marker + summary.
    return formatReviewBody(verdict, null, chooseReviewEvent(verdict.findings))
  }

  const lines: string[] = ["<!-- openclaw:pr-review -->", ""]
  lines.push("### Sigilix Summary")
  lines.push("")
  lines.push(verdict.summary)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }
  // ARC-180 deliberately does NOT add a Fix Plan section here — the
  // fallback already renders every finding grouped by file (a few
  // lines below), so a severity-prioritized header above the same
  // data would duplicate content. The inline-anchor path uses Fix
  // Plan because findings live BELOW the body as separate inline
  // comments, not in the body itself.
  lines.push("")
  lines.push(`### Findings (${all.length})`)
  lines.push(...renderFindingsByFile(all))

  return lines.join("\n")
}

export function chooseReviewEvent(findings: PrReviewFinding[]): ReviewEvent {
  // Strict: any inline finding the model surfaces is a blocker. The
  // verdict is two-state (APPROVE | REQUEST_CHANGES) — score still
  // sorts/severity-tags the findings but doesn't decide the gate.
  // Closed loop comes from synchronize-driven re-reviews (PR #28):
  // user pushes fixes → arc re-reviews → empty findings → APPROVE.
  return findings.length === 0 ? "APPROVE" : "REQUEST_CHANGES"
}

/**
 * Greptile-style review body. Prose-first with structured headers and
 * NO mechanical "Findings: N (max score N)" footer or numerical
 * confidence score in the body. The model's confidenceReason becomes
 * the lead, the summary is sub-text, and findings live as inline
 * comments below — so the body itself reads like a senior reviewer's
 * one-paragraph take, not a structured report.
 *
 * Reference shape (per Codex's audit of greptile-apps output):
 *   ### Arc Summary
 *   <prose paragraph>
 *
 *   <optional approval note when applicable>
 *
 *   <optional `### Important Files Changed` section, only when useful>
 *
 *   <"See N findings inline below" pointer when findings exist>
 */
function formatReviewBody(
  verdict: PrReviewVerdict,
  _prAuthor: string | null,
  _event: ReviewEvent,
  unanchored: PrReviewFinding[] = []
): string {
  // Body is greptile-styled and prose-only. The structure is fixed
  // (marker, header, model's summary, model's confidence reason,
  // finding count pointer) but every word inside is the model's. No
  // hardcoded author notes ("@author — items below are non-blocking,
  // approving") because canned dialogue feels mechanical when it
  // recurs across PRs. The model's summary already addresses the
  // engineer reviewing the PR — that's the message.
  //
  // When `unanchored` is non-empty, an "Additional findings" section
  // is appended so findings whose lines fell outside the diff still
  // get surfaced (rather than silently dropped on the success path).
  const lines: string[] = ["<!-- openclaw:pr-review -->", ""]
  lines.push("### Sigilix Summary")
  lines.push("")
  lines.push(verdict.summary)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }
  if (verdict.findings.length > 0) {
    lines.push("")
    lines.push(
      `_${verdict.findings.length} ${verdict.findings.length === 1 ? "finding" : "findings"} inline below._`
    )
  }
  // ARC-180: Fix Plan — surface high/critical findings (score >= 4)
  // as a prioritized repair queue at the top of the review. Anchored
  // and unanchored findings both contribute, since the prioritization
  // is severity-based and a blocker is a blocker regardless of
  // whether the inline comment landed cleanly.
  const fixPlan = renderFixPlan([...verdict.findings, ...unanchored])
  if (fixPlan) {
    lines.push("")
    lines.push(fixPlan)
  }
  if (unanchored.length > 0) {
    lines.push("")
    lines.push(`### Additional findings (could not anchor to diff)`)
    lines.push(...renderFindingsByFile(unanchored))
  }
  return lines.join("\n")
}

/**
 * ARC-180: render the "Fix Plan" section listing score >= 4 findings
 * (high or critical) as a prioritized repair queue. Returns the
 * Markdown string ready to drop into the review body, or null when
 * there are no findings at that severity (in which case the section
 * is omitted entirely — no empty headers).
 *
 * Format:
 *   ### Fix Plan
 *
 *   **Critical (score 5)**
 *   - \`src/foo.ts:42\` — \`logic\`: Headline
 *   - \`src/bar.ts:88\` — \`security\`: Headline
 *
 *   **High (score 4)**
 *   - \`src/baz.ts:15\` — \`error-handling\`: Headline
 *
 * Within each severity, ordered by path then line so the queue stays
 * stable across runs (a reviewer working top-to-bottom can re-run
 * /sigilix review and the queue won't shuffle on them).
 *
 * Pure — exported for tests.
 */
export function renderFixPlan(findings: PrReviewFinding[]): string | null {
  const critical: PrReviewFinding[] = []
  const high: PrReviewFinding[] = []
  for (const f of findings) {
    if (f.score >= 5) critical.push(f)
    else if (f.score >= 4) high.push(f)
  }
  if (critical.length === 0 && high.length === 0) return null

  const sortByLocation = (a: PrReviewFinding, b: PrReviewFinding): number => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.line - b.line
  }
  critical.sort(sortByLocation)
  high.sort(sortByLocation)

  const lines: string[] = ["### Fix Plan"]
  if (critical.length > 0) {
    lines.push("")
    lines.push(`**Critical (score 5)** — ${critical.length} ${critical.length === 1 ? "finding" : "findings"}`)
    for (const f of critical) lines.push(formatFixPlanRow(f))
  }
  if (high.length > 0) {
    lines.push("")
    lines.push(`**High (score 4)** — ${high.length} ${high.length === 1 ? "finding" : "findings"}`)
    for (const f of high) lines.push(formatFixPlanRow(f))
  }
  return lines.join("\n")
}

function formatFixPlanRow(f: PrReviewFinding): string {
  const range = f.startLine != null && f.startLine !== f.line
    ? `${f.path}:${f.startLine}-${f.line}`
    : `${f.path}:${f.line}`
  // Headline only — the inline comment carries the body. Truncate
  // defensively so an over-long headline can't break the bullet list.
  const headline = f.headline.length > 140 ? `${f.headline.slice(0, 137)}…` : f.headline
  return `- \`${range}\` — \`${f.category}\`: ${headline}`
}

/**
 * Group findings by file path, sort within each file by score DESC
 * then line ASC, and render as a Markdown bullet list. Shared by
 * `formatReviewBody` (when unanchored findings need to be surfaced
 * alongside the inline-anchored ones) and `buildFallbackBody` (when
 * the entire submission is anchorless and every finding lives in the
 * body).
 *
 * Returns an array of lines (caller joins with `\n`). Pure.
 */
function renderFindingsByFile(findings: PrReviewFinding[]): string[] {
  const byPath = new Map<string, PrReviewFinding[]>()
  for (const f of findings) {
    if (!byPath.has(f.path)) byPath.set(f.path, [])
    byPath.get(f.path)!.push(f)
  }
  const sortedPaths = [...byPath.keys()].sort()

  const lines: string[] = []
  for (const path of sortedPaths) {
    const arr = byPath.get(path)!
    arr.sort((a, b) => b.score - a.score || a.line - b.line)
    lines.push("")
    lines.push(`**${path}**`)
    for (const f of arr) {
      const range =
        f.startLine != null && f.startLine !== f.line
          ? `Lines ${f.startLine}-${f.line}`
          : `Line ${f.line}`
      lines.push(`- ${range} — **${f.category}:** ${f.headline}`)
      // Indent the body so it nests under the bullet visually.
      const bodyLines = f.body
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
      lines.push(bodyLines)
    }
  }
  return lines
}

/**
 * Inline finding comment, greptile-style. The category leads as
 * \`**category:**\` (logic, style, security, performance, etc.) so
 * a reviewer can scan a thread and immediately see what kind of
 * concern it is. Severity is implicit in the body / approval state,
 * not in the inline tag — that's how greptile-apps does it. Body and
 * any \`\`\`suggestion block flow underneath verbatim.
 */
function formatFindingComment(finding: PrReviewFinding): string {
  const lines: string[] = ["<!-- openclaw:pr-review-finding -->"]
  lines.push(`**${finding.category}:** ${finding.headline}`)
  lines.push("")
  lines.push(finding.body)
  return lines.join("\n")
}


async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
