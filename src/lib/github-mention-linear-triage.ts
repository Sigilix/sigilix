// SIG-545 A: GitHub-PR "@sigilix make a linear triage" command. Dark by default.
import { LinearClient, buildLinearAuth } from "@/src/lib/linear"
import { triageIssue } from "@/src/lib/triage"
import { resolveLinearTeamForRepo } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"

export type GithubLinearTriageMode = "off" | "shadow" | "on"
export function resolveGithubLinearTriageMode(env: Pick<Env, "OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE">): GithubLinearTriageMode {
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
