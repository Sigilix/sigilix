// SIG-545 B1: Worker-side agent-runner dispatch + GitHub App token mint + status.
//
// dispatchAgentRun  — gate-checks the mode, mints a short-lived GitHub App
//                     installation token, builds the task packet, and sends it
//                     to the AgentRunnerContainer via @cloudflare/containers.
//                     Dark by default (OPENCLAW_AGENT_RUNNER_MODE !== "on").
//                     Fail-safe: any error returns { dispatched: false } without
//                     throwing. NEVER logs the installation token or model.key.
//
// getAgentRunStatus — reads the durable run record from the AgentRunnerContainer
//                     DO via its getRunRecord() RPC method. Returns null on any
//                     fault (pre-dispatch or container unavailable).
//
// Spec: docs/superpowers/specs/2026-06-27-b1-cf-container-task-to-pr-design.md

import { getContainer } from "@cloudflare/containers"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { resolveAgentRunnerMode, type AgentRunnerEngine } from "@/src/lib/agent-runner/mode"
import { retainTrainingRecord } from "@/src/lib/training-retention/retain-training"
import type { AgentRunnerContainer, AgentRunRecord, RunEvent } from "@/src/do/agent-runner-container"
import type { Env } from "@/src/shared/types/env"

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Input required to dispatch an agent run task to the container.
 * The Worker mints the GitHub App installation token right before
 * dispatch; the container never holds long-lived credentials.
 */
export interface AgentRunTaskInput {
  /** Stable identifier for this run (UUID). Keyed on the DO instance. */
  runId: string
  /** GitHub repo coordinates */
  owner: string
  repo: string
  baseBranch: string
  /** GitHub App installation id for the target repo */
  installationId: number
  /** Linear ticket details forwarded to the container */
  ticket: {
    identifier: string
    title: string
    body: string
    url: string
  }
  /** Optional assembled grounding context from /v1/context */
  grounding?: string
  /**
   * Model to run inside the container.
   * id      — e.g. "z-ai/glm-5.2" (OpenRouter) or "glm-5.2:cloud" (Ollama Turbo).
   * key     — the API key for the chosen provider (OpenRouter, BYO portal, or Ollama Turbo).
   * baseUrl — OpenAI-compatible chat-completions base; defaults to OpenRouter in the
   *           container. Set to "https://ollama.com/v1" to run on Ollama Turbo.
   *           This is scoped to the agent-runner ONLY — it does not affect the
   *           PR-review ensemble's model routing.
   * NEVER logged.
   */
  model: {
    id: string
    key: string
    baseUrl?: string
  }
  /** Resource caps enforced inside the container */
  caps: {
    maxModelCalls: number
    maxTokens: number
    timeoutMs: number
  }
  /**
   * Which in-container engine runs the task (SIG-545 B2). Defaults to "minimal"
   * (the bounded 5-tool loop) when absent. "full" runs the Sigilix CLI agent —
   * gated to trusted callers (the admin route / trusted-repo allow-list).
   */
  engine?: AgentRunnerEngine
}

/**
 * SIG-145: the container's parsed run outcome, surfaced to the caller so it can
 * post a terminal Linear agent-session activity (the PR link on success, a brief
 * message on failure) instead of leaving the session stuck on "Working" forever.
 * Mirrors the fields `dispatchAgentRun` already persists to the DO via
 * `setRunRecord` — this is the SAME data, just also handed back to the caller.
 */
export interface AgentRunOutcome {
  status: AgentRunRecord["status"]
  prUrl?: string
  error?: string
}

// ── Internal: task-packet shape sent over the wire ────────────────────────────

