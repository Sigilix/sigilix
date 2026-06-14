import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"
import { findExistingOverviewComment } from "./triage-pr-overview-scan"
import { type ReviewStatusPhase, type ReviewStatusSnapshot, upsertReviewStatusBlock } from "./pr-review-status-render"

const DO_BASE_URL = "https://do.internal"

export type ReviewStatusUpdate = Omit<ReviewStatusSnapshot, "headSha" | "sequence"> & {
  headSha?: string
}

export type StatusProgressOutcome =
  | { accepted: true; phase: ReviewStatusPhase }
  | { accepted: false; phase?: ReviewStatusPhase; reason: string }

export type StatusCommentPatchOutcome = { kind: "updated"; commentId: number } | { kind: "missing-overview" }

export interface ReviewStatusReporter {
  report(update: ReviewStatusUpdate): void
  flush(): Promise<void>
}

export interface CreateReviewStatusReporterArgs {
  runId: string
  headSha: string
  postStatusProgress: (snapshot: ReviewStatusSnapshot) => Promise<StatusProgressOutcome>
  patchOverviewComment: (snapshot: ReviewStatusSnapshot) => Promise<StatusCommentPatchOutcome>
  waitUntil?: (promise: Promise<void>) => void
}

export function createReviewStatusReporter(args: CreateReviewStatusReporterArgs): ReviewStatusReporter {
  let sequence = 0
  let chain: Promise<void> = Promise.resolve()

  const report = (update: ReviewStatusUpdate): void => {
    sequence += 1
    const snapshot: ReviewStatusSnapshot = {
      ...update,
      headSha: update.headSha ?? args.headSha,
      sequence,
    }
    const work = chain
      .then(async () => {
        const progress = await args.postStatusProgress(snapshot)
        if (!progress.accepted) return
        await args.patchOverviewComment(snapshot)
      })
      .catch((err) => {
        console.warn(
          JSON.stringify({
            event: "pr-review-status-comment-update-failed",
            runId: args.runId,
            phase: snapshot.phase,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      })
    chain = work.then(
      () => undefined,
      () => undefined,
    )
    args.waitUntil?.(chain)
  }

  return {
    report,
    flush: () => chain,
  }
}

export interface CreatePrReviewStatusReporterArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  runId: string
  installationId: number
  doStub: DurableObjectStub
  waitUntil?: (promise: Promise<void>) => void
}

export function createPrReviewStatusReporter(args: CreatePrReviewStatusReporterArgs): ReviewStatusReporter {
  let clientPromise: Promise<GitHubClient> | null = null
  const client = (): Promise<GitHubClient> => {
    clientPromise ??= buildStatusClient(args.env, args.installationId)
    return clientPromise
  }
  return createReviewStatusReporter({
    runId: args.runId,
    headSha: args.headSha,
    ...(args.waitUntil !== undefined ? { waitUntil: args.waitUntil } : {}),
    postStatusProgress: (snapshot) => postStatusProgress(args.doStub, args.runId, snapshot),
    patchOverviewComment: async (snapshot) =>
      patchExistingOverviewStatusComment({
        client: await client(),
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        snapshot,
      }),
  })
}

export async function patchExistingOverviewStatusComment(args: {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  snapshot: ReviewStatusSnapshot
}): Promise<StatusCommentPatchOutcome> {
  const existing = await findExistingOverviewComment(args.client, args.owner, args.repo, args.prNumber)
  if (existing === null) {
    console.warn(
      JSON.stringify({
        event: "pr-review-status-comment-missing-overview",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        phase: args.snapshot.phase,
      }),
    )
    return { kind: "missing-overview" }
  }
  await args.client.updateIssueComment(
    args.owner,
    args.repo,
    existing.id,
    upsertReviewStatusBlock(existing.body, args.snapshot),
  )
  return { kind: "updated", commentId: existing.id }
}

async function postStatusProgress(
  doStub: DurableObjectStub,
  runId: string,
  snapshot: ReviewStatusSnapshot,
): Promise<StatusProgressOutcome> {
  const res = await doStub.fetch(`${DO_BASE_URL}/status-progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      sequence: snapshot.sequence,
      phase: snapshot.phase,
      snapshot,
    }),
  })
  try {
    return (await res.json()) as StatusProgressOutcome
  } catch {
    return { accepted: false, reason: `status-progress-${res.status}` }
  }
}

async function buildStatusClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
