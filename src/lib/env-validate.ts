// Boot-time validation that every team-repo mapping has a matching
// installation entry. Catches the silent-failure mode where a team is
// configured to fetch PRs but the install map doesn't cover its target
// repo — without this, Arc would just abstain at runtime and look dumb.
//
// Cloudflare Workers can't read `env` at module top-level (env is per-
// request), so we run validation on first request per env signature
// instead. The cache key in src/index.ts is derived from the env values
// that affect this check, so a preview/staging/prod isolate that
// multiplexes envs revalidates per signature instead of locking to the
// first-request env.
//
// Modes:
//   - "strict" — throws; src/index.ts catches and returns 500 until env changes
//   - "warn"   — console.warn only; phase 1 silently disabled for missing entries
//
// `parseValidateMode` defaults anything other than the exact lowercase
// string "strict" to "warn" — case-sensitive on purpose. "STRICT" or
// "true" or "error" should NOT silently promote a deploy to strict mode;
// production sets the exact string "strict" explicitly.

import { listTeamRepoMappings, resolveInstallation } from "./github-installation"
import type { Env } from "../index"

export type ValidateMode = "strict" | "warn"

export function parseValidateMode(value: string | undefined): ValidateMode {
  return value === "strict" ? "strict" : "warn"
}

export function validateEnv(env: Env, mode: ValidateMode): void {
  const teamMappings = listTeamRepoMappings(env.OPENCLAW_TEAM_GITHUB_REPO_MAP)
  if (teamMappings.length === 0) return // Phase 1 not configured — nothing to validate

  const missing: Array<{ teamKey: string; owner: string; repo: string }> = []
  for (const m of teamMappings) {
    const lookup = resolveInstallation(m.owner, m.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (!lookup.ok) missing.push(m)
  }
  if (missing.length === 0) return

  const detail = missing.map((m) => `${m.teamKey} → ${m.owner}/${m.repo}`).join(", ")
  const message = `OPENCLAW_TEAM_GITHUB_REPO_MAP references team→repo entries with no matching OPENCLAW_GITHUB_INSTALLATION_MAP entry: ${detail}`
  if (mode === "strict") {
    throw new Error(message)
  }
  console.warn(`[env-validate] ${message}`)
}
