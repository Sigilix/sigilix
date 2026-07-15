import { createAgentTools } from "@/src/lib/agent-tools"
import { buildClient } from "@/src/lib/github-mention"
import {
  createSlackCodeCitationSession,
  parseSlackCodeCitationMode,
  type SlackCodeCitationSession,
} from "@/src/lib/slack/slack-code-citations"
import { resolveSlackScope, type SlackScope } from "@/src/lib/slack/slack-scope"
import type { Env } from "@/src/shared/types/env"

export interface SlackAgentToolBundle {
  tools: ReturnType<typeof createAgentTools>
  citations: SlackCodeCitationSession | null
}

/** Build installation-scoped tools while retaining immutable repo identity in
 *  the optional Slack citation session. Repository names remain the tool's
 *  model-facing allowlist; numeric IDs stay inside server-side proof state. */
export async function buildSlackAgentTools(
  env: Env,
  scope: SlackScope,
  enableCodeCitations = false,
): Promise<SlackAgentToolBundle> {
  const githubClient = await buildClient(env, scope.installationId)
  const channelRepos = scope.repos.map((repo) => ({ owner: repo.owner, repo: repo.repo }))
  const citationMode = enableCodeCitations ? parseSlackCodeCitationMode(env.OPENCLAW_SLACK_CODE_CITATIONS_MODE) : "off"
  const citations =
    citationMode === "off"
      ? null
      : createSlackCodeCitationSession({
          mode: citationMode,
          env,
          scope,
          githubClient,
          resolveCurrentScope: async (signal) => {
            if (signal.aborted) return null
            const result = await resolveSlackScope(env, {
              teamId: scope.teamId,
              channelId: scope.channelId,
              signal,
            })
            return signal.aborted || !result.ok ? null : result.scope
          },
        })
  const tools = createAgentTools({
    env,
    surface: "slack-mention",
    github: {
      githubClient,
      allowedRepos: dedupeOwnerRepo(channelRepos),
      defaultRef: "main",
      installationId: scope.installationId,
    },
    ...(citations ? { slackCodeCitations: citations } : {}),
  })
  return { tools, citations }
}

function dedupeOwnerRepo(repos: Array<{ owner: string; repo: string }>): Array<{ owner: string; repo: string }> {
  const seen = new Set<string>()
  const out: Array<{ owner: string; repo: string }> = []
  for (const repo of repos) {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(repo)
  }
  return out
}
