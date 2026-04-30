// Triage pipeline: fetch issue → build prompt → call Ollama Turbo →
// parse verdict → post/update Linear comment + apply priority/estimate/labels.
//
// Logic ported from rema-portal/tools/openclaw/lib/issue-triage.mjs and
// triage-issue.mjs. Adapted for the Linear data model — no GitHub Project
// board surface, no `lib/projects.mjs`, no codebase retrieval (deferred to
// the PR-side worker which still has access to repo checkouts).

import { generate } from "./ollama"
import { LinearClient, estimateToPoints, severityToPriority } from "./linear"
import { getMarker, setMarker } from "./dedupe"
import type { Env } from "../index"
import promptText from "../../prompts/issue-triage.md"

const TRIAGE_MARKER = "<!-- openclaw:issue-triage -->"
const DEFAULT_MODEL = "glm-5.1:cloud"
const MAX_LABELS = 3

const VALID_SEVERITIES = new Set(["P0", "P1", "P2", "P3"])
const VALID_ESTIMATES = new Set(["trivial", "S", "M", "L", "XL"])

const LIMITS = {
  issueBody: 8_000,
}

interface Verdict {
  headline: string
  severity: string
  estimate: string
  labels: string[]
  summary: string
  approach: string
  relevantFiles: string[]
  research: string | undefined
  diagram: string | undefined
}

export async function triageIssue(issueId: string, env: Env): Promise<void> {
  const linear = new LinearClient(env.LINEAR_API_KEY)
  const issue = await linear.getIssue(issueId)
  if (!issue) {
    console.warn("issue not found", { issueId })
    return
  }

  // Skip if our own marker comment is already on the issue. Idempotency
  // guard — Linear retries webhooks on 5xx, and we want re-runs to update
  // not duplicate. The KV marker is the fast path; the comment-body scan
  // is the fallback for cases where KV is missing (cold KV, secret rotation).
  const kvMarker = await getMarker(env.OPENCLAW_STATE, issue.id)
  const existingComment = kvMarker
    ? { id: kvMarker.commentId }
    : issue.comments.nodes.find((c) => c.body.includes(TRIAGE_MARKER)) ?? null

  const prompt = buildPrompt({
    identifier: issue.identifier,
    title: issue.title,
    body: issue.description ?? "",
    author: issue.creator?.displayName ?? issue.creator?.name ?? null,
    labels: issue.labels.nodes.map((l) => l.name),
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    temperature: 0.2,
  })

  const verdict = parseVerdict(response)
  if (!verdict) {
    console.error("verdict did not parse", { issueId, response: response.slice(0, 500) })
    return
  }

  const body = formatComment({ verdict, author: issue.creator?.displayName ?? null })

  let commentId: string
  if (existingComment) {
    await linear.updateComment(existingComment.id, body)
    commentId = existingComment.id
  } else {
    commentId = await linear.createComment(issue.id, body)
  }
  await setMarker(env.OPENCLAW_STATE, issue.id, commentId)

  // Apply priority + estimate + labels on the issue itself. Best-effort —
  // a label apply failure shouldn't block the comment, which is the
  // primary deliverable.
  try {
    const priority = severityToPriority(verdict.severity)
    const estimate = estimateToPoints(verdict.estimate)
    const labelIds = await linear.resolveLabels(issue.team.id, verdict.labels)
    const updates: { priority?: number; estimate?: number; labelIds?: string[] } = {}
    if (priority > 0) updates.priority = priority
    if (typeof estimate === "number") updates.estimate = estimate
    if (labelIds.length > 0) updates.labelIds = labelIds
    if (Object.keys(updates).length > 0) {
      await linear.updateIssue(issue.id, updates)
    }
  } catch (error) {
    console.warn("field apply failed", { issueId, error: String(error) })
  }
}

interface PromptCtx {
  identifier: string
  title: string
  body: string
  author: string | null
  labels: string[]
}

function buildPrompt(ctx: PromptCtx): string {
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    promptText.trim(),
    "",
    "[ISSUE METADATA]",
    `Identifier: ${ctx.identifier}`,
    `Title: ${ctx.title}`,
    `Author: ${ctx.author ?? "(unknown)"}`,
  ]
  if (ctx.labels.length > 0) {
    sections.push(`Existing labels: ${ctx.labels.join(", ")}`)
  }
  sections.push("", "Body:", truncate(ctx.body || "(no description)", LIMITS.issueBody))
  sections.push(
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence, no array."
  )
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

function parseVerdict(text: string): Verdict | null {
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) body = fence[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const headline = typeof obj.headline === "string" ? obj.headline.trim() : ""
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  const approach = typeof obj.approach === "string" ? obj.approach.trim() : ""
  if (!headline || !summary) return null

  const severity = typeof obj.severity === "string" ? obj.severity.toUpperCase() : "P2"
  const estimate = typeof obj.estimate === "string" ? obj.estimate : "S"
  if (!VALID_SEVERITIES.has(severity)) return null
  if (!VALID_ESTIMATES.has(estimate)) return null

  // Cap at MAX_LABELS — the model occasionally returns 6-8 labels which
  // clutters the issue card. Three is the team's preferred ceiling; any
  // more becomes visual noise without adding signal.
  const labels = Array.isArray(obj.labels)
    ? obj.labels
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, MAX_LABELS)
    : []
  const relevantFiles = Array.isArray(obj.relevantFiles)
    ? obj.relevantFiles.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : []
  const research =
    typeof obj.research === "string" && obj.research.trim().length > 0
      ? obj.research.trim()
      : undefined
  const sanitizedDiagram =
    typeof obj.diagram === "string"
      ? obj.diagram
          .trim()
          .replace(/^```(?:mermaid)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .replace(/```+/g, "")
          .trim()
      : ""
  const diagram = sanitizedDiagram.length > 0 ? sanitizedDiagram : undefined

  return { headline, severity, estimate, labels, summary, approach, relevantFiles, research, diagram }
}

interface FormatArgs {
  verdict: Verdict
  author: string | null
}

function formatComment({ verdict, author }: FormatArgs): string {
  const tag = `${verdict.severity} · ${verdict.estimate}`
  const lines: string[] = [TRIAGE_MARKER]
  lines.push(`🦞 [${tag}] ${verdict.headline}`)
  lines.push("")
  if (author && !author.toLowerCase().includes("[bot]")) {
    lines.push(`@${author} — first read on your issue, hope it saves you a few minutes scoping.`)
    lines.push("")
  }
  lines.push(`**Summary:** ${verdict.summary}`)
  if (verdict.approach) {
    lines.push("")
    lines.push(`**Approach:** ${verdict.approach}`)
  }
  if (verdict.relevantFiles.length > 0) {
    lines.push("")
    lines.push("**Relevant files:**")
    for (const path of verdict.relevantFiles) lines.push(`- \`${path}\``)
  }
  if (verdict.research) {
    lines.push("")
    lines.push(`**Prior art / research:** ${verdict.research}`)
  }
  if (verdict.diagram) {
    lines.push("")
    lines.push("```mermaid")
    lines.push(verdict.diagram)
    lines.push("```")
  }
  if (verdict.labels.length > 0) {
    lines.push("")
    lines.push(`_Suggested labels:_ ${verdict.labels.map((l) => `\`${l}\``).join(", ")}`)
  }
  lines.push("")
  lines.push("---")
  lines.push("_Auto-triage. Severity and estimate are best-effort — adjust as you scope the work._")
  return lines.join("\n")
}
