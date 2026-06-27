// SIG-196: Sigilix Slack agent — EXACT-match channel→repo scope resolver.
//
// Scope-safety rule (load-bearing boundary):
//   A configured owner/repo is accepted ONLY if OPENCLAW_GITHUB_INSTALLATION_MAP
//   has an EXACT "owner/repo" key with a numeric installation id. An owner-only
//   entry (e.g. "acme" → "222") does NOT authorize any repo under that owner.
//   Repos without an exact entry are silently dropped. Fail-closed throughout.

import type { Env } from "@/src/shared/types/env"

export interface SlackScope {
  teamId: string
  channelId: string
  repos: Array<{ owner: string; repo: string; installationId: number }>
  linearTeam: string | null
}

export type SlackScopeResult =
  | { ok: true; scope: SlackScope }
  | { ok: false; reason: "no-config" | "no-installation" | "parse-error" }

interface ScopeMapEntry {
  repos: string[]
  linearTeam?: string | null
}

export function resolveSlackScope(
  env: Pick<Env, "SIGILIX_SLACK_SCOPE_MAP" | "OPENCLAW_GITHUB_INSTALLATION_MAP">,
  args: { teamId: string; channelId: string },
): SlackScopeResult {
  // Step 1: parse the scope map — fail with parse-error on malformed JSON.
  let scopeMap: Record<string, ScopeMapEntry>
  try {
    scopeMap = JSON.parse(env.SIGILIX_SLACK_SCOPE_MAP ?? "{}") as Record<string, ScopeMapEntry>
  } catch {
    return { ok: false, reason: "parse-error" }
  }

  // Look up the channel config.
  const key = `${args.teamId}:${args.channelId}`
  const channelCfg = scopeMap[key]
  if (channelCfg === undefined || channelCfg === null) {
    return { ok: false, reason: "no-config" }
  }

  // Step 2: parse the installation map — fail-closed to {} on bad JSON.
  let installMap: Record<string, unknown>
  try {
    installMap = JSON.parse(env.OPENCLAW_GITHUB_INSTALLATION_MAP ?? "{}") as Record<string, unknown>
  } catch {
    installMap = {}
  }

  // For each configured repo, require an EXACT "owner/repo" key in installMap.
  // Split on the FIRST "/" only; drop repos that fail lookup or produce NaN.
  const repos: SlackScope["repos"] = []
  for (const ownerRepo of channelCfg.repos ?? []) {
    const slashIdx = ownerRepo.indexOf("/")
    if (slashIdx === -1) continue

    const owner = ownerRepo.slice(0, slashIdx)
    const repo = ownerRepo.slice(slashIdx + 1)

    // EXACT key lookup — no owner-only fallback.
    const rawId = installMap[ownerRepo]
    if (rawId === undefined || rawId === null) continue

    const installationId = Number(rawId)
    if (Number.isNaN(installationId)) continue

    repos.push({ owner, repo, installationId })
  }

  // Step 3: empty intersection → no-installation.
  if (repos.length === 0) {
    return { ok: false, reason: "no-installation" }
  }

  return {
    ok: true,
    scope: {
      teamId: args.teamId,
      channelId: args.channelId,
      repos,
      linearTeam: channelCfg.linearTeam ?? null,
    },
  }
}
