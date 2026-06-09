import type { Env } from "../shared/types/env"
import type { GitHubClient } from "../shared/adapters/github"

const DRAFT_SKIP_MARKER = "<!-- sigilix:draft-skip -->"
const DRAFT_SKIP_KV_PREFIX = "pr-draft-skip-notice:"
const DRAFT_SKIP_KV_TTL_SECONDS = 24 * 60 * 60

function headMarker(headSha: string): string {
  return `<!-- sigilix:draft-skip-head:${headSha.slice(0, 7)} -->`
}

function kvKey(owner: string, repo: string, prNumber: number, headSha: string): string {
  return `${DRAFT_SKIP_KV_PREFIX}${owner}/${repo}#${prNumber}:${headSha}`
}

export function renderDraftSkipNotice(headSha: string): string {
  const shortSha = headSha.slice(0, 7)
  return [
    DRAFT_SKIP_MARKER,
    headMarker(headSha),
    "",
    "## Sigilix review skipped",
    "",
    "**Draft detected.**",
    "",
    "Automatic review is skipped while this PR is a draft. Mark it ready for review to run Sigilix automatically, or comment `/sigilix review` to trigger one manually.",
    "",
    `Commit: \`${shortSha}\``,
  ].join("\n")
}

export function renderDraftSkipSupersededNotice(headSha: string): string {
  const shortSha = headSha.slice(0, 7)
  return [
    DRAFT_SKIP_MARKER,
    "",
    "## Sigilix review resumed",
    "",
    "This PR is ready for review. The earlier draft-skip notice has been superseded by the normal review run.",
    "",
    `Current commit: \`${shortSha}\``,
  ].join("\n")
}

async function findDraftSkipComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ id: number; body: string } | null> {
  const comments = await client.listIssueComments(owner, repo, prNumber)
  const existing = comments.find(
    (c) => typeof c.body === "string" && c.body.includes(DRAFT_SKIP_MARKER),
  )
  return existing ? { id: existing.id, body: existing.body } : null
}

async function rememberCommentId(
  env: Env,
  key: string,
  commentId: number,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, String(commentId), {
      expirationTtl: DRAFT_SKIP_KV_TTL_SECONDS,
    })
  } catch {
    // Best-effort cache warm. GitHub-side marker scan remains authoritative.
  }
}

export type DraftSkipNoticeResult =
  | { kind: "posted"; commentId: number }
  | { kind: "updated"; commentId: number }
  | { kind: "kv-hit"; commentId: number }
  | { kind: "skipped"; reason: "missing-headsha" }
  | { kind: "failed"; err: string }

export async function postDraftPrSkipNotice(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): Promise<DraftSkipNoticeResult> {
  const { env, client, owner, repo, prNumber, headSha } = args
  if (!headSha) return { kind: "skipped", reason: "missing-headsha" }

  const key = kvKey(owner, repo, prNumber, headSha)
  const body = renderDraftSkipNotice(headSha)

  try {
    const cached = await env.OPENCLAW_STATE.get(key)
    if (cached !== null) {
      const parsed = Number(cached)
      if (Number.isFinite(parsed) && parsed > 0) {
        const cachedComment = await client.getIssueComment(owner, repo, parsed)
        if (cachedComment?.body === body) {
          return { kind: "kv-hit", commentId: parsed }
        }
        if (cachedComment?.body.includes(DRAFT_SKIP_MARKER)) {
          await client.updateIssueComment(owner, repo, parsed, body)
          await rememberCommentId(env, key, parsed)
          console.log(JSON.stringify({
            event: "pr-draft-skip-notice-updated",
            owner, repo, prNumber,
            headSha: headSha.slice(0, 7),
            commentId: parsed,
            source: "kv",
          }))
          return { kind: "updated", commentId: parsed }
        }
        await env.OPENCLAW_STATE.delete(key)
      }
    }
  } catch {
    // Fall through to the GitHub-side marker scan.
  }

  try {
    const existing = await findDraftSkipComment(client, owner, repo, prNumber)
    if (existing) {
      if (existing.body !== body) {
        await client.updateIssueComment(owner, repo, existing.id, body)
      }
      await rememberCommentId(env, key, existing.id)
      console.log(JSON.stringify({
        event: "pr-draft-skip-notice-updated",
        owner, repo, prNumber,
        headSha: headSha.slice(0, 7),
        commentId: existing.id,
      }))
      return { kind: "updated", commentId: existing.id }
    }

    const created = await client.createIssueComment(owner, repo, prNumber, body)
    await rememberCommentId(env, key, created.id)
    console.log(JSON.stringify({
      event: "pr-draft-skip-notice-posted",
      owner, repo, prNumber,
      headSha: headSha.slice(0, 7),
      commentId: created.id,
    }))
    return { kind: "posted", commentId: created.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({
      event: "pr-draft-skip-notice-failed",
      owner, repo, prNumber,
      headSha: headSha.slice(0, 7),
      err: msg,
    }))
    return { kind: "failed", err: msg }
  }
}

export async function supersedeDraftPrSkipNotice(args: {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): Promise<{ kind: "updated"; commentId: number } | { kind: "not-found" } | { kind: "failed"; err: string }> {
  const { client, owner, repo, prNumber, headSha } = args
  try {
    const existing = await findDraftSkipComment(client, owner, repo, prNumber)
    if (!existing) return { kind: "not-found" }
    await client.updateIssueComment(
      owner,
      repo,
      existing.id,
      renderDraftSkipSupersededNotice(headSha),
    )
    console.log(JSON.stringify({
      event: "pr-draft-skip-notice-superseded",
      owner, repo, prNumber,
      headSha: headSha.slice(0, 7),
      commentId: existing.id,
    }))
    return { kind: "updated", commentId: existing.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({
      event: "pr-draft-skip-notice-supersede-failed",
      owner, repo, prNumber,
      headSha: headSha.slice(0, 7),
      err: msg,
    }))
    return { kind: "failed", err: msg }
  }
}
