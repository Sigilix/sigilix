// SIG-196: Slack agent core — intent detection, grounded Q&A (via agent loop),
// Linear-triage creation, and per-interaction memory capture.
//
// This module does NOT post to Slack — the route layer does that. Keeping
// the orchestration here keeps it fully testable without a Slack connection.

import { generate } from "@/src/shared/adapters/model"
import { GITHUB_MENTION_SCHEMA } from "@/src/shared/domain/schemas"
import { AGENT_SYSTEM_PROMPT } from "@/src/prompts/agent-system"
import { runAgentLoop } from "@/src/lib/agent-loop"
import { createAgentTools } from "@/src/lib/agent-tools"
import { makeKvTelemetrySink } from "@/src/lib/agent-telemetry-kv"
import { buildClient, parseGithubMentionResponse } from "@/src/lib/github-mention"
import { buildLinearAuth, LinearClient } from "@/src/lib/linear"
import { triageIssue } from "@/src/lib/triage"
import { recallSlackMemory, captureSlackMemory } from "@/src/lib/slack/slack-memory"
import type { SlackMemoryScope } from "@/src/lib/slack/slack-memory"
import type { SlackScope } from "@/src/lib/slack/slack-scope"
import { detectSlackIntent, formatSigilixReply } from "@/src/lib/slack/slack-reply"
import type { Env } from "@/src/shared/types/env"

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "glm-5.1:cloud"

/** Schema for the linear-triage summarization step. */
const TRIAGE_SUMMARIZE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
  },
  required: ["title", "description"],
} as const satisfies Record<string, unknown>

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SlackMentionContext {
  scope: SlackScope
  slackUserId: string
  channelId: string
  /** Thread text already fetched, capped, and redacted (Task 8). */
  threadText: string
  /** The ask with the @-mention stripped. */
  mentionText: string
}

