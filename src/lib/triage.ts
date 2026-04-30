// Triage pipeline: fetch issue → build prompt → call Ollama Turbo →
// parse verdict → post/update Linear comment + apply priority/estimate/labels.
//
// Logic ported from rema-portal/tools/openclaw/lib/issue-triage.mjs and
// triage-issue.mjs. Adapted for the Linear data model — no GitHub Project
// board surface, no `lib/projects.mjs`, no codebase retrieval (deferred to
// the PR-side worker which still has access to repo checkouts).

import { generate } from "./ollama"
import { LinearClient, estimateToPoints, severityToPriority } from "./linear"
import { getAppActorToken } from "./linear-oauth"
import { getMarker, setMarker } from "./dedupe"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import type { Env } from "../index"
import { ISSUE_TRIAGE_PROMPT } from "../prompts/issue-triage"

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
  improvedDescription: string | undefined
}

export async function triageIssue(issueId: string, env: Env): Promise<void> {
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[triage] ${label} +${Date.now() - t0}ms`, { issueId })
  }

  since("start")
  const linear = new LinearClient(await buildAuth(env))
  since("auth-ready")

  const issue = await linear.getIssue(issueId)
  since("issue-fetched")
  if (!issue) {
    console.warn("issue not found", { issueId })
    return
  }

  // Idempotency guard — Linear retries webhooks on 5xx, and we want re-runs
  // to edit the existing comment instead of duplicating. Dedupe is KV-only
  // since Linear renders HTML comments as visible text, ruling out the
  // marker-in-body fallback the GitHub original used. KV is durable; the
  // worst-case cost of a cold cache is a single duplicate comment that an
  // operator can delete.
  const kvMarker = await getMarker(env.OPENCLAW_STATE, issue.id)
  const existingComment = kvMarker ? { id: kvMarker.commentId } : null

  // Retrieve codebase chunks before building the prompt. Soft-fails to
  // empty when Vectorize is unconfigured / empty / the team has no
  // mapped repo — the model is instructed in the prompt to abstain
  // from inventing file references when no chunks are present.
  const retrievalText = `${issue.title}\n\n${issue.description ?? ""}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: issue.team?.key ?? null,
    env,
  })
  since("retrieval-done")

  const prompt = buildPrompt({
    identifier: issue.identifier,
    title: issue.title,
    body: issue.description ?? "",
    author: issue.creator?.displayName ?? issue.creator?.name ?? null,
    labels: issue.labels.nodes.map((l) => l.name),
    codebaseChunks: formatChunksForPrompt(chunks),
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  since("ollama-start")
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    temperature: 0.2,
  })
  since("ollama-done")

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
  since("comment-posted")

  // Apply priority + estimate + labels + rewritten description on the issue
  // itself. Best-effort — a single field failure shouldn't block the comment,
  // which is the primary deliverable. The description rewrite is the most
  // destructive of these (overwrites human-authored content), so we run media
  // preservation on it before committing.
  try {
    const priority = severityToPriority(verdict.severity)
    const estimate = estimateToPoints(verdict.estimate)
    const labelIds = await linear.resolveLabels(issue.team.id, verdict.labels)
    const updates: {
      priority?: number
      estimate?: number
      labelIds?: string[]
      description?: string
    } = {}
    if (priority > 0) updates.priority = priority
    if (typeof estimate === "number") updates.estimate = estimate
    if (labelIds.length > 0) updates.labelIds = labelIds
    if (verdict.improvedDescription) {
      updates.description = preserveMedia(verdict.improvedDescription, issue.description ?? "")
    }
    if (Object.keys(updates).length > 0) {
      await linear.updateIssue(issue.id, updates)
    }
    since("fields-applied")
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
  codebaseChunks: string | null
}

function buildPrompt(ctx: PromptCtx): string {
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    ISSUE_TRIAGE_PROMPT.trim(),
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
  if (ctx.codebaseChunks) {
    sections.push(
      "",
      "[RELEVANT CODEBASE CHUNKS (semantic similarity to issue body)]",
      "Verify each is actually relevant before citing — retrieval can return false positives.",
      "",
      ctx.codebaseChunks
    )
  }
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

  const improvedDescription =
    typeof obj.improvedDescription === "string" && obj.improvedDescription.trim().length > 0
      ? obj.improvedDescription.trim()
      : undefined

  return {
    headline,
    severity,
    estimate,
    labels,
    summary,
    approach,
    relevantFiles,
    research,
    diagram,
    improvedDescription,
  }
}

/**
 * Build the auth credential the LinearClient uses. Prefers OAuth client_credentials
 * (gives bot identity in comment author) and falls back to a personal API key
 * when OAuth isn't configured. Personal-key mode posts comments under the
 * human owner of the key, which is fine for dev/setup but not the prod path.
 */
async function buildAuth(env: Env): Promise<{ apiKey: string } | { oauthToken: string }> {
  if (env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET) {
    const token = await getAppActorToken(
      env.OPENCLAW_STATE,
      env.LINEAR_OAUTH_CLIENT_ID,
      env.LINEAR_OAUTH_CLIENT_SECRET
    )
    return { oauthToken: token }
  }
  return { apiKey: env.LINEAR_API_KEY }
}

/**
 * Extract image / video URLs from the original issue description so we can
 * preserve them across a rewrite. The model is instructed to keep media
 * inline, but we extract here as a defense-in-depth step — if the model
 * drops a URL we append it under "## Reference media".
 *
 * Pulls canonical URLs only — never raw HTML/markdown fragments. A hostile
 * issue body could embed `<img onerror="…">` and we must not replay the
 * attacker's HTML attributes back into the rewrite. The URL alone is safe.
 */
function extractMediaUrls(body: string): string[] {
  if (!body) return []
  const matches = body.match(/https?:\/\/[^\s)"'<>]+/g) ?? []
  const mediaPattern =
    /uploads\.linear\.app|user-images\.githubusercontent\.com|github\.com\/user-attachments|\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)(?:[?#]|$)/i
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of matches) {
    if (!mediaPattern.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Apply media-preservation to a rewritten description. Any media URL from
 * the original that the model didn't carry forward gets appended under a
 * "## Reference media" section. Returns the rewrite unchanged if no media
 * needs preserving.
 */
function preserveMedia(rewrite: string, originalBody: string): string {
  const media = extractMediaUrls(originalBody)
  if (media.length === 0) return rewrite
  const missing = media.filter((url) => !rewrite.includes(url))
  if (missing.length === 0) return rewrite
  return `${rewrite}\n\n## Reference media\n\n${missing.map((u) => `- ${u}`).join("\n")}\n`
}

interface FormatArgs {
  verdict: Verdict
  author: string | null
}

function formatComment({ verdict, author }: FormatArgs): string {
  const tag = `${verdict.severity} · ${verdict.estimate}`
  const lines: string[] = []
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
  return lines.join("\n")
}