/** Shape of the JSON body POSTed to the container's task-runner entrypoint. */
interface TaskPacket {
  runId: string
  repo: {
    owner: string
    name: string
    installationToken: string // short-lived; NEVER logged
    baseBranch: string
  }
  ticket: AgentRunTaskInput["ticket"]
  grounding: string | undefined
  model: AgentRunTaskInput["model"] // key NEVER logged
  caps: AgentRunTaskInput["caps"]
  /** Selected engine; always resolved to a concrete value before dispatch. */
  engine: AgentRunnerEngine
  /**
   * Grounding wiring for the full CLI agent's sigilix-grounding plugin, resolved
   * from the Worker env at dispatch (NOT from the caller). Omitted when the
   * endpoint or bearer is unset (the full agent then runs blind — graceful).
   * apiKey is NEVER logged. The minimal engine ignores this.
   */
  sigilix?: {
    endpoint: string
    apiKey: string
    repoSlug: string
  }
  /**
   * Live-events wiring (step 2 of the portal diff pane). When present, the
   * container POSTs each file-edit event to `url`, authenticated with `secret`
   * (a per-run token the Worker also stored in the run DO). Omitted unless
   * SIGILIX_AGENT_EVENTS_ENDPOINT is set — then the run streams nothing and the
   * diff pane simply shows the finished PR diff. `secret` is NEVER logged.
   */
  events?: {
    url: string
    secret: string
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** A fresh 256-bit per-run ingest secret, hex-encoded. */
function mintEventSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Resolve the live-events ingest target from the Worker env. Returns undefined
 * unless SIGILIX_AGENT_EVENTS_ENDPOINT (SIGILIX_-preferred, OPENCLAW_ fallback)
 * is set — then the run streams no events and the diff pane shows the finished
 * PR diff. The URL is the Worker's OWN public base; the secret is per-run.
 */
function resolveEventsConfig(
  env: Pick<Env, "SIGILIX_AGENT_EVENTS_ENDPOINT" | "OPENCLAW_AGENT_EVENTS_ENDPOINT">,
  runId: string,
): TaskPacket["events"] {
  const base = env.SIGILIX_AGENT_EVENTS_ENDPOINT ?? env.OPENCLAW_AGENT_EVENTS_ENDPOINT
  if (!base) return undefined
  const trimmed = base.replace(/\/+$/, "")
  return { url: `${trimmed}/internal/agent-runs/${encodeURIComponent(runId)}/events`, secret: mintEventSecret() }
}

/**
 * Resolve the grounding config for the container's sigilix-grounding plugin from
 * the Worker env. Returns undefined unless BOTH the grounding endpoint (the
 * Worker's own /v1 base) and the shared agent bearer are set. apiKey NEVER logged.
 */
function resolveGroundingConfig(
  env: Pick<Env, "OPENCLAW_AGENT_GROUNDING_ENDPOINT" | "OPENCLAW_SIGILIX_API_KEY">,
  owner: string,
  repo: string,
): TaskPacket["sigilix"] {
  const endpoint = env.OPENCLAW_AGENT_GROUNDING_ENDPOINT
  const apiKey = env.OPENCLAW_SIGILIX_API_KEY
  if (!endpoint || !apiKey) return undefined
  return { endpoint, apiKey, repoSlug: `${owner}/${repo}` }
}

/**
 * Returns the AgentRunnerContainer stub for the given runId.
 * Centralises the cast from the raw DO binding so callers stay clean.
 */
function agentRunnerStub(env: Env, runId: string) {
  return getContainer(env.AGENT_RUNNER as unknown as DurableObjectNamespace<AgentRunnerContainer>, runId)
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Dispatch an agent run to the AgentRunnerContainer.
 *
 * DARK guarantee: when OPENCLAW_AGENT_RUNNER_MODE !== "on" this is a no-op
 * — no GitHub API call, no container touch, no token minted.
 *
 * FAIL-SAFE: any error in the mint or dispatch path logs a structured
 * `agent-runner-dispatch-failed` event and returns `{ dispatched: false }`.
 * This function NEVER throws to the caller.
 */
export async function dispatchAgentRun(
  env: Env,
  input: AgentRunTaskInput,
): Promise<{ runId: string; dispatched: boolean; outcome?: AgentRunOutcome; reason?: string }> {
  const { runId } = input

  // ── Dark gate ───────────────────────────────────────────────────────────────
  if (resolveAgentRunnerMode(env) !== "on") {
    console.log(
      JSON.stringify({ event: "agent-runner-skipped", runId, mode: env.OPENCLAW_AGENT_RUNNER_MODE ?? "unset" }),
    )
    return { runId, dispatched: false, reason: `runner-dark: mode=${env.OPENCLAW_AGENT_RUNNER_MODE ?? "unset"}` }
  }

  // ── Mint + dispatch (fail-safe) ──────────────────────────────────────────────
  try {
    // Mint a short-lived GitHub App installation token scoped to the repo.
    // NEVER included in any log statement below.
    const installationToken = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID!,
      privateKey: env.GITHUB_PRIVATE_KEY!,
      installationId: input.installationId,
    })

    // Grounding config for the full CLI agent (omitted unless env-configured).
    const groundingConfig = resolveGroundingConfig(env, input.owner, input.repo)

    // Live-events wiring (omitted unless SIGILIX_AGENT_EVENTS_ENDPOINT is set).
    // Store the per-run secret in the DO BEFORE dispatch so the ingest route can
    // validate the container's event POSTs; a store failure just drops streaming
    // (the run still completes and the finished diff still shows) — never fatal.
    const eventsConfig = resolveEventsConfig(env, runId)
    if (eventsConfig) {
      try {
        await agentRunnerStub(env, runId).setRunEventSecret(eventsConfig.secret)
      } catch (secretErr) {
        console.error(
          JSON.stringify({
            event: "agent-run-event-secret-store-failed",
            runId,
            err: secretErr instanceof Error ? secretErr.message : String(secretErr),
          }),
        )
      }
    }

    const packet: TaskPacket = {
      runId,
      repo: {
        owner: input.owner,
        name: input.repo,
        installationToken, // short-lived ~1h; never logged
        baseBranch: input.baseBranch,
      },
      ticket: input.ticket,
      grounding: input.grounding,
      model: input.model, // model.key is never logged
      engine: input.engine ?? "minimal",
      ...(groundingConfig !== undefined ? { sigilix: groundingConfig } : {}),
      ...(eventsConfig !== undefined ? { events: eventsConfig } : {}),
      caps: input.caps,
    }

    // Send the task packet to the container.
    const response = await agentRunnerStub(env, runId).fetch(
      new Request("https://agent-runner.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet),
      }),
    )

    if (!response.ok) {
      // Surface the container's error body (server.ts includes a `detail` message,
      // never a secret) so a container fault is diagnosable via the dispatch reason
      // instead of an opaque "container responded 500".
      const body = await response.text().catch(() => "")
      throw new Error(`container responded ${response.status}${body ? `: ${body.slice(0, 400)}` : ""}`)
    }

    // Parse the container's RunResult and persist it to the DO record so
    // getAgentRunStatus returns the real outcome instead of null forever.
    // SIG-145: also hand the parsed outcome back to the caller (runLinearAgentRun)
    // so it can post a terminal Linear agent-session activity (PR link / brief
    // failure) — previously this was persisted to the DO and then discarded,
    // which is why nothing ever told the AgentSession the run had finished.
    let outcome: AgentRunOutcome | undefined
    try {
      const result = (await response.json()) as {
        status?: string
        prUrl?: string
        error?: string
      }
      outcome = {
        status: (result.status as AgentRunRecord["status"]) ?? "error",
        ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      }
      await agentRunnerStub(env, runId).setRunRecord({ runId, ...outcome })
    } catch (persistErr) {
      // A malformed response body or a DO storage hiccup must not fail the dispatch.
      // Log the event for observability without including any secrets. If the JSON
      // parse threw, `outcome` is still undefined (caller falls back to a generic
      // completion); if only the DO `setRunRecord` threw, `outcome` is already parsed
      // and is still surfaced below so the caller can post the real PR link.
      console.warn(
        JSON.stringify({
          event: "agent-runner-status-persist-failed",
          runId,
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          // installationToken and model.key intentionally excluded
        }),
      )
    }

    // sig-training-retention-wiring (flagged-off). A SUCCESS trajectory — the
    // ticket that produced a PR (status "opened") — is high-signal "what worked"
    // data: task → outcome. Offer it to the consent-gated training store for the
    // target installation. INERT by default: retainTrainingRecord returns
    // immediately (no record build, no I/O) while SIGILIX_TRAINING_RETENTION_MODE
    // is off, and even flipped on writes only for a consenting org into the
    // SEPARATE R2 partition, redacted first. Only the ticket text + terminal
    // outcome are captured (the installation token and model.key are NEVER
    // included). Best-effort; never affects the dispatch result.
    if (outcome?.status === "opened") {
      await retainTrainingRecord(env, input.installationId, () => ({
        kind: "agent-trajectory",
        id: runId,
        payload: JSON.stringify({
          ticket: input.ticket,
          status: outcome.status,
          ...(outcome.prUrl !== undefined ? { prUrl: outcome.prUrl } : {}),
        }),
        meta: {
          owner: input.owner,
          repo: input.repo,
          ticket: input.ticket.identifier,
          status: outcome.status,
          engine: packet.engine,
        },
      }))
    }

    return { runId, dispatched: true, ...(outcome !== undefined ? { outcome } : {}) }
  } catch (err) {
    // Log failure without any secrets. The error message is included so
    // operators can distinguish network faults from GitHub API errors.
    console.error(
      JSON.stringify({
        event: "agent-runner-dispatch-failed",
        runId,
        owner: input.owner,
        repo: input.repo,
        error: err instanceof Error ? err.message : String(err),
        // installationToken and model.key intentionally excluded
      }),
    )
    return { runId, dispatched: false, reason: `dispatch-failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── status ────────────────────────────────────────────────────────────────────

/**
 * Read the durable run record from the AgentRunnerContainer DO.
 *
 * Uses the DO's `getRunRecord()` RPC method directly (the Container class
 * extends DurableObject, so all public methods are available via the stub).
 *
 * Returns null when:
 *   - No record has been written yet (pre-dispatch state)
 *   - The container / DO is unavailable (any fault — fail-safe)
 */
export async function getAgentRunStatus(env: Env, runId: string): Promise<AgentRunRecord | null> {
  try {
    const stub = agentRunnerStub(env, runId)
    return await stub.getRunRecord()
  } catch {
    return null
  }
}

/** Read a run's live events with `seq > afterSeq` (for the portal's diff pane). */
export async function getAgentRunEvents(
  env: Env,
  runId: string,
  afterSeq: number,
): Promise<{ events: RunEvent[]; cursor: number }> {
  try {
    return await agentRunnerStub(env, runId).getRunEvents(afterSeq)
  } catch {
    return { events: [], cursor: afterSeq }
  }
}

/** Append a container-emitted run event IF the per-run secret matches. */
export async function appendAgentRunEvent(
  env: Env,
  runId: string,
  secret: string,
  event: Omit<RunEvent, "seq">,
): Promise<{ ok: true; seq: number } | { ok: false }> {
  try {
    return await agentRunnerStub(env, runId).appendRunEventAuthed(secret, event)
  } catch {
    return { ok: false }
  }
}
