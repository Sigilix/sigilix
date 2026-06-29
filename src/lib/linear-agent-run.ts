// SIG-545 B3: queue consumer for the Linear-assignment trigger. When an issue
// is assigned to the Sigilix agent user (webhook gate in index-webhooks.ts), this
// resolves the target GitHub repo + installation and dispatches the agent-runner
// to implement it and open a PR.
//
// SAFE by construction: the run ALWAYS uses the minimal in-container engine
// (`engine: "minimal"`) because this path takes untrusted free-tier input — never
// the full CLI agent. The runner itself stays DARK unless OPENCLAW_AGENT_RUNNER_MODE
// is "on" (dispatchAgentRun's own gate); the webhook trigger is independently gated
// by OPENCLAW_LINEAR_AGENT_RUN_MODE.
//
// FAIL-SAFE: the whole body is wrapped so a fault is logged + swallowed — the queue
// consumer relies on this never throwing. NEVER logs model.key / tokens / secrets.

import type { Env } from "@/src/shared/types/env"
import { LinearClient, buildLinearAuth } from "@/src/lib/linear"
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
 * duplicate PRs from a webhook retry (Linear redelivers on 5xx) or the Slack path
 * self-assigning (which ALSO fires the assignment webhook). Strict exactly-once at
 * GA = back this with a Durable Object / D1 unique-insert (atomic compare-and-set).
 * The marker is released on a non-dispatch so a transient failure isn't permanently
 * suppressed.
 */
const AGENT_RUN_DEDUPE_TTL_SECONDS = 3600

/**
 * Implement a Linear issue assigned to the Sigilix agent: resolve the repo +
 * installation, then dispatch the agent-runner on the minimal engine and post a
 * best-effort Linear ack. Never throws — every fault is logged + swallowed.
 */
export async function runLinearAgentRun(issueId: string, env: Env): Promise<void> {
  // Declared outside the try so the catch can release the marker if a fault occurs
  // AFTER it was set but before dispatch was confirmed (defends a future edit that
  // throws post-set; today dispatchAgentRun is fail-safe and never throws).
  const dedupeKey = `linear-agent-run:${issueId}`
  let markerSet = false
  try {
    const linear = new LinearClient(await buildLinearAuth(env))
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

    // Build the runner model — default to Ollama Turbo (the free minimal engine).
    // model.key is NEVER logged.
    const key = env.OLLAMA_API_KEY
    if (!key) {
      console.warn(
        JSON.stringify({
          event: "linear-agent-run-no-model-key",
          identifier: issue.identifier,
          owner: mapping.owner,
          repo: mapping.repo,
        }),
      )
      return
    }
    const model = { id: DEFAULT_MODEL_ID, key, baseUrl: OLLAMA_TURBO_BASE }

    // Per-ticket idempotency (check-and-set) — best-effort dedupe of webhook retries
    // + the Slack self-assign double-fire (see the AGENT_RUN_DEDUPE caveat above).
    if (await env.OPENCLAW_STATE.get(dedupeKey)) {
      console.log(JSON.stringify({ event: "linear-agent-run-deduped", issueId, identifier: issue.identifier }))
      return
    }
    await env.OPENCLAW_STATE.put(dedupeKey, "1", { expirationTtl: AGENT_RUN_DEDUPE_TTL_SECONDS })
    markerSet = true

    const result = await dispatchAgentRun(env, {
      runId: crypto.randomUUID(),
      owner: mapping.owner,
      repo: mapping.repo,
      baseBranch: "main",
      installationId: inst.installationId,
      ticket: {
        identifier: issue.identifier,
        title: issue.title,
        body: issue.description ?? "",
        url: issue.url,
      },
      // ALWAYS minimal — this path takes untrusted free-tier input. Never "full".
      engine: "minimal",
      model,
      caps: { maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 },
    })

    if (result.dispatched) {
      // Best-effort ack — a failed comment must never fail the run.
      try {
        await linear.createComment(issue.id, "🛠️ On it — Sigilix is implementing this and will open a PR shortly.")
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
    } else {
      // No-op/failed dispatch (runner dark, token mint failed, container fault) —
      // release the idempotency marker so a later retry isn't permanently suppressed.
      await env.OPENCLAW_STATE.delete(dedupeKey)
      markerSet = false
    }
  } catch (err) {
    // Defensive: a fault after the marker was set (but before a confirmed dispatch)
    // must not suppress the issue for the whole TTL — release it. Best-effort.
    if (markerSet) {
      try {
        await env.OPENCLAW_STATE.delete(dedupeKey)
      } catch {
        // best-effort
      }
    }
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
