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
