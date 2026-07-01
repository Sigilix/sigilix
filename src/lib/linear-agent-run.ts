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
import { buildLinearClient, buildLinearAgentClient, type AgentActivityType } from "@/src/lib/linear"
import { dispatchAgentRun, type AgentRunOutcome } from "@/src/lib/agent-runner/dispatch"
import { listTeamRepoMappings, resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { isAgentSessionCancelled } from "@/src/lib/linear-agent-cancel"

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
): Promise<{ dispatched: boolean; outcome?: AgentRunOutcome; deduped?: boolean }> {
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
      // SIG-145: flag the dedupe so the AgentSession caller does NOT post a terminal
      // activity — a concurrent/earlier run owns this issue's session and will resolve
      // it. Resolving here (e.g. a webhook redelivery) would close the live session
      // with a misleading result while the real run is still working.
      return { dispatched: false, deduped: true }
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
    // SIG-145: surface the container's run outcome (PR link / failure) to the caller
    // so `runLinearAgentRun` can post a TERMINAL Linear agent-session activity that
    // resolves the session, instead of leaving it stuck on "Working" forever. A
    // non-deduped non-dispatch (dark/no-key/container fault) reports no outcome — the
    // caller posts a generic resolving activity for it.
    return { dispatched: result.dispatched, ...(result.outcome !== undefined ? { outcome: result.outcome } : {}) }
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
 * and post a best-effort Linear result. Never throws — every fault is logged + swallowed.
 *
 * `sessionId` is the AgentSession id when the trigger was an `AgentSessionEvent` (a real
 * agent delegation / @-mention, including the `prompted` follow-up turn — which re-enters
 * here with the same sessionId). `dispatchTicketImplementation` → `dispatchAgentRun`
 * AWAITS the container's full clone→edit→PR run, so by the time it returns the outcome
 * already carries the real PR URL (or the failure). SIG-145: when a sessionId is present
 * we post a TERMINAL Linear agent activity for that outcome — `response` with the PR link
 * on success, `error` on failure — so the session resolves out of "Working" instead of
 * hanging forever. Without it the session never left the spinner: the only activities ever
 * posted were the webhook `thought` ACK and a non-terminal `action`. When no sessionId is
 * present (the interim assignee path) the legacy issue comment ack is used instead.
 *
 * STOP/CANCEL (SIG-145): a user Stop marks the session cancelled (see linear-agent-cancel.ts);
 * this run checks that flag at its checkpoints (pre-start, before dispatching the container,
 * and before the terminal post) and aborts — it does not dispatch and does not post its own
 * completion (the webhook's stop handler already posted the terminal "stopped" activity). It
 * cannot interrupt an already-running container, so a stop that lands mid-container may still
 * open the PR — but the session stays resolved as "stopped" because the run skips its "Done".
 *
 * KNOWN LIMITATION (the per-ticket idempotency window): the terminal post is SKIPPED on a
 * dedupe (`deduped`) — correct for a webhook redelivery of THIS turn (a concurrent/earlier
 * run owns + resolves the session). But the dedupe marker is keyed on the issue id with a
 * 1h TTL, so a genuinely-new turn on the SAME issue inside that window (e.g. a `prompted`
 * follow-up shortly after the first PR) also dedupes and is NOT re-posted — that session can
 * still hang until the window expires. A precise fix needs a per-delivery idempotency key
 * (so a redelivery is distinguishable from a new turn); tracked as a follow-up, deliberately
 * NOT widened here because posting on every dedupe would reintroduce the redelivery
 * double-resolve race this fix is careful to avoid.
 */
export async function runLinearAgentRun(issueId: string, env: Env, sessionId?: string): Promise<void> {
  try {
    // Checkpoint 0 (stop): cancelled before we start any work → abort, post nothing. The
    // webhook's stop handler already posted the terminal "stopped" activity. Best-effort:
    // a KV miss fails open to "not cancelled" (the work proceeds; the webhook still
    // resolved the session).
    if (sessionId && (await isAgentSessionCancelled(env, sessionId))) {
      console.log(JSON.stringify({ event: "linear-agent-run-cancelled", issueId, sessionId, checkpoint: "pre-start" }))
      return
    }

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

    // Checkpoint 1 (stop): cancelled before dispatching the container → abort. Do NOT
    // dispatch (don't open a PR); the webhook's stop handler already resolved the session.
    if (sessionId && (await isAgentSessionCancelled(env, sessionId))) {
      console.log(
        JSON.stringify({ event: "linear-agent-run-cancelled", issueId, sessionId, checkpoint: "pre-dispatch" }),
      )
      return
    }

    const { dispatched, outcome, deduped } = await dispatchTicketImplementation(env, {
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

    if (sessionId) {
      // AgentSessionEvent path (SIG-145). Post a TERMINAL agent activity so the session
      // resolves out of "Working" — the fix for the hang. SKIPPED when:
      //   - deduped: a concurrent/earlier run owns + resolves this session (resolving here,
      //     e.g. on a webhook redelivery, would prematurely close a still-working session); or
      //   - cancelled (checkpoint 2): the user hit Stop and the webhook already posted the
      //     terminal "stopped" activity — a "Done" post would override the user's cancel.
      //     The container may have already opened a PR (a running container can't be
      //     interrupted), but the session stays resolved as "stopped".
      // Best-effort — a failed post never fails the run.
      if (deduped) {
        // concurrent/earlier run owns + resolves the session — see dispatchTicketImplementation.
      } else if (await isAgentSessionCancelled(env, sessionId)) {
        console.log(
          JSON.stringify({ event: "linear-agent-run-cancelled", issueId, sessionId, checkpoint: "post-dispatch" }),
        )
      } else {
        await postAgentSessionCompletion(env, {
          issueId,
          sessionId,
          dispatched,
          ...(outcome !== undefined ? { outcome } : {}),
        })
      }
    } else if (dispatched) {
      // Interim assignee path (no AgentSession): the legacy issue comment ack. A plain
      // comment never "hangs", so this stays a single best-effort dispatch ack.
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
    }

    if (dispatched) {
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

/**
 * Post the TERMINAL Linear agent-session activity for a finished run so the session
 * resolves out of "Working" (SIG-145). Best-effort: any fault — a missing agent token,
 * a Linear API error, an `agentActivityCreate` failure — is logged + swallowed; it must
 * never fail the run. NEVER logs token material; NEVER falls back to a human key (a null
 * client just skips the post).
 *
 * The client is built with the DEFAULT refresh-on-401 path (NOT the webhook ACK's
 * `allowRefresh:false`): this post is off the webhook hot path, so a stale token may
 * self-heal via a refresh+retry. The token READ itself is still the cached `readOnly`
 * path inside `buildLinearAgentClient`.
 */
async function postAgentSessionCompletion(
  env: Env,
  args: { issueId: string; sessionId: string; dispatched: boolean; outcome?: AgentRunOutcome },
): Promise<void> {
  const { type, text } = buildCompletionActivity(args.dispatched, args.outcome)
  try {
    const agent = await buildLinearAgentClient(env)
    if (!agent) {
      console.warn(
        JSON.stringify({ event: "linear-agent-run-ack-no-token", issueId: args.issueId, sessionId: args.sessionId }),
      )
      return
    }
    await agent.createAgentActivity(args.sessionId, text, type)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-run-ack-failed",
        issueId: args.issueId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Map a finished run's outcome to its terminal AgentSession activity (kind + body).
 * Pure (no IO) so the choice is unit-testable in isolation. A `response` completes the
 * turn with a result; an `error` STILL resolves the session — so every branch leaves the
 * session out of "Working" rather than hanging.
 *
 * `dispatchAgentRun` awaits the container's full run, so a `dispatched` call already
 * carries the real outcome. A non-`dispatched` call here is a genuine non-dedupe failure
 * (the dedupe case is filtered out before this is reached) — runner dark or a container
 * fault — and resolves as an `error`.
 */
function buildCompletionActivity(
  dispatched: boolean,
  outcome?: AgentRunOutcome,
): { type: AgentActivityType; text: string } {
  if (dispatched) {
    if (outcome?.status === "opened") {
      const link = outcome.prUrl ? `: ${outcome.prUrl}` : "."
      return { type: "response", text: `✅ Done — opened a pull request${link}` }
    }
    if (outcome?.status === "no-change") {
      return { type: "response", text: "✅ Done — no code changes were needed for this." }
    }
    // Dispatched and the container did NOT report a failure: an unparsed result
    // (`outcome === undefined`), or any non-`error` status (e.g. an unexpected
    // `started` the container shouldn't emit post-completion). The run did dispatch
    // and the container responded, so resolve neutrally with a `response` — never the
    // misleading "couldn't complete" error. Only a genuine `error` status falls through.
    if (outcome?.status !== "error") {
      return { type: "response", text: "✅ Sigilix finished this run — check the issue for the pull request." }
    }
  }
  // Container reported `status: "error"`, OR a non-deduped non-dispatch (runner dark /
  // container fault). A terminal `error` resolves the session instead of leaving it on
  // "Working". The container's own error text is NOT echoed (defense-in-depth — it is
  // already redacted container-side, but a generic message keeps secrets off Linear).
  return {
    type: "error",
    text: "⚠️ Sigilix couldn't complete this run. Please try again, or check the issue for details.",
  }
}
