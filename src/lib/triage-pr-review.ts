// Proactive primary review (greptile-style). CodeRabbit is the team's
// main reviewer; OpenClaw fires AFTER CR has posted its comments and
// surfaces only what CR missed. Each finding is anchored to a specific
// line + scored 1-5 (matching pr-overview's scoring vocabulary), with
// an optional `\`\`\`suggestion` block when the fix is mechanical.
//
// Submits a single review via POST /pulls/{n}/reviews so all findings
// arrive as one coherent unit on GitHub. Approval state is derived from
// the max finding score:
//
//   max score 5      → REQUEST_CHANGES (do not merge)
//   max score 3-4    → COMMENT (concerns, your call)
//   max score 1-2    → APPROVE (ready to merge)
//   findings empty   → APPROVE
//
// Triggers (wired in src/index.ts):
//   pull_request.opened              first review pass when PR opens
//   pull_request_review.submitted    re-run after CR finishes its review
//   pull_request.synchronize         re-run after each push
//
// Dedupe is keyed on (prNumber, headSha) — same head sha + same PR =
// skip. New push = new sha = re-runs.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import {
  GitHubClient,
  type ReviewComment,
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { PR_REVIEW_SCHEMA } from "./schemas"
import { PR_REVIEW_PROMPT } from "../prompts/pr-review"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const DEDUPE_PREFIX = "pr-review:"

const LIMITS = {
  prDiff: 22_000,
  prBody: 4_000,
  crCommentsBlock: 8_000,
  crCommentBody: 1_200,
}

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  score: number
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
  const dedupeKey = `${DEDUPE_PREFIX}${owner}/${repo}#${prNumber}@${headSha}`
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

    const [meta, diff, allReviewComments] = await Promise.all([
      client.getPullRequest(owner, repo, prNumber),
      client.getPullRequestDiff(owner, repo, prNumber),
      client
        .listPullRequestReviewComments(owner, repo, prNumber)
        .catch(() => [] as ReviewComment[]),
    ])
    since(`pr-fetched-${allReviewComments.length}-cr-comments`)

    // Filter to CR-authored comments. Other inline comments (human
    // reviewers, Arc itself) aren't part of the "what did CR miss"
    // exclusion set — they're separate signals.
    const crComments = allReviewComments.filter((c) =>
      typeof c.user?.login === "string" && /^coderabbit/i.test(c.user.login)
    )

    const prompt = buildPrompt({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
      crComments,
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
      console.error("pr-review verdict did not parse", {
        owner,
        repo,
        prNumber,
        responseLength: response.length,
      })
      return
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
  crComments: ReviewComment[]
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
    "[EXISTING CR COMMENTS — DO NOT DUPLICATE]",
  ]

  if (ctx.crComments.length === 0) {
    sections.push("(none — CR has not posted any inline comments on this PR)")
  } else {
    let remaining = LIMITS.crCommentsBlock
    for (const c of ctx.crComments) {
      if (remaining <= 0) {
        sections.push("(more CR comments omitted due to budget)")
        break
      }
      const line = c.line ?? c.original_line ?? "?"
      const body = truncate(c.body ?? "", LIMITS.crCommentBody)
      const block = `--- ${c.path}:${line} (CR comment ${c.id}) ---\n${body}`
      remaining -= block.length
      sections.push(block)
    }
  }

  sections.push("", "[OUTPUT]", "Return only the JSON object. No prose, no Markdown fence.")
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
    if (!path || !Number.isFinite(line) || line <= 0) continue
    if (!headline || !body) continue
    if (!Number.isFinite(scoreRaw) || scoreRaw < 1 || scoreRaw > 5) continue
    const startLineRaw = Number(finding.startLine)
    const validStartLine =
      Number.isFinite(startLineRaw) && startLineRaw > 0 && startLineRaw < line
        ? Math.floor(startLineRaw)
        : null
    const finalFinding: PrReviewFinding = {
      path,
      line: Math.floor(line),
      score: Math.max(1, Math.min(5, Math.round(scoreRaw))),
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
}

/**
 * Translate a parsed verdict into the GitHub review submission body.
 * Approval logic from the max finding score:
 *   - 5  → REQUEST_CHANGES
 *   - 3-4 → COMMENT
 *   - 1-2 (or no findings) → APPROVE
 *
 * Top-level body becomes a sticky summary with confidence + the model's
 * own confidenceReason so a reviewer skimming the PR sees OpenClaw's
 * read at a glance. Pure — exported for tests.
 */
export function buildReviewSubmission({
  verdict,
  prAuthor,
  headSha,
}: BuildReviewArgs): SubmitReviewBody {
  const event = chooseReviewEvent(verdict.findings)
  const body = formatReviewBody(verdict, prAuthor, event)
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

export function chooseReviewEvent(findings: PrReviewFinding[]): ReviewEvent {
  if (findings.length === 0) return "APPROVE"
  let max = 0
  for (const f of findings) {
    if (f.score > max) max = f.score
  }
  if (max >= 5) return "REQUEST_CHANGES"
  if (max >= 3) return "COMMENT"
  return "APPROVE"
}

function formatReviewBody(
  verdict: PrReviewVerdict,
  prAuthor: string | null,
  event: ReviewEvent
): string {
  const lines: string[] = ["<!-- openclaw:pr-review -->"]
  const tag =
    event === "APPROVE"
      ? "READY"
      : event === "REQUEST_CHANGES"
        ? "BLOCKER"
        : "REVIEW"
  lines.push(`⚓ [${tag}] ${verdict.summary}`)
  lines.push("")
  if (event === "APPROVE" && prAuthor && !prAuthor.toLowerCase().includes("[bot]")) {
    if (verdict.findings.length === 0) {
      lines.push(
        `@${prAuthor} — nothing CR missed that I'd hold this on. Approving so you can merge when ready.`
      )
    } else {
      lines.push(
        `@${prAuthor} — flagging the items below for visibility, but none are blockers. Up to you whether to apply.`
      )
    }
    lines.push("")
  } else if (event === "REQUEST_CHANGES" && prAuthor && !prAuthor.toLowerCase().includes("[bot]")) {
    lines.push(`@${prAuthor} — at least one finding below is a blocker. Worth a look before merge.`)
    lines.push("")
  }
  lines.push(`**Confidence:** ${verdict.confidence}/5`)
  if (verdict.confidenceReason) {
    lines.push(verdict.confidenceReason)
  }
  if (verdict.findings.length > 0) {
    lines.push("")
    lines.push(
      `**Findings:** ${verdict.findings.length} (max score ${maxScore(verdict.findings)})`
    )
  }
  return lines.join("\n")
}

function formatFindingComment(finding: PrReviewFinding): string {
  // Inline reply marker so we can detect/dedupe later if needed; also
  // signals to readers that this is OpenClaw's primary-review pass and
  // not a CR comment. Suggestion blocks (when present in body) pass
  // through unchanged so GitHub renders them as one-click apply.
  const lines: string[] = [`<!-- openclaw:pr-review-finding -->`]
  lines.push(`⚓ [score ${finding.score}/5] ${finding.headline}`)
  lines.push("")
  lines.push(finding.body)
  return lines.join("\n")
}

function maxScore(findings: PrReviewFinding[]): number {
  let max = 0
  for (const f of findings) {
    if (f.score > max) max = f.score
  }
  return max
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
