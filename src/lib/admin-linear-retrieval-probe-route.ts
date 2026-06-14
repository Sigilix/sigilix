// SIG-207: admin-only dry-run probe for Linear mention code retrieval.
// Exercises the same retrieve_codebase tool path as the agent loop, but
// never calls a model and never posts back to Linear.

import { requireBearerToken } from "./auth-bearer"
import { createAgentTools } from "./agent-tools"
import { resolveLinearAgentRepoScope } from "./mention-reply"
import { parseTeamGithubRepo } from "@/src/shared/adapters/github/github-installation"
import type { Env } from "@/src/shared/types/env"

const MAX_TEXT_CHARS = 2_000

type ProbeReason =
  | "retrieval_succeeded"
  | "indexed_but_no_relevant_chunks"
  | "no_repo_mapping"
  | "mapped_repo_not_indexed"
  | "retrieve_codebase_rejected"

interface ProbeBody {
  teamKey?: unknown
  issueTitle?: unknown
  question?: unknown
}

interface ProbeResponse {
  availableRepos: string[]
  mappedRepo: string | null
  repoStatus: string
  calledRetrieveCodebase: boolean
  retrievalNamespace: string | null
  chunkCount: number
  reason: ProbeReason
  error?: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export async function handleAdminLinearRetrievalProbeRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const parsed = await readProbeBody(request)
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const { teamKey, issueTitle, question } = parsed

  const teamRepo = parseTeamGithubRepo(env.OPENCLAW_TEAM_GITHUB_REPO_MAP, teamKey)
  if (!teamRepo) {
    return json(
      {
        availableRepos: [],
        mappedRepo: null,
        repoStatus: "unmapped",
        calledRetrieveCodebase: false,
        retrievalNamespace: null,
        chunkCount: 0,
        reason: "no_repo_mapping",
      } satisfies ProbeResponse,
      200,
    )
  }

  const scope = await resolveLinearAgentRepoScope(env, teamRepo)
  if (!scope.repo) {
    return json(
      {
        availableRepos: scope.availableRepos,
        mappedRepo: scope.mappedRepo,
        repoStatus: scope.status,
        calledRetrieveCodebase: false,
        retrievalNamespace: null,
        chunkCount: 0,
        reason: "mapped_repo_not_indexed",
      } satisfies ProbeResponse,
      200,
    )
  }

  const [tool] = createAgentTools({
    env,
    surface: "linear-mention",
    allowedRepos: scope.availableRepos,
  })
  const result = (await tool!.execute(
    {
      query: `${issueTitle}\n\n${question}`,
      repo: scope.repo,
    },
    new AbortController().signal,
    new Map(),
  )) as { ok?: boolean; repo?: unknown; count?: unknown; error?: unknown }

  if (result.ok !== true) {
    return json(
      {
        availableRepos: scope.availableRepos,
        mappedRepo: scope.mappedRepo,
        repoStatus: scope.status,
        calledRetrieveCodebase: true,
        retrievalNamespace: typeof result.repo === "string" ? result.repo : null,
        chunkCount: 0,
        reason: "retrieve_codebase_rejected",
        ...(typeof result.error === "string" ? { error: result.error } : {}),
      } satisfies ProbeResponse,
      200,
    )
  }

  const chunkCount = typeof result.count === "number" && Number.isFinite(result.count) ? result.count : 0
  return json(
    {
      availableRepos: scope.availableRepos,
      mappedRepo: scope.mappedRepo,
      repoStatus: scope.status,
      calledRetrieveCodebase: true,
      retrievalNamespace: typeof result.repo === "string" ? result.repo : scope.repo,
      chunkCount,
      reason: chunkCount > 0 ? "retrieval_succeeded" : "indexed_but_no_relevant_chunks",
    } satisfies ProbeResponse,
    200,
  )
}

type ParsedProbeBody =
  | { ok: true; teamKey: string; issueTitle: string; question: string }
  | { ok: false; error: string }

async function readProbeBody(request: Request): Promise<ParsedProbeBody> {
  let body: ProbeBody
  try {
    body = (await request.json()) as ProbeBody
  } catch {
    return { ok: false, error: "invalid_json" }
  }

  const teamKey = typeof body.teamKey === "string" ? body.teamKey.trim() : ""
  const issueTitle = truncateText(typeof body.issueTitle === "string" ? body.issueTitle.trim() : "")
  const question = truncateText(typeof body.question === "string" ? body.question.trim() : "")
  if (!teamKey) return { ok: false, error: "missing_team_key" }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(teamKey)) return { ok: false, error: "invalid_team_key" }
  if (!question) return { ok: false, error: "missing_question" }
  return {
    ok: true,
    teamKey,
    issueTitle: issueTitle || "(no title)",
    question,
  }
}

function truncateText(input: string): string {
  return input.length <= MAX_TEXT_CHARS ? input : input.slice(0, MAX_TEXT_CHARS)
}
