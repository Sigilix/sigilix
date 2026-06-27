// SIG-545 A: GitHub-PR "@sigilix make a linear triage" command. Dark by default.
import { LinearClient, buildLinearAuth } from "@/src/lib/linear"
import { triageIssue } from "@/src/lib/triage"
import { resolveLinearTeamForRepo } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { isAuthorAllowedForReviewDismiss } from "./github-mention-dismiss"

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
  | { kind: "error"; message: string }

/**
 * SIG-545 Task 3 — resolve team → createIssue → triageIssue.
 *
 * Returns `{kind:"no-team"}` when no Linear team is mapped for the repo.
 * Returns `{kind:"created", triaged}` after a successful createIssue — triage
 * failures are absorbed (triaged:false) because the issue already exists.
 * Returns `{kind:"error"}` when buildLinearAuth or createIssue throws.
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
  },
): Promise<LinearTriageResult> {
  const teamId = resolveLinearTeamForRepo(env.OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP, args.owner, args.repo)
  if (!teamId) return { kind: "no-team" }

  const description = `${args.body}\n\n— filed by @${args.author} via Sigilix from ${args.prUrl}`

  try {
    const lc = new LinearClient(await buildLinearAuth(env))
    const issue = await lc.createIssue({ teamId, title: args.title, description })
    let triaged = true
    try {
      await triageIssue(issue.id, env)
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
  } else {
    return { handled: true, reply: "I couldn't create the Linear issue just now — please try again." }
  }
}
