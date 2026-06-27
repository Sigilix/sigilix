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
import { resolveAgentRunnerMode } from "@/src/lib/agent-runner/mode"
import type { AgentRunnerContainer, AgentRunRecord } from "@/src/do/agent-runner-container"
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
   * id  — e.g. "z-ai/glm-5.2" (slash → OpenRouter routing)
   * key — Sigilix's OpenRouter API key or a BYO portal key.
   * NEVER logged.
   */
  model: {
    id: string
    key: string
  }
  /** Resource caps enforced inside the container */
  caps: {
    maxModelCalls: number
    maxTokens: number
    timeoutMs: number
  }
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
}

// ── Private helpers ───────────────────────────────────────────────────────────

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
): Promise<{ runId: string; dispatched: boolean }> {
  const { runId } = input

  // ── Dark gate ───────────────────────────────────────────────────────────────
  if (resolveAgentRunnerMode(env) !== "on") {
    console.log(
      JSON.stringify({ event: "agent-runner-skipped", runId, mode: env.OPENCLAW_AGENT_RUNNER_MODE ?? "unset" }),
    )
    return { runId, dispatched: false }
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

    if (!response.ok) throw new Error(`container responded ${response.status}`)

    return { runId, dispatched: true }
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
    return { runId, dispatched: false }
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
