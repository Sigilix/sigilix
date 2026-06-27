// SIG-196: Sigilix Slack agent — tri-state mode resolver.
// Fail-closed: any value other than exact "shadow" or "on" resolves to "off".

import type { Env } from "@/src/shared/types/env"

export type SlackMode = "off" | "shadow" | "on"

export function resolveSlackMode(env: Pick<Env, "SIGILIX_SLACK_MODE">): SlackMode {
  const v = env.SIGILIX_SLACK_MODE
  return v === "shadow" || v === "on" ? v : "off"
}
