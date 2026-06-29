// SIG-545 B1: AgentRunnerContainer — Cloudflare Container DO scaffold (dark).
//
// Manages one container instance per runId. The container clones a target
// repo, runs a coding step via GLM-5.2/OpenRouter, commits a branch, and
// opens a PR. This file is the thin DO shell; dispatch + in-container logic
// arrive in later tasks (B2/B3).
//
// Spec: docs/superpowers/specs/2026-06-27-b1-cf-container-task-to-pr-design.md
//
// ⚠️  The new DO migration needs a one-time non-versioned `wrangler deploy`
//     before/alongside a `wrangler versions upload` — see infra gotcha 10211.

import { Container } from "@cloudflare/containers"
import type { Env } from "@/src/shared/types/env"

const RUN_RECORD_KEY = "run-record"

/**
 * Durable run-state record stored in the DO's SQLite storage.
 * Written before dispatch and updated on completion / error.
 * Never logs tokens, keys, or installation secrets.
 */
export interface AgentRunRecord {
  runId: string
  status: "started" | "opened" | "no-change" | "error"
  prUrl?: string
  error?: string
}

/**
 * AgentRunnerContainer — one instance per runId.
 *
 * Configured in wrangler.toml under `[[containers]]` (instance_type
 * "standard-1", max_instances 3) and `[[durable_objects.bindings]]`
 * (AGENT_RUNNER). The DO's SQLite storage holds the run record so the
 * Worker-side poller can read status without keeping the container alive.
 *
 * Dark: only dispatched when OPENCLAW_AGENT_RUNNER_MODE === "on".
 */
export class AgentRunnerContainer extends Container<Env> {
  // Port the in-container HTTP task-runner listens on (POST / → start job).
  override defaultPort = 8080

  // One-shot runs should not idle; sleep quickly after the job completes.
  override sleepAfter = "2m"

  // The container needs github.com + openrouter.ai egress.
  override enableInternet = true

  // -------------------------------------------------------------------------
  // Run-record helpers — thin SQLite accessors over the DO's durable storage.
  // The record survives container restarts and lets the Worker poll status
  // without hitting the container directly.
  // -------------------------------------------------------------------------

  /**
   * Read the current run record for this DO instance.
   * Returns null when no record has been written yet (pre-dispatch state).
   */
  async getRunRecord(): Promise<AgentRunRecord | null> {
    const record = await this.ctx.storage.get<AgentRunRecord>(RUN_RECORD_KEY)
    return record ?? null
  }

  /**
   * Persist the run record for this DO instance.
   * Called by the Worker before dispatching to the container (status: "started")
   * and by the container on completion (status: "opened" | "no-change" | "error").
   */
  async setRunRecord(r: AgentRunRecord): Promise<void> {
    await this.ctx.storage.put(RUN_RECORD_KEY, r)
  }
}
