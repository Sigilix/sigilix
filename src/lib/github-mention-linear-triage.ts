// SIG-545 A: GitHub-PR "@sigilix make a linear triage" command. Dark by default.
import { buildLinearClient } from "@/src/lib/linear"
import { triageIssue } from "@/src/lib/triage"
import { resolveLinearTeamForRepo, resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { resolveEntitlement, upsellFor as linearUpsellFor } from "@/src/features/entitlements"
import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { isAuthorAllowedForReviewDismiss } from "./github-mention-dismiss"
import {
  getLinearConfig,
  getLinearConnectionByInstallation,
  resolveLinearTeamBindingForRepo,
  teamIsSelected,
  type LinearTenantContext,
} from "@/src/features/linear-integration"

export type GithubLinearTriageMode = "off" | "shadow" | "on"
export function resolveGithubLinearTriageMode(
  env: Pick<Env, "OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE">,
): GithubLinearTriageMode {
  const v = env.OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE
  return v === "shadow" || v === "on" ? v : "off"
}

// Leading-imperative regexes for "make/create a linear triage/issue/ticket" forms.
// Anchored at the start so descriptive questions ("what would a linear triage look like?") don't match.
const MAKE_CREATE_RE = /^\s*(?:(?:can\s+you\s+)?(?:make|create)\s+(?:a\s+)?linear\s+(?:triage|issue|ticket))/i
const TRIAGE_INTO_RE = /^\s*triage\s+(?:this\s+)?into\s+linear/i

export function parseLinearTriageCommand(question: string): { matched: boolean } {
  return { matched: MAKE_CREATE_RE.test(question) || TRIAGE_INTO_RE.test(question) }
}

export type LinearTriageResult =
  | { kind: "created"; identifier: string; url: string; triaged: boolean }
  | { kind: "no-team" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }

/**
 * SIG-545 Task 3 — resolve team → createIssue → triageIssue.
 *
 * Returns `{kind:"no-team"}` when no Linear team is mapped for the repo.
 * Returns `{kind:"created", triaged}` after a successful createIssue — triage
 * failures are absorbed (triaged:false) because the issue already exists.
 * Returns `{kind:"error"}` when buildLinearClient or createIssue throws.
 */
export async function runLinearTriageAction(
  env: Env,
  args: {
    owner: string
    repo: string
    prNumber: number
    title: string
    body: string
    author: string
    prUrl: string
    installationId?: number
  },
): Promise<LinearTriageResult> {
  let tenant: LinearTenantContext | undefined
  let teamId: string | null = null
  if (env.SIGILIX_PLATFORM_DB) {
    // Once the tenant store is present there is no global-map fallback: a
    // missing installation or any connection/config/binding proof fails
    // closed. The legacy map is only for deployments without D1.
    if (!args.installationId) return { kind: "no-team" }
    const [connection, config, binding] = await Promise.all([
      getLinearConnectionByInstallation(env, args.installationId),
      getLinearConfig(env, args.installationId),
      resolveLinearTeamBindingForRepo(env, args.installationId, `${args.owner}/${args.repo}`),
    ])
    if (
      connection?.status === "active" &&
      config &&
      binding?.accessState === "allowed" &&
      binding.installationId === args.installationId &&
      binding.githubRepoFullName.toLowerCase() === `${args.owner}/${args.repo}`.toLowerCase() &&
      teamIsSelected(config, binding.teamId)
    ) {
      if (config.createIssue === "disabled") return { kind: "disabled" }
      teamId = binding.teamId
      tenant = {
        organizationId: connection.organizationId,
        installationId: args.installationId,
        teamId: binding.teamId,
      }
    } else {
      return { kind: "no-team" }
    }
  } else {
    teamId = resolveLinearTeamForRepo(env.OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP, args.owner, args.repo)
  }
  if (!teamId) return { kind: "no-team" }

  const description = `${args.body}\n\n— filed by @${args.author} via Sigilix from ${args.prUrl}`

  try {
    const lc = await buildLinearClient(env, tenant)
    const issue = await lc.createIssue({ teamId, title: args.title, description })
    let triaged = true
    try {
      if (tenant) await triageIssue(issue.id, env, tenant)
      else await triageIssue(issue.id, env)
    } catch {
      triaged = false
    }
    return { kind: "created", identifier: issue.identifier, url: issue.url, triaged }
  } catch {
    return { kind: "error", message: "Failed to create Linear issue" }
  }
}

export type LinearTriageOutcome = { handled: false } | { handled: true; reply: string | null }

/**
 * SIG-545 A — handles the "@sigilix make a linear triage" command end-to-end.
 * Returns {handled:false} when the question isn't a triage command or mode is "off".
 * Returns {handled:true, reply:null} when the command is handled but no reply is needed
 * (unauthorized author or shadow mode). Returns {handled:true, reply:"..."} otherwise.
 */
export async function handleLinearTriageCommand(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  commentId: number
  authorLogin: string
  authorAssociation: string | null | undefined
  question: string
}): Promise<LinearTriageOutcome> {
  const { env, client, owner, repo, prNumber, commentId, authorLogin, authorAssociation, question } = args
  if (!parseLinearTriageCommand(question).matched || resolveGithubLinearTriageMode(env) === "off") {
    return { handled: false }
  }
  const mode = resolveGithubLinearTriageMode(env)
  if (!isAuthorAllowedForReviewDismiss(authorAssociation)) {
    return { handled: true, reply: null }
  }

  // ── Entitlement gate (sig-free-tier-entitlements) ────────────────────────────
  // Linear triage is Pro/Teams/Max/Ultra/Enterprise only. Resolve the plan from THIS PR's own
  // installation (tenant isolation). If not entitled, reply with a brief upgrade
  // note in the GitHub thread — the natural human surface — and do not create.
  // A failed installation resolve → unknown plan → fail-closed (blocked in enforce).
  const inst = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  const entitlement = await resolveEntitlement(env, {
    installationId: inst.ok ? inst.installationId : 0,
    feature: "linear",
  })
  if (entitlement.blocked) {
    return { handled: true, reply: linearUpsellFor("linear") }
  }

  if (mode === "shadow") {
    console.log(JSON.stringify({ event: "github-linear-triage-would-create", owner, repo, prNumber }))
    return { handled: true, reply: null }
  }
  const dedupeKey = `linear-triage:${commentId}`
  const prior = await env.OPENCLAW_STATE.get(dedupeKey)
  if (prior) {
    const pipeIdx = prior.indexOf("|")
    const ident = pipeIdx >= 0 ? prior.slice(0, pipeIdx) : prior
    const url = pipeIdx >= 0 ? prior.slice(pipeIdx + 1) : ""
    return { handled: true, reply: `Already created **${ident}** for this comment: ${url}` }
  }
  const pr = await client.getPullRequest(owner, repo, prNumber)
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`
  const result = await runLinearTriageAction(env, {
    owner,
    repo,
    prNumber,
    title: pr.title,
    body: pr.body ?? "",
    author: authorLogin,
    prUrl,
    ...(inst.ok ? { installationId: inst.installationId } : {}),
  })
  if (result.kind === "created") {
    await env.OPENCLAW_STATE.put(dedupeKey, `${result.identifier}|${result.url}`, { expirationTtl: 86400 })
    return {
      handled: true,
      reply: `Created **${result.identifier}**${result.triaged ? " — triaged" : ""}: ${result.url}`,
    }
  } else if (result.kind === "no-team") {
    return {
      handled: true,
      reply: "No Linear team is configured for this repo — an admin can set `OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP`.",
    }
  } else if (result.kind === "disabled") {
    return { handled: true, reply: "Linear issue creation is disabled in this organization's Sigilix settings." }
  } else {
    return { handled: true, reply: "I couldn't create the Linear issue just now — please try again." }
  }
}