export interface SlackAgentResult {
  reply: string
  action: { kind: "qa" } | { kind: "linear-triage"; issueUrl: string; identifier: string }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Orchestrate the Slack mention: detect intent, run grounded Q&A or create a
 * Linear triage issue, capture memory. Does NOT post to Slack.
 */
export async function runSlackAgent(env: Env, ctx: SlackMentionContext): Promise<SlackAgentResult> {
  const { scope } = ctx
  const primary = scope.repos[0]

  // primary must exist (scope resolver guarantees repos.length >= 1 for ok:true)
  if (!primary) {
    return {
      reply: formatSigilixReply(
        "I'm not configured with a repo for this channel. Ask your workspace admin to set up the Sigilix scope map.",
      ),
      action: { kind: "qa" },
    }
  }

  const memScope: SlackMemoryScope = {
    teamId: scope.teamId,
    repoId: `${primary.owner}/${primary.repo}`,
  }

  const intent = detectSlackIntent(ctx.mentionText)

  if (intent.kind === "linear-triage") {
    return runLinearTriage(env, ctx, memScope, primary)
  }

  return runQa(env, ctx, memScope, primary)
}

// ─── Q&A path ────────────────────────────────────────────────────────────────

async function runQa(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  primary: SlackScope["repos"][number],
): Promise<SlackAgentResult> {
  // Recall relevant prior context — soft-fails to [] on error.
  const recalled = await recallSlackMemory(env, memScope, ctx.mentionText)

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  const commentId = `slack:${ctx.channelId}:${ctx.slackUserId}`

  // Build the GitHub client scoped to this installation.
  const githubClient = await buildClient(env, primary.installationId)

  const tools = createAgentTools({
    env,
    surface: "slack-mention",
    github: {
      githubClient,
      allowedRepos: ctx.scope.repos.map((r) => ({ owner: r.owner, repo: r.repo })),
      defaultRef: "main",
      installationId: primary.installationId,
    },
  })

  const initialUserMessage = buildInitialUserMessage(ctx, recalled)

  const loopResult = await runAgentLoop({
    model,
    apiKey: env.OLLAMA_API_KEY,
    env,
    surface: "slack-mention",
    commentId,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    initialUserMessage,
    tools,
    finalAnswerSchema: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
    telemetry: makeKvTelemetrySink(env.OPENCLAW_STATE),
    telemetryContext: {
      singleShotPrompt: "",
      singleShotSchema: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
      promptBuilderVersion: "slack-agent-v1",
      promptBuilderSource: AGENT_SYSTEM_PROMPT,
    },
    log: () => {
      // no-op — the Slack path has no per-event sink yet
    },
  })

  let reply: string
  if (loopResult.ok) {
    const verdict = parseGithubMentionResponse(JSON.stringify(loopResult.answer))
    if (verdict && verdict.answer) {
      reply = formatSigilixReply(verdict.answer)
    } else {
      reply = formatSigilixReply("_I couldn't parse a grounded answer. Try rephrasing your question._", {
        provenance: "degraded",
      })
    }
  } else {
    // Fallback is explicitly degraded — never reads as authoritative.
    reply = formatSigilixReply("_I wasn't able to ground an answer for this right now. Try again in a moment._", {
      provenance: "degraded",
    })
  }

  // Memory capture — non-fatal.
  const captureContent = `asked: ${ctx.mentionText.slice(0, 120)} → ${loopResult.ok ? "answered" : "degraded"}`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return { reply, action: { kind: "qa" } }
}

// ─── Linear-triage path ───────────────────────────────────────────────────────

async function runLinearTriage(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  _primary: SlackScope["repos"][number],
): Promise<SlackAgentResult> {
  const { scope } = ctx

  if (!scope.linearTeam) {
    const reply = formatSigilixReply(
      "_Linear triage is not configured for this channel. Ask your workspace admin to add a `linearTeam` to the Sigilix scope map._",
    )
    return { reply, action: { kind: "qa" } }
  }

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL

  // Summarize the thread into a Linear issue title + description.
  const summarizePrompt = buildTriageSummarizePrompt(ctx.mentionText, ctx.threadText)
  const { text: summaryText } = await generate({
    model,
    prompt: summarizePrompt,
    apiKey: env.OLLAMA_API_KEY,
    format: TRIAGE_SUMMARIZE_SCHEMA as unknown as Record<string, unknown>,
  })

  const summary = parseTriageSummary(summaryText)
  const title = summary?.title ?? ctx.mentionText.slice(0, 100)
  const description = summary?.description

  // Create the Linear issue.
  const auth = await buildLinearAuth(env)
  const linear = new LinearClient(auth)
  const issue = await linear.createIssue({
    teamId: scope.linearTeam,
    title,
    ...(description ? { description } : {}),
  })

  // Run the triage pipeline on the new issue (non-blocking failure is fine —
  // the issue is already created; triage enriches it).
  await triageIssue(issue.id, env).catch((e: unknown) => {
    console.warn("[slack-agent] triageIssue failed (issue already created)", {
      issueId: issue.id,
      error: String(e),
    })
  })

  const reply = formatSigilixReply(`Created Linear issue: *<${issue.url}|${issue.identifier}>* — ${title}`)

  // Memory capture — non-fatal.
  const captureContent = `linear-triage: ${title} → ${issue.identifier} (${issue.url})`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return {
    reply,
    action: { kind: "linear-triage", issueUrl: issue.url, identifier: issue.identifier },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildInitialUserMessage(ctx: SlackMentionContext, recalled: string[]): string {
  const lines: string[] = []
  lines.push("[QUESTION]", ctx.mentionText, "")

  if (ctx.threadText) {
    lines.push("[THREAD CONTEXT — recent Slack messages, oldest first]", ctx.threadText, "")
  }

  if (recalled.length > 0) {
    lines.push("[Relevant prior context (Sigilix memory)]", recalled.join("\n---\n"), "")
  }

  lines.push("Use your tools to gather codebase context. Final answer is the JSON shape defined by the system prompt.")
  return lines.join("\n")
}

function buildTriageSummarizePrompt(mentionText: string, threadText: string): string {
  const parts = [
    "Summarize the following Slack thread as a Linear issue.",
    "Return JSON only, no prose, no markdown fence.",
    "",
    "[USER REQUEST]",
    mentionText,
    "",
  ]
  if (threadText) {
    parts.push("[SLACK THREAD]", threadText, "")
  }
  parts.push(
    "[OUTPUT]",
    'Return: {"title": "<short descriptive issue title>", "description": "<1-2 paragraph description>"}',
  )
  return parts.join("\n")
}

interface TriageSummary {
  title: string
  description: string | undefined
}

function parseTriageSummary(text: string): TriageSummary | null {
  let raw = text.trim()
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) raw = fence[1].trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const title = typeof obj.title === "string" ? obj.title.trim() : ""
    if (!title) return null
    const description = typeof obj.description === "string" ? obj.description.trim() : undefined
    return { title, description: description || undefined }
  } catch {
    return null
  }
}
