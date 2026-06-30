// SIG-545 B3 / B3b: shared agent-run dispatch core for BOTH the Linear-assignment
// webhook trigger (B3) and the Slack "implement this" intent (B3b). When an issue
// is assigned to the Sigilix agent user (webhook gate in index-webhooks.ts) OR a
// user asks Sigilix in Slack to implement something, the work converges on
// `dispatchTicketImplementation`: it resolves the runner model + per-ticket
// idempotency and dispatches the agent-runner to implement it and open a PR.
//
// SAFE by construction: the run ALWAYS uses the minimal in-container engine
// (`engine: "minimal"`) because this path takes untrusted free-tier input — never
// the full CLI agent. The runner itself stays DARK unless OPENCLAW_AGENT_RUNNER_MODE
// is "on" (dispatchAgentRun's own gate); the webhook trigger is independently gated
// by OPENCLAW_LINEAR_AGENT_RUN_MODE.
//
// FAIL-SAFE: every body is wrapped so a fault is logged + swallowed — the queue
// consumer + the Slack path both rely on this never throwing. NEVER logs model.key /
// tokens / secrets.

import type { Env } from "@/src/shared/types/env"
import { buildLinearClient, buildLinearAgentClient } from "@/src/lib/linear"
import { dispatchAgentRun } from "@/src/lib/agent-runner/dispatch"
import { listTeamRepoMappings, resolveInstallation } from "@/src/shared/adapters/github/github-installation"

/** Ollama Turbo base — the free minimal-engine provider for the B3 trigger. */
const OLLAMA_TURBO_BASE = "https://ollama.com/v1"
/** Default minimal-engine model (Ollama Turbo). model.key is NEVER logged. */
const DEFAULT_MODEL_ID = "glm-5.2:cloud"
/**
 * Per-ticket idempotency window. BEST-EFFORT dedupe (the KV get→put is not atomic
 * and KV is eventually consistent ~60s cross-POP, so two jobs inside that window
 * can still both dispatch): it strongly reduces — but does not strictly prevent —
 * duplicate PRs when the SAME issue is driven more than once. The realistic cases:
 * a webhook retry (Linear redelivers the assignment `Issue.update` on a 5xx), or the
 * same issue id reaching BOTH entry points (the Slack path dispatching directly AND a
 * later assignment-`Issue.update` webhook for that issue also calling runLinearAgentRun
 * — both key the marker on the issue id). NOTE: creating an issue pre-assigned to the
 * agent emits `Issue.create` (handled by the triage branch), NOT the assignment
 * `Issue.update` trigger, so the Slack create itself does not re-enter this path.
 * Strict exactly-once at GA = back this with a Durable Object / D1 unique-insert
 * (atomic compare-and-set). The marker is released on a non-dispatch so a transient
 * failure isn't permanently suppressed.
 */
const AGENT_RUN_DEDUPE_TTL_SECONDS = 3600

/**
 * Shared core used by BOTH the Linear-assignment webhook (`runLinearAgentRun`) and
 * the Slack "implement this" intent (`runImplement`). Owns the per-ticket
 * idempotency, the minimal-engine model build, and the agent-runner dispatch so the
 * two entry points can never drift on safety (engine, caps, model, dedupe).
 *
 * - Per-ticket idempotency: a KV marker `linear-agent-run:${dedupeId}` (1h TTL),
 *   released on a non-dispatch + defensively in the catch so a transient failure
 *   isn't permanently suppressed.
 * - Minimal engine ALWAYS (untrusted free-tier input — never "full").
 * - NEVER logs model.key. NEVER throws — fail-safe to `{ dispatched: false }`.
 */
export async function dispatchTicketImplementation(
  env: Env,
  args: {
    owner: string
    repo: string
    installationId: number
    ticket: { identifier: string; title: string; body: string; url: string }
    dedupeId: string
  },
): Promise<{ dispatched: boolean }> {
  // Declared outside the try so the catch can release the marker if a fault occurs
  // AFTER it was set but before dispatch was confirmed (defends a future edit that
  // throws post-set; today dispatchAgentRun is fail-safe and never throws).
  const dedupeKey = `linear-agent-run:${args.dedupeId}`
  let markerSet = false
  try {
    // Build the runner model — default to Ollama Turbo (the free minimal engine).
    // model.key is NEVER logged. Checked before the marker so a missing key never
    // burns the idempotency window.
    const key = env.OLLAMA_API_KEY
    if (!key) {
      console.warn(
        JSON.stringify({
          event: "linear-agent-run-no-model-key",
          identifier: args.ticket.identifier,
          owner: args.owner,
          repo: args.repo,
        }),
      )
      return { dispatched: false }
    }
    const model = { id: DEFAULT_MODEL_ID, key, baseUrl: OLLAMA_TURBO_BASE }

    // Per-ticket idempotency (check-and-set) — best-effort dedupe of webhook retries
    // + a cross-path double-drive of the same issue id (see the AGENT_RUN_DEDUPE caveat
    // above). The dedupeId is the issue id for both callers, logged as `issueId` to
    // keep the B3 event shape.
    if (await env.OPENCLAW_STATE.get(dedupeKey)) {
      console.log(
        JSON.stringify({
          event: "linear-agent-run-deduped",
          issueId: args.dedupeId,
          identifier: args.ticket.identifier,
        }),
      )
      return { dispatched: false }
    }
    await env.OPENCLAW_STATE.put(dedupeKey, "1", { expirationTtl: AGENT_RUN_DEDUPE_TTL_SECONDS })
    markerSet = true

    const result = await dispatchAgentRun(env, {
      runId: crypto.randomUUID(),
      owner: args.owner,
      repo: args.repo,
      baseBranch: "main",
      installationId: args.installationId,
      ticket: args.ticket,
      // ALWAYS minimal — this path takes untrusted free-tier input. Never "full".
      engine: "minimal",
      model,
      caps: { maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 },
    })

    if (!result.dispatched) {
      // No-op/failed dispatch (runner dark, token mint failed, container fault) —
      // release the idempotency marker so a later retry isn't permanently suppressed.
      await env.OPENCLAW_STATE.delete(dedupeKey)
      markerSet = false
    }
    return { dispatched: result.dispatched }
  } catch (err) {
    // Defensive: a fault after the marker was set (but before a confirmed dispatch)
    // must not suppress the ticket for the whole TTL — release it. Best-effort.
    if (markerSet) {
      try {
        await env.OPENCLAW_STATE.delete(dedupeKey)
      } catch {
        // best-effort
      }
    }
    // Both callers rely on this never throwing out. Log without secrets.
    console.error(
      JSON.stringify({
        event: "linear-agent-run-dispatch-failed",
        issueId: args.dedupeId,
        identifier: args.ticket.identifier,
        error: err instanceof Error ? err.message : String(err),
        // model.key / installation token intentionally excluded
      }),
    )
    return { dispatched: false }
  }
}

