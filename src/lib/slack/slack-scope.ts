// SIG-196: Sigilix Slack agent — EXACT-match channel→repo scope resolver.
//
// Resolution order (customer self-serve, founder-safe):
//   1. D1 binding (slack_channel_binding / slack_channel_repo, migration 0019) —
//      written by the portal's channel→repo picker. When a binding row exists
//      for the team:channel, the DB is AUTHORITATIVE (no env fallthrough).
//   2. SIGILIX_SLACK_SCOPE_MAP env map — the original hardcoded beta config.
//      Still fully honored when no DB row matches (and when the DB is unbound,
//      the migration isn't applied yet, or the query fails), so the founder's
//      beta channel never breaks.
//
// Scope-safety rule for the env path (load-bearing boundary):
//   A configured owner/repo is accepted ONLY if OPENCLAW_GITHUB_INSTALLATION_MAP
//   has an EXACT "owner/repo" key with a numeric installation id. An owner-only
//   entry (e.g. "acme" → "222") does NOT authorize any repo under that owner.
//   Repos without an exact entry are silently dropped. Fail-closed throughout.
//   The DB path carries its own installation id per row, validated at bind time
//   against the org's exact GitHub installation (slack-config-route.ts).

import { getSlackChannelDbScope } from "@/src/lib/slack/slack-binding-store"
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

type ScopeEnv = Pick<Env, "SIGILIX_SLACK_SCOPE_MAP" | "OPENCLAW_GITHUB_INSTALLATION_MAP" | "SIGILIX_PLATFORM_DB">

export async function resolveSlackScope(
  env: ScopeEnv,
  args: { teamId: string; channelId: string },
): Promise<SlackScopeResult> {
  const dbScope = await getSlackChannelDbScope(env, args)
  if (dbScope !== null) {
    // A DB binding exists — it is authoritative for this channel. Split each
    // stored full name on the FIRST "/" only; drop malformed names fail-closed.
    const repos: SlackScope["repos"] = []
    for (const repo of dbScope.repos) {
      const slashIdx = repo.githubRepoFullName.indexOf("/")
      if (slashIdx === -1) continue
      repos.push({
        owner: repo.githubRepoFullName.slice(0, slashIdx),
        repo: repo.githubRepoFullName.slice(slashIdx + 1),
        installationId: dbScope.installationId,
      })
    }
    if (repos.length === 0) {
      return { ok: false, reason: "no-installation" }
    }
    return {
      ok: true,
      scope: { teamId: args.teamId, channelId: args.channelId, repos, linearTeam: null },
    }
  }
  return resolveSlackScopeFromEnv(env, args)
}

/** The original env-map resolver — the fallback path behind the DB binding. */
function resolveSlackScopeFromEnv(
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

  // Look up the channel config — prototype-safe.
  const key = `${args.teamId}:${args.channelId}`
  if (!Object.hasOwn(scopeMap, key)) {
    return { ok: false, reason: "no-config" }
  }
  const channelCfg = scopeMap[key]
  if (channelCfg === undefined || channelCfg === null) {
    return { ok: false, reason: "no-config" }
  }

  // Guard non-array repos — fail closed instead of throwing.
  if (!Array.isArray(channelCfg.repos)) {
    return { ok: false, reason: "parse-error" }
  }

  // Step 2: parse the installation map — fail-closed to {} on bad JSON.
  let installMap: Record<string, unknown>
  try {
    installMap = JSON.parse(env.OPENCLAW_GITHUB_INSTALLATION_MAP ?? "{}") as Record<string, unknown>
  } catch {
    installMap = {}
  }

  // For each configured repo, require an EXACT "owner/repo" key in installMap.
  // Split on the FIRST "/" only; drop repos that fail lookup or produce a non-positive id.
  const repos: SlackScope["repos"] = []
  for (const ownerRepo of channelCfg.repos) {
    const slashIdx = ownerRepo.indexOf("/")
    if (slashIdx === -1) continue

    const owner = ownerRepo.slice(0, slashIdx)
    const repo = ownerRepo.slice(slashIdx + 1)

    // EXACT key lookup — no owner-only fallback. Prototype-safe.
    if (!Object.hasOwn(installMap, ownerRepo)) continue
    const rawId = installMap[ownerRepo]
    if (rawId === undefined || rawId === null) continue

    const installationId = Number(rawId)
    // Drop zero, negative, NaN, or Infinity — must be a finite positive integer.
    if (!Number.isFinite(installationId) || installationId <= 0) continue

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
