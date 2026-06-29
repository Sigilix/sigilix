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
import { dispatchTicketImplementation } from "@/src/lib/linear-agent-run"
import { resolveLinearAgentRunMode } from "@/src/lib/agent-runner/mode"
import { triageIssue } from "@/src/lib/triage"
import { recallSlackMemory, captureSlackMemory } from "@/src/lib/slack/slack-memory"
import type { SlackMemoryScope } from "@/src/lib/slack/slack-memory"
import type { SlackScope } from "@/src/lib/slack/slack-scope"
import { detectSlackIntent, formatSigilixReply } from "@/src/lib/slack/slack-reply"
import {
  getImplementOffer,
  setImplementOffer,
  clearImplementOffer,
  classifyOfferReply,
} from "@/src/lib/slack/slack-implement-offer"
import type { ImplementOffer } from "@/src/lib/slack/slack-implement-offer"
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

/**
 * SIG-545 B3c: Slack-only implementation-offer classifier. A SEPARATE single-shot
 * step (not a mutation of the shared GITHUB_MENTION_SCHEMA, which GitHub mentions
 * reuse) that decides whether the user's ask is a plausibly-implementable change
 * in the codebase and, if so, drafts the offer's plan + ticket title.
 */
const IMPLEMENT_OFFER_SCHEMA = {
  type: "object",
  properties: {
    shouldOffer: { type: "boolean" },
    title: { type: "string" },
    plan: { type: "string" },
  },
  required: ["shouldOffer", "title", "plan"],
} as const satisfies Record<string, unknown>

/**
 * SIG-545 B3c: revise-step output — the grounded re-plan reply shown to the user
 * plus the updated plan (and an optionally-updated title) stored for the next turn.
 */
const IMPLEMENT_REVISE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    plan: { type: "string" },
    title: { type: "string" },
  },
  required: ["reply", "plan"],
} as const satisfies Record<string, unknown>

/** The confirm nudge appended to every offer / re-offer message. */
const OFFER_CONFIRM_NUDGE = "_Reply `@Sigilix yes` to go, or tell me what you'd change._"

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SlackMentionContext {
  scope: SlackScope
  slackUserId: string
  channelId: string
  /** Slack thread id (event.thread_ts ?? event.ts) — the offer's scope key (B3c). */
  threadTs: string
  /** Thread text already fetched, capped, and redacted (Task 8). */
  threadText: string
  /** The ask with the @-mention stripped. */
  mentionText: string
}