/**
 * Implement a Linear issue assigned to the Sigilix agent: resolve the repo +
 * installation, then dispatch the agent-runner (via `dispatchTicketImplementation`)
 * and post a best-effort Linear ack. Never throws — every fault is logged + swallowed.
 *
 * `sessionId` is the AgentSession id when the trigger was an `AgentSessionEvent`
 * (a real agent delegation / @-mention). When present, the dispatch ack is posted as
 * a NON-terminal Linear agent `action` activity into that session (the turn stays open
 * until the container opens the PR); when absent (the interim assignee path), the
 * legacy issue comment ack is used instead.
 */
export async function runLinearAgentRun(issueId: string, env: Env, sessionId?: string): Promise<void> {
  try {
    const linear = await buildLinearClient(env)
    const issue = await linear.getIssue(issueId)
    if (!issue) {
      console.warn(JSON.stringify({ event: "linear-agent-run-issue-not-found", issueId }))
      return
    }

    // Resolve the target GitHub repo from the issue's Linear team.
    const mapping = listTeamRepoMappings(env.OPENCLAW_TEAM_GITHUB_REPO_MAP).find((m) => m.teamKey === issue.team.key)
    if (!mapping) {
      console.warn(
        JSON.stringify({
          event: "linear-agent-run-no-repo-mapping",
          identifier: issue.identifier,
          team: issue.team.key,
        }),
      )
      return
    }

    // Resolve the GitHub App installation for that repo.
    const inst = resolveInstallation(mapping.owner, mapping.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (!inst.ok) {
      console.warn(
        JSON.stringify({
          event: "linear-agent-run-no-installation",
          identifier: issue.identifier,
          owner: mapping.owner,
          repo: mapping.repo,
          reason: inst.reason,
        }),
      )
      return
    }

    const { dispatched } = await dispatchTicketImplementation(env, {
      owner: mapping.owner,
      repo: mapping.repo,
      installationId: inst.installationId,
      ticket: {
        identifier: issue.identifier,
        title: issue.title,
        body: issue.description ?? "",
        url: issue.url,
      },
      dedupeId: issue.id,
    })

    if (dispatched) {
      // Best-effort ack — a failed ack must never fail the run.
      //   - AgentSessionEvent path (sessionId present): post a NON-terminal Linear
      //     agent `action` activity so the session turn STAYS OPEN until the PR
      //     lands. A terminal `response` here would complete the agent turn at
      //     dispatch time — before the container has actually opened the PR.
      //   - interim assignee path (no sessionId): the legacy issue comment ack.
      // TODO(follow-up): thread sessionId → AgentRunTaskInput → container so the
      // container posts the terminal `response` with the real PR URL when the PR lands.
      const ackText = "🛠️ On it — Sigilix is implementing this and will open a PR shortly."
      try {
        if (sessionId) {
          const agent = await buildLinearAgentClient(env)
          if (agent) {
            await agent.createAgentActivity(sessionId, ackText, "action")
          } else {
            console.warn(JSON.stringify({ event: "linear-agent-run-ack-no-token", issueId, sessionId }))
          }
        } else {
          await linear.createComment(issue.id, ackText)
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "linear-agent-run-ack-failed",
            issueId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      console.log(
        JSON.stringify({
          event: "linear-agent-run-dispatched",
          issueId,
          owner: mapping.owner,
          repo: mapping.repo,
          dispatched: true,
          // model.key intentionally excluded
        }),
      )
    }
  } catch (err) {
    // The queue consumer relies on this never throwing out. Log without secrets.
    console.error(
      JSON.stringify({
        event: "linear-agent-run-failed",
        issueId,
        error: err instanceof Error ? err.message : String(err),
        // model.key / installation token intentionally excluded
      }),
    )
  }
}
