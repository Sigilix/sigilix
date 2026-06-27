// SIG-545 A: GitHub-PR "@sigilix make a linear triage" command. Dark by default.
import type { Env } from "@/src/shared/types/env"
export type GithubLinearTriageMode = "off" | "shadow" | "on"
export function resolveGithubLinearTriageMode(env: Pick<Env, "OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE">): GithubLinearTriageMode {
  const v = env.OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE
  return v === "shadow" || v === "on" ? v : "off"
}
