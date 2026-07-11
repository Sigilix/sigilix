// SIG-545 B1: agent-runner mode parser — "off" | "on".
// Gated behind OPENCLAW_AGENT_RUNNER_MODE; dark by default.
// Mirrors the pattern of other mode parsers (graph-expansion-mode.ts, etc.).

import type { Env } from "@/src/shared/types/env"

/**
 * Agent-runner dispatch mode.
 *
 * "off" (default/unset/unknown) — the AgentRunnerContainer is configured
 *   but never dispatched to; Worker behavior is byte-identical to today.
 * "on" — dispatch is enabled and the Worker may route task packets to the
 *   container. No Worker behavior changes until this is flipped.
 */
export type AgentRunnerMode = "off" | "on"

/**
 * Resolve the current agent-runner mode from the environment.
 *
 * Case-sensitive: only the exact string "on" enables the runner.
 * Any other value — including unset, "ON", whitespace variants, or
 * unknown strings — defaults to "off" (fail-closed).
 */
export function resolveAgentRunnerMode(env: Pick<Env, "OPENCLAW_AGENT_RUNNER_MODE">): AgentRunnerMode {
  if (env.OPENCLAW_AGENT_RUNNER_MODE === "on") return "on"
  return "off"
}

/**
 * Which in-container engine implements a task (SIG-545 B2).
 *
 * "minimal" (default/unset/unknown) — the bounded 5-tool GLM edit loop
 *   (container/src/agent-loop.ts). The proven, tightly-sandboxed B1 engine.
 * "full" — the full Sigilix CLI agent run headless in the container
 *   (container/src/cli-agent.ts). Richer (real tools + grounding plugin) but a
 *   wider attack surface; gated to trusted input until the security pass + B4.
 */
export type AgentRunnerEngine = "minimal" | "full"

/**
 * Resolve the default agent-runner engine from the environment.
 *
 * Case-sensitive and fail-closed: only the exact string "full" selects the
 * full CLI agent; anything else — unset, "FULL", unknown — defaults to the
 * minimal loop. A per-run packet value may override this (trusted-repo gate).
 */
export function resolveAgentRunnerEngine(env: Pick<Env, "OPENCLAW_AGENT_RUNNER_ENGINE">): AgentRunnerEngine {
  if (env.OPENCLAW_AGENT_RUNNER_ENGINE === "full") return "full"
  return "minimal"
}

/**
 * Resolve the engine for a PORTAL make-PR run — a separate, portal-only gate so
 * the full CLI agent can be enabled for the portal independently of the
 * admin/Linear paths. Fail-closed: only the exact string "on" selects "full";
 * anything else — unset, "ON", unknown — stays on the proven sandboxed minimal
 * loop.
 *
 * ⚠️ Do NOT set this "on" for untrusted portal users until the full engine's
 * container egress isolation is adversarially pen-tested against a live deploy
 * (bash rejected, 169.254 + non-allowlisted hosts blocked, secret-exfil fails).
 * The permission + secret-scoping gates are already merged; egress is CF-platform
 * -enforced and only verifiable post-deploy.
 */
export function resolvePortalEngine(env: Pick<Env, "OPENCLAW_PORTAL_FULL_ENGINE_MODE">): AgentRunnerEngine {
  if (env.OPENCLAW_PORTAL_FULL_ENGINE_MODE === "on") return "full"
  return "minimal"
}

/**
 * Resolve the SIG-545 B3 Linear-assignment trigger mode from the environment.
 *
 * "off" (default/unset/unknown) — assigning a Linear issue to the Sigilix agent
 *   user is inert; no agent run is dispatched. Worker behavior is unchanged.
 * "on" — an Issue.update that assigns the issue to OPENCLAW_LINEAR_AGENT_USER_ID
 *   dispatches the agent-runner (on the SAFE minimal engine) to implement it.
 *
 * Case-sensitive and fail-closed: only the exact string "on" arms the trigger;
 * anything else — unset, "ON", whitespace variants, unknown — defaults to "off".
 * Mirrors `resolveAgentRunnerMode`.
 */
export function resolveLinearAgentRunMode(env: Pick<Env, "OPENCLAW_LINEAR_AGENT_RUN_MODE">): AgentRunnerMode {
  if (env.OPENCLAW_LINEAR_AGENT_RUN_MODE === "on") return "on"
  return "off"
}
