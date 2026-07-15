// Slack channel repository authorization.
//
// D1 is the customer-managed authority. A healthy missing row or an unbound D1
// may use the operator-controlled exact team:channel legacy map; corrupt rows or
// query failures deny and never switch authority. Both sources converge on one
// installation id, then reconcile against the complete current GitHub App
// installation repository list before any Slack agent work can run.

import { listGithubAppInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { getSlackChannelDbScope } from "@/src/lib/slack/slack-binding-store"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"

export interface SlackScopedRepo {
  githubRepoId: number
  owner: string
  repo: string
}

export interface SlackScope {
  teamId: string
  channelId: string
  installationId: number
  repos: SlackScopedRepo[]
  linearTeam: string | null
}

export type SlackScopeResult =
  | { ok: true; scope: SlackScope }
  | {
      ok: false
      reason: "no-config" | "no-installation" | "parse-error" | "invalid-binding" | "scope-unavailable"
    }

interface ScopeMapEntry {
  repos: string[]
  linearTeam?: string | null
}

type ScopeEnv = Pick<
  Env,
  | "SIGILIX_SLACK_SCOPE_MAP"
  | "OPENCLAW_GITHUB_INSTALLATION_MAP"
  | "SIGILIX_PLATFORM_DB"
  | "OPENCLAW_STATE"
  | "GITHUB_APP_ID"
  | "GITHUB_PRIVATE_KEY"
>

type PendingSelection =
  | { kind: "all" }
  | { kind: "ids"; repositoryIds: number[] }
  | { kind: "legacy-names"; fullNames: string[] }

interface PendingSlackScope {
  installationId: number
  selection: PendingSelection
  linearTeam: string | null
}

type PendingScopeResult = { ok: true; pending: PendingSlackScope } | Extract<SlackScopeResult, { ok: false }>

export async function resolveSlackScope(
  env: ScopeEnv,
  args: { teamId: string; channelId: string; signal?: AbortSignal },
): Promise<SlackScopeResult> {
  if (args.signal?.aborted) return { ok: false, reason: "scope-unavailable" }
  const dbScope = await getSlackChannelDbScope(env, args)
  if (args.signal?.aborted) return { ok: false, reason: "scope-unavailable" }
  let pending: PendingScopeResult

  if (dbScope.kind === "bound") {
    pending = {
      ok: true,
      pending: {
        installationId: dbScope.installationId,
        selection: dbScope.useAllRepos
          ? { kind: "all" }
          : { kind: "ids", repositoryIds: dbScope.repos.map((repo) => repo.githubRepoId) },
        linearTeam: null,
      },
    }
  } else if (dbScope.kind === "invalid") {
    return { ok: false, reason: "invalid-binding" }
  } else if (dbScope.kind === "unavailable") {
    return { ok: false, reason: "scope-unavailable" }
  } else {
    console.log(
      JSON.stringify({
        event: "slack-scope-authority",
        authority: "legacy-env",
        dbState: dbScope.kind,
        teamId: args.teamId,
        channelId: args.channelId,
      }),
    )
    pending = resolveLegacyPendingScope(env, args)
  }

  if (!pending.ok) return pending
  return authorizePendingScope(env, args, pending.pending, args.signal)
}

function resolveLegacyPendingScope(
  env: Pick<Env, "SIGILIX_SLACK_SCOPE_MAP" | "OPENCLAW_GITHUB_INSTALLATION_MAP">,
  args: { teamId: string; channelId: string },
): PendingScopeResult {
  let scopeMap: Record<string, unknown>
  try {
    const parsed = JSON.parse(env.SIGILIX_SLACK_SCOPE_MAP ?? "{}") as unknown
    if (!isRecord(parsed)) return { ok: false, reason: "parse-error" }
    scopeMap = parsed
  } catch {
    return { ok: false, reason: "parse-error" }
  }

  const key = `${args.teamId}:${args.channelId}`
  if (!Object.hasOwn(scopeMap, key)) return { ok: false, reason: "no-config" }
  const rawChannel = scopeMap[key]
  if (!isRecord(rawChannel) || !Array.isArray(rawChannel.repos)) {
    return { ok: false, reason: "parse-error" }
  }
  const channel = rawChannel as unknown as ScopeMapEntry
  if (
    channel.linearTeam !== undefined &&
    channel.linearTeam !== null &&
    (typeof channel.linearTeam !== "string" || channel.linearTeam.length === 0)
  ) {
    return { ok: false, reason: "parse-error" }
  }

  let installationMap: Record<string, unknown>
  try {
    const parsed = JSON.parse(env.OPENCLAW_GITHUB_INSTALLATION_MAP ?? "{}") as unknown
    installationMap = isRecord(parsed) ? parsed : {}
  } catch {
    installationMap = {}
  }

  const installationIds = new Set<number>()
  const fullNames: string[] = []
  for (const ownerRepo of channel.repos) {
    if (typeof ownerRepo !== "string" || !splitFullName(ownerRepo)) {
      return { ok: false, reason: "parse-error" }
    }
    if (!Object.hasOwn(installationMap, ownerRepo)) continue
    const installationId = parsePositiveSafeInteger(installationMap[ownerRepo])
    if (installationId === null) {
      return { ok: false, reason: "no-installation" }
    }
    installationIds.add(installationId)
    fullNames.push(ownerRepo)
  }

  if (installationIds.size !== 1 || fullNames.length === 0) {
    return { ok: false, reason: "no-installation" }
  }
  const [installationId] = installationIds
  if (installationId === undefined) return { ok: false, reason: "no-installation" }
  return {
    ok: true,
    pending: {
      installationId,
      selection: { kind: "legacy-names", fullNames },
      linearTeam: channel.linearTeam ?? null,
    },
  }
}

async function authorizePendingScope(
  env: Pick<Env, "OPENCLAW_STATE" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY">,
  args: { teamId: string; channelId: string },
  pending: PendingSlackScope,
  signal?: AbortSignal,
): Promise<SlackScopeResult> {
  if (signal?.aborted || !env.OPENCLAW_STATE || !env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return { ok: false, reason: "scope-unavailable" }
  }

  let token: string
  try {
    token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: pending.installationId,
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { ok: false, reason: "scope-unavailable" }
  }
  if (signal?.aborted) return { ok: false, reason: "scope-unavailable" }

  let listed: Awaited<ReturnType<typeof listGithubAppInstallationRepos>>
  try {
    listed = signal
      ? await listGithubAppInstallationRepos(token, pending.installationId, { signal })
      : await listGithubAppInstallationRepos(token, pending.installationId)
  } catch {
    return { ok: false, reason: "scope-unavailable" }
  }
  if (signal?.aborted || !listed.ok) return { ok: false, reason: "scope-unavailable" }
  if (
    listed.repos.some((repo) => repo.installationId !== pending.installationId || !isPositiveSafeInteger(repo.repoId))
  ) {
    return { ok: false, reason: "scope-unavailable" }
  }

  let selected: SlackScopedRepo[]
  if (pending.selection.kind === "all") {
    selected = listed.repos.map(toScopedRepo)
  } else if (pending.selection.kind === "ids") {
    const liveById = new Map(listed.repos.map((repo) => [repo.repoId, repo]))
    selected = pending.selection.repositoryIds.flatMap((repositoryId) => {
      const repo = liveById.get(repositoryId)
      return repo ? [toScopedRepo(repo)] : []
    })
  } else {
    const liveByName = new Map(listed.repos.map((repo) => [`${repo.owner}/${repo.repo}`.toLowerCase(), repo]))
    selected = pending.selection.fullNames.flatMap((fullName) => {
      const repo = liveByName.get(fullName.toLowerCase())
      return repo ? [toScopedRepo(repo)] : []
    })
  }

  selected = dedupeRepos(selected)
  if (selected.length === 0) return { ok: false, reason: "no-installation" }
  return {
    ok: true,
    scope: {
      teamId: args.teamId,
      channelId: args.channelId,
      installationId: pending.installationId,
      repos: selected,
      linearTeam: pending.linearTeam,
    },
  }
}

function toScopedRepo(repo: { repoId: number; owner: string; repo: string }): SlackScopedRepo {
  return { githubRepoId: repo.repoId, owner: repo.owner, repo: repo.repo }
}

function dedupeRepos(repos: SlackScopedRepo[]): SlackScopedRepo[] {
  const seen = new Set<number>()
  return repos.filter((repo) => {
    if (seen.has(repo.githubRepoId)) return false
    seen.add(repo.githubRepoId)
    return true
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === "number") return isPositiveSafeInteger(value) ? value : null
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return isPositiveSafeInteger(parsed) ? parsed : null
}

function splitFullName(fullName: string): { owner: string; repo: string } | null {
  if (fullName.length === 0 || fullName.length > 512 || fullName.trim() !== fullName) return null
  const parts = fullName.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}