export interface SlackAgentResult {
  reply: string
  action:
    | { kind: "qa" }
    | { kind: "linear-triage"; issueUrl: string; identifier: string }
    | { kind: "implement"; issueUrl: string; identifier: string; dispatched: boolean }
    // SIG-545 B3c offer → negotiate → confirm.
    | { kind: "implement-offer" }
    | { kind: "implement-confirm"; issueUrl: string; identifier: string; dispatched: boolean }
    | { kind: "implement-revise" }
    | { kind: "implement-decline" }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Orchestrate the Slack mention: detect intent, run grounded Q&A or create a
 * Linear triage issue, capture memory. Does NOT post to Slack.
 */
export async function runSlackAgent(env: Env, ctx: SlackMentionContext): Promise<SlackAgentResult> {
  const { scope } = ctx
  // scope resolver guarantees repos.length >= 1 for ok:true — throw as an invariant
  // rather than returning a qa success-shape on a caller contract violation.
  const [primary] = scope.repos
  if (!primary) throw new Error("runSlackAgent requires a scoped repo")

  const memScope: SlackMemoryScope = {
    teamId: scope.teamId,
    repoId: `${primary.owner}/${primary.repo}`,
  }

  // B3c: a pending implementation offer in this thread takes precedence over
  // fresh intent detection — a follow-up @mention IS the reply to that offer
  // (a "yes" → confirm, a short "no" → decline, anything else → revise). The
  // whole offer flow ships DARK behind the runner-trigger mode: when it's off the
  // offer UX never surfaces (see runQa), so there is never a pending offer to
  // resolve and routing stays byte-identical to today's qa/triage/implement
  // behavior. Fail-closed: getImplementOffer also returns null on a KV fault.
  if (resolveLinearAgentRunMode(env) === "on") {
    const pendingOffer = await getImplementOffer(env, ctx.channelId, ctx.threadTs)
    if (pendingOffer) {
      return runOfferFollowUp(env, ctx, memScope, primary, pendingOffer)
    }
  }

  const intent = detectSlackIntent(ctx.mentionText)

  if (intent.kind === "implement") {
    return runImplement(env, ctx, memScope, primary)
  }

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

  // Build the GitHub-scoped agent tools for this installation.
  const tools = await buildSlackAgentTools(env, ctx, primary)

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

  // B3c ships DARK behind the runner-trigger mode: with it off we never offer to
  // open a PR (and never spend the extra single-shot model call), so a dark deploy
  // is byte-identical to plain grounded Q&A.
  const offersEnabled = resolveLinearAgentRunMode(env) === "on"

  let reply: string
  let offer: ImplementOffer | null = null
  if (loopResult.ok) {
    const verdict = parseGithubMentionResponse(JSON.stringify(loopResult.answer))
    if (verdict && verdict.answer) {
      // B3c: a SEPARATE single-shot step decides whether the ask is an
      // implementable change and drafts the offer. Keeps the shared
      // GITHUB_MENTION_SCHEMA untouched (GitHub mentions reuse it). Gated DARK
      // behind the runner mode AND skipped on an abstain (an "I don't know"
      // never offers a PR) — and never on a degraded fallback below. When gated
      // off there is NO extra generate() call.
      if (offersEnabled && !verdict.abstain) {
        offer = await maybeBuildImplementOffer(env, ctx, verdict.answer)
      }
      const body = offer ? `${verdict.answer}\n\n${buildOfferBlock(offer.plan)}` : verdict.answer
      reply = formatSigilixReply(body)
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

  // B3c: remember the offer so a follow-up @mention in this thread (a "yes" or a
  // revision) resolves against it. Set only when we actually surfaced an offer.
  if (offer) {
    await setImplementOffer(env, ctx.channelId, ctx.threadTs, offer)
  }

  // Memory capture — non-fatal.
  const captureContent = `asked: ${ctx.mentionText.slice(0, 120)} → ${loopResult.ok ? "answered" : "degraded"}${
    offer ? " (offered PR)" : ""
  }`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return { reply, action: offer ? { kind: "implement-offer" } : { kind: "qa" } }
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

  const { title, description } = await summarizeThreadToIssue(env, ctx)

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

// ─── Implement path (SIG-545 B3b) ──────────────────────────────────────────────

/**
 * The PRIMARY free-tier flow: when a user asks Sigilix in Slack to implement /
 * build something, create a Linear ticket SELF-ASSIGNED to the Sigilix agent user,
 * then dispatch the agent-runner (minimal engine) to implement it + open a PR.
 *
 * SHIPS DARK: dispatch is gated by the runner mode (dispatchTicketImplementation →
 * dispatchAgentRun's own gate). With the runner off, the ticket is still created and
 * the reply degrades to the same "created ticket" form as triage — so a dark deploy
 * still does something useful.
 */
async function runImplement(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  primary: SlackScope["repos"][number],
): Promise<SlackAgentResult> {
  const { scope } = ctx

  if (!scope.linearTeam) {
    const reply = formatSigilixReply(
      "_Linear is not configured for this channel, so I can't open a ticket to implement this. Ask your workspace admin to add a `linearTeam` to the Sigilix scope map._",
    )
    return { reply, action: { kind: "qa" } }
  }

  // Summarize the thread into a Linear issue title + description (same step as triage).
  const { title, description } = await summarizeThreadToIssue(env, ctx)

  // Create the Linear issue, self-assigned to the Sigilix agent user so the free-tier
  // user never has to assign it by hand. assigneeId is omitted when the env is unset.
  const auth = await buildLinearAuth(env)
  const linear = new LinearClient(auth)
  const issue = await linear.createIssue({
    teamId: scope.linearTeam,
    title,
    ...(description ? { description } : {}),
    ...(env.OPENCLAW_LINEAR_AGENT_USER_ID ? { assigneeId: env.OPENCLAW_LINEAR_AGENT_USER_ID } : {}),
  })

  // Dispatch the agent-runner on the minimal engine (shares idempotency + model +
  // dispatch with the B3 webhook path). Dark unless the runner mode is "on".
  const { dispatched } = await dispatchTicketImplementation(env, {
    owner: primary.owner,
    repo: primary.repo,
    installationId: primary.installationId,
    ticket: { identifier: issue.identifier, title, body: description ?? "", url: issue.url },
    dedupeId: issue.id,
  })

  const reply = dispatched
    ? formatSigilixReply(
        `🛠️ Created <${issue.url}|${issue.identifier}> — Sigilix is implementing it; a PR is on the way.`,
      )
    : formatSigilixReply(`Created Linear issue: *<${issue.url}|${issue.identifier}>* — ${title}`)

  // Memory capture — non-fatal.
  const captureContent = `implement: ${title} → ${issue.identifier} (${issue.url}) dispatched=${dispatched}`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return {
    reply,
    action: { kind: "implement", issueUrl: issue.url, identifier: issue.identifier, dispatched },
  }
}

// ─── Offer → negotiate → confirm path (SIG-545 B3c) ─────────────────────────────

/**
 * Resolve a follow-up @mention against a thread's pending offer: an affirmative
 * CONFIRMS (create the ticket + dispatch the runner); a short rejection DECLINES
 * (drop the offer, no model call); anything else is a REVISION (re-plan with
 * judgment + re-offer). Reuses the B3b dispatch core for confirm.
 */
async function runOfferFollowUp(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  primary: SlackScope["repos"][number],
  offer: ImplementOffer,
): Promise<SlackAgentResult> {
  const decision = classifyOfferReply(ctx.mentionText)
  if (decision === "confirm") {
    return runOfferConfirm(env, ctx, memScope, primary, offer)
  }
  if (decision === "decline") {
    // Short rejection ("no", "never mind", …) → drop the offer. No model call,
    // no dispatch — just clear the stored offer so a later @mention starts fresh.
    await clearImplementOffer(env, ctx.channelId, ctx.threadTs)
    const reply = formatSigilixReply("Okay — I'll leave it. Ping me if you change your mind.")
    return { reply, action: { kind: "implement-decline" } }
  }
  return runOfferRevise(env, ctx, memScope, primary, offer)
}

/**
 * Affirmative on a pending offer → EXECUTE: create a self-assigned Linear ticket
 * (body = the agreed plan) + dispatch the agent-runner (minimal engine, B3b), then
 * clear the offer. SHIPS DARK: with the runner off the ticket is still created and
 * the reply degrades to "queued" — a "yes" always does something useful.
 */
async function runOfferConfirm(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  primary: SlackScope["repos"][number],
  offer: ImplementOffer,
): Promise<SlackAgentResult> {
  const { scope } = ctx

  // No Linear team → can't open a ticket. Clear the offer so the thread doesn't
  // re-loop on the same un-actionable "yes".
  if (!scope.linearTeam) {
    await clearImplementOffer(env, ctx.channelId, ctx.threadTs)
    const reply = formatSigilixReply(
      "_Linear is not configured for this channel, so I can't open a ticket to implement this. Ask your workspace admin to add a `linearTeam` to the Sigilix scope map._",
    )
    return { reply, action: { kind: "qa" } }
  }

  // Create the ticket self-assigned to the Sigilix agent user (assigneeId omitted
  // when the env is unset), body = the agreed plan.
  const auth = await buildLinearAuth(env)
  const linear = new LinearClient(auth)
  const issue = await linear.createIssue({
    teamId: scope.linearTeam,
    title: offer.title,
    description: offer.plan,
    ...(env.OPENCLAW_LINEAR_AGENT_USER_ID ? { assigneeId: env.OPENCLAW_LINEAR_AGENT_USER_ID } : {}),
  })

  // Dispatch the agent-runner (minimal engine, shared B3b core). Dark unless the
  // runner mode is "on" — then dispatched=false and the reply degrades to "queued".
  const { dispatched } = await dispatchTicketImplementation(env, {
    owner: primary.owner,
    repo: primary.repo,
    installationId: primary.installationId,
    ticket: { identifier: issue.identifier, title: offer.title, body: offer.plan, url: issue.url },
    dedupeId: issue.id,
  })

  const reply = dispatched
    ? formatSigilixReply(`On it 🛠️ — implementing this; PR incoming, tracked in <${issue.url}|${issue.identifier}>.`)
    : formatSigilixReply(`Created <${issue.url}|${issue.identifier}> — queued.`)

  // Offer resolved — clear it so a later @mention starts fresh.
  await clearImplementOffer(env, ctx.channelId, ctx.threadTs)

  // Memory capture — non-fatal.
  const captureContent = `implement-confirm: ${offer.title} → ${issue.identifier} (${issue.url}) dispatched=${dispatched}`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return {
    reply,
    action: { kind: "implement-confirm", issueUrl: issue.url, identifier: issue.identifier, dispatched },
  }
}

/**
 * A counter-proposal on a pending offer → RE-PLAN with judgment: run the grounded
 * agent loop with the current plan + the user's revision and a prompt to reiterate
 * the revision, then ADOPT it or PUSH BACK with reasons grounded in the actual
 * code. Updates the stored plan + re-offers. NEVER dispatches.
 */
async function runOfferRevise(
  env: Env,
  ctx: SlackMentionContext,
  memScope: SlackMemoryScope,
  primary: SlackScope["repos"][number],
  offer: ImplementOffer,
): Promise<SlackAgentResult> {
  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  const commentId = `slack:${ctx.channelId}:${ctx.slackUserId}`

  const tools = await buildSlackAgentTools(env, ctx, primary)
  const initialUserMessage = buildReviseUserMessage(ctx, offer)

  const loopResult = await runAgentLoop({
    model,
    apiKey: env.OLLAMA_API_KEY,
    env,
    surface: "slack-mention",
    commentId,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    initialUserMessage,
    tools,
    finalAnswerSchema: IMPLEMENT_REVISE_SCHEMA as unknown as Record<string, unknown>,
    telemetry: makeKvTelemetrySink(env.OPENCLAW_STATE),
    telemetryContext: {
      singleShotPrompt: "",
      singleShotSchema: IMPLEMENT_REVISE_SCHEMA as unknown as Record<string, unknown>,
      promptBuilderVersion: "slack-agent-v1",
      promptBuilderSource: AGENT_SYSTEM_PROMPT,
    },
    log: () => {
      // no-op — the Slack path has no per-event sink yet
    },
  })

  // Parse the re-plan. On any failure keep the prior plan/title so the loop can
  // continue rather than dropping the offer.
  const revised = loopResult.ok ? parseReviseAnswer(loopResult.answer) : null
  const newPlan = revised?.plan?.trim() || offer.plan
  const newTitle = revised?.title?.trim() || offer.title
  const modelReply = revised?.reply?.trim()

  // Persist the (possibly unchanged) offer so the next @mention resolves against it.
  await setImplementOffer(env, ctx.channelId, ctx.threadTs, { plan: newPlan, title: newTitle })

  const planChanged = newPlan !== offer.plan
  // A real re-plan = the loop succeeded AND the model either narrated a reply or
  // actually changed the plan. An ok-but-empty answer (no reply, no new plan) is
  // treated like the degraded branch — the plan is UNCHANGED.
  const isRealReplan = loopResult.ok && Boolean(modelReply || planChanged)

  let reply: string
  if (isRealReplan) {
    // Only claim "Updated the plan" when the plan genuinely changed (never on an
    // ok-but-empty answer where newPlan falls back to the old plan).
    const body = modelReply && modelReply.length > 0 ? modelReply : `Updated the plan:\n${newPlan}`
    reply = formatSigilixReply(ensureConfirmNudge(body))
  } else {
    // Degraded (loop failed) OR ok-but-empty (no reply AND no new plan) — the plan
    // is UNCHANGED. Never read as authoritative and never claim an update that
    // didn't happen (mirrors runQa).
    reply = formatSigilixReply(
      ensureConfirmNudge("_I couldn't re-plan that right now — the plan is unchanged. Try again in a moment._"),
      { provenance: "degraded" },
    )
  }

  // Memory capture — non-fatal.
  const captureContent = `implement-revise: ${newTitle}${isRealReplan ? "" : " (degraded)"}`
  await captureSlackMemory(env, memScope, { kind: "task_state", content: captureContent }).catch(() => {})

  return { reply, action: { kind: "implement-revise" } }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Summarize the Slack thread into a Linear issue `{ title, description }` via the
 * model. Shared by the triage + implement paths so the LLM-call shape never drifts.
 * Falls back to the (truncated) mention text as the title when the model output
 * can't be parsed.
 */
async function summarizeThreadToIssue(
  env: Env,
  ctx: SlackMentionContext,
): Promise<{ title: string; description: string | undefined }> {
  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
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
  return { title, description }
}

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

// ─── B3c offer helpers ─────────────────────────────────────────────────────────

/**
 * Build the GitHub-scoped agent tools for this Slack mention's installation.
 * Shared by the qa path and the B3c revise path so the tool wiring never drifts.
 */
async function buildSlackAgentTools(
  env: Env,
  ctx: SlackMentionContext,
  primary: SlackScope["repos"][number],
): Promise<ReturnType<typeof createAgentTools>> {
  const githubClient = await buildClient(env, primary.installationId)
  return createAgentTools({
    env,
    surface: "slack-mention",
    github: {
      githubClient,
      allowedRepos: ctx.scope.repos.map((r) => ({ owner: r.owner, repo: r.repo })),
      defaultRef: "main",
      installationId: primary.installationId,
    },
  })
}

/** The offer block appended to a grounded answer when an implementable change is detected. */
function buildOfferBlock(plan: string): string {
  return `🔧 *I can open a PR for this.* Plan:\n${plan}\n\n${OFFER_CONFIRM_NUDGE}`
}

/** Ensure a revise reply ends with the confirm nudge (model may omit it). */
function ensureConfirmNudge(body: string): string {
  const trimmed = body.trim()
  if (trimmed.includes("@Sigilix yes")) return trimmed
  return `${trimmed}\n\n${OFFER_CONFIRM_NUDGE}`
}

/**
 * Decide whether the grounded Q&A ask is a plausibly-implementable change and, if
 * so, draft an offer ({ plan, title }) via a SEPARATE single-shot step. Soft-fails
 * to null on any error / a no-offer decision — the offer is purely additive, so a
 * failure just means the user gets the plain answer.
 */
async function maybeBuildImplementOffer(
  env: Env,
  ctx: SlackMentionContext,
  answer: string,
): Promise<ImplementOffer | null> {
  try {
    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    const { text } = await generate({
      model,
      prompt: buildImplementOfferPrompt(ctx.mentionText, ctx.threadText, answer),
      apiKey: env.OLLAMA_API_KEY,
      format: IMPLEMENT_OFFER_SCHEMA as unknown as Record<string, unknown>,
    })
    const parsed = parseImplementOffer(text)
    if (!parsed || !parsed.shouldOffer) return null
    const plan = parsed.plan.trim()
    const title = parsed.title.trim()
    if (!plan || !title) return null
    return { plan, title }
  } catch {
    return null
  }
}

function buildImplementOfferPrompt(mentionText: string, threadText: string, answer: string): string {
  const parts = [
    "You just answered a teammate's question about THIS codebase (the answer is below).",
    "Decide whether their ask is something Sigilix could IMPLEMENT as a code change in this repo",
    "(a feature, fix, or refactor) — NOT a pure question, discussion, or something already done.",
    "Only offer when implementing it is plausible AND clearly scoped from the conversation.",
    "Return JSON only, no prose, no markdown fence.",
    "",
    "[USER ASK]",
    mentionText,
    "",
  ]
  if (threadText) {
    parts.push("[SLACK THREAD]", threadText, "")
  }
  parts.push(
    "[YOUR ANSWER]",
    answer,
    "",
    "[OUTPUT]",
    'If implementable: {"shouldOffer": true, "title": "<short ticket title>", "plan": "<concise step-by-step plan, e.g. x / y / z>"}',
    'Otherwise: {"shouldOffer": false, "title": "", "plan": ""}',
  )
  return parts.join("\n")
}

interface ParsedImplementOffer {
  shouldOffer: boolean
  title: string
  plan: string
}

function parseImplementOffer(text: string): ParsedImplementOffer | null {
  let raw = text.trim()
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) raw = fence[1].trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const shouldOffer = obj.shouldOffer === true
    const title = typeof obj.title === "string" ? obj.title : ""
    const plan = typeof obj.plan === "string" ? obj.plan : ""
    return { shouldOffer, title, plan }
  } catch {
    return null
  }
}

function buildReviseUserMessage(ctx: SlackMentionContext, offer: ImplementOffer): string {
  const lines: string[] = []
  lines.push("[CONTEXT] You previously offered to open a PR for this thread. Current plan:", offer.plan, "")
  lines.push("[USER REVISION]", ctx.mentionText, "")
  if (ctx.threadText) {
    lines.push("[THREAD CONTEXT — recent Slack messages, oldest first]", ctx.threadText, "")
  }
  lines.push(
    "[TASK]",
    "1. Reiterate the user's revision in one line so they know you understood it.",
    "2. Use your tools to ground your judgment in the ACTUAL code, then EITHER adopt the",
    '   revision ("good call — …") OR push back with reasons grounded in specific files/symbols',
    '   ("I\'d keep it as-is because <file> …").',
    "3. Produce the UPDATED plan reflecting your decision.",
    "",
    'Final answer JSON: {"reply": "<your message to the user>", "plan": "<updated step-by-step plan>", "title": "<short ticket title>"}',
  )
  return lines.join("\n")
}

interface ParsedReviseAnswer {
  reply: string
  plan: string
  title: string
}

function parseReviseAnswer(answer: unknown): ParsedReviseAnswer | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null
  const obj = answer as Record<string, unknown>
  const reply = typeof obj.reply === "string" ? obj.reply : ""
  const plan = typeof obj.plan === "string" ? obj.plan : ""
  const title = typeof obj.title === "string" ? obj.title : ""
  return { reply, plan, title }
}
