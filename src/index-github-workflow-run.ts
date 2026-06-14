// GitHub workflow_run webhook handling, split from the main router to
// keep src/index-github-webhook.ts under the compliance line budget.

import type { Env } from "@/src/shared/types/env"
import type { GitHubWebhookPayload } from "@/src/index-internals"

export async function handleWorkflowRunEvent(args: {
  env: Env
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
}): Promise<Response> {
  const { env, payload, owner, repo, installationId } = args
  const action = payload.action
  const run = payload.workflow_run
  if (action !== "completed" || !run) {
    return new Response("skip workflow_run action\n", { status: 200 })
  }
  if (run.conclusion !== "failure") {
    return new Response("skip non-failure\n", { status: 200 })
  }
  const prRef = run.pull_requests?.[0]
  if (!prRef || typeof prRef.number !== "number") {
    return new Response("workflow_run not on a PR\n", { status: 200 })
  }
  const headSha = run.head_sha ?? prRef.head?.sha ?? ""
  if (!headSha) return new Response("missing head sha\n", { status: 400 })
  if (typeof run.id !== "number") return new Response("missing run id\n", { status: 400 })

  await env.OPENCLAW_JOBS.send({
    type: "ci-triage",
    owner,
    repo,
    prNumber: prRef.number,
    runId: run.id,
    headSha,
    installationId,
  })
  return new Response("queued\n", { status: 202 })
}
