// ARC-185: post a top-level PR comment when `sigilix.json` fails to
// parse during slash-command dispatch. Designed to be idempotent:
// the same head SHA produces the same comment exactly once, even
// across concurrent webhooks and KV cold edges.
//
// Spec: docs/superpowers/specs/2026-05-06-arc-185-per-command-config-design.md §5.4
//
// Dedupe strategy (defense in depth):
//   1. KV fast-path (1-day TTL) — `config-error-posted:<owner>/<repo>#<n>:<headSha>`.
//   2. GitHub-side authoritative — list issue comments, search for the
//      head-SHA-keyed marker substring `<!-- sigilix:config-error:<sha7> -->`.
//      Found → KV is warmed and the post is skipped.
//
// New head SHA → new marker → new comment (correctly).
// Same head SHA → same marker → idempotent.

import type { GitHubClient } from "./github"
import type { Env } from "../shared/types/env"

const RAW_SNIPPET_MAX = 500
const KV_TTL_SECONDS = 24 * 60 * 60 // 1 day

function buildMarker(headSha: string): string {
  return `<!-- sigilix:config-error:${headSha.slice(0, 7)} -->`
}

// SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read both
// markers so a config-error comment posted pre-rebrand against the
// same head SHA still dedupes the post and warms the KV fast path
// instead of creating a duplicate. Writes still emit the new
// `sigilix:*` form via `buildMarker`. Drop the legacy half once all
// pre-2026-05-18 PRs close.
function buildLegacyMarker(headSha: string): string {
  return `<!-- openclaw:config-error:${headSha.slice(0, 7)} -->`
}

function buildKvKey(owner: string, repo: string, prNumber: number, headSha: string): string {
  return `config-error-posted:${owner}/${repo}#${prNumber}:${headSha.slice(0, 7)}`
}

function renderBody(reason: string, raw: string, headSha: string): string {
  const snippet = raw.length > RAW_SNIPPET_MAX
    ? raw.slice(0, RAW_SNIPPET_MAX) + "\n…[truncated]"
    : raw
  return [
    buildMarker(headSha),
    "",
    "⚠️ **Sigilix config parse error**",
    "",
    `Your repo's \`sigilix.json\` couldn't be parsed: ${reason}. Sigilix is running with default config — fix the file at the PR head and the next push will pick it up.`,
    "",
    "<details>",
    "<summary>Raw config (first 500 chars)</summary>",
    "",
    "```",
    snippet,
    "```",
    "",
    "</details>",
  ].join("\n")
}

export interface PostConfigErrorCommentArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  reason: string
  raw: string
}

export type PostResult =
  | { kind: "posted"; commentId: number }
  | { kind: "suppressed"; reason: "kv-dedupe" | "github-dedupe" }
  | { kind: "skipped"; reason: "missing-headsha" }
  | { kind: "failed"; err: string }

/**
 * Idempotently post the config-parse-error PR comment.
 *
 * Telemetry:
 *   - `command-config-error-comment-posted` on successful new post
 *   - `command-config-error-comment-suppressed-dedupe` on KV / GH dedupe hit
 *   - `command-config-error-comment-failed` on unrecoverable failure
 *
 * Returns a discriminated result so the caller can decide what to log
 * without re-listing comments. Best-effort — never throws.
 */
export async function postConfigErrorComment(
  args: PostConfigErrorCommentArgs,
): Promise<PostResult> {
  const { env, client, owner, repo, prNumber, headSha, reason, raw } = args
  if (!headSha) {
    return { kind: "skipped", reason: "missing-headsha" }
  }

  const marker = buildMarker(headSha)
  // SIG-85: bilingual matcher — also recognize the legacy
  // `<!-- openclaw:config-error:<sha7> -->` marker on the GitHub-side
  // dedupe scan below.
  const legacyMarker = buildLegacyMarker(headSha)
  const kvKey = buildKvKey(owner, repo, prNumber, headSha)

  // KV fast-path dedupe.
  try {
    const existing = await env.OPENCLAW_STATE.get(kvKey)
    if (existing) {
      console.log(JSON.stringify({
        event: "command-config-error-comment-suppressed-dedupe",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        source: "kv",
      }))
      return { kind: "suppressed", reason: "kv-dedupe" }
    }
  } catch {
    // KV read failure → fall through to GitHub-side check.
  }

  // GitHub-side authoritative dedupe — list comments and search for
  // the marker substring. Catches the cold-KV case after TTL expiry.
  try {
    const comments = await client.listIssueComments(owner, repo, prNumber)
    const existing = comments.find(
      (c) =>
        typeof c.body === "string" &&
        (c.body.includes(marker) || c.body.includes(legacyMarker)),
    )
    if (existing) {
      // Warm the KV fast path so the next webhook short-circuits.
      try {
        await env.OPENCLAW_STATE.put(kvKey, String(existing.id), {
          expirationTtl: KV_TTL_SECONDS,
        })
      } catch {
        // Best-effort warm — ignore.
      }
      console.log(JSON.stringify({
        event: "command-config-error-comment-suppressed-dedupe",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        source: "github",
        commentId: existing.id,
      }))
      return { kind: "suppressed", reason: "github-dedupe" }
    }
  } catch (err) {
    // Listing comments failed — proceed to post anyway. Worst case is
    // a duplicate comment which the user can resolve by deleting one.
    console.error(JSON.stringify({
      event: "command-config-error-comment-list-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  // Post the comment.
  try {
    const body = renderBody(reason, raw, headSha)
    const out = await client.createIssueComment(owner, repo, prNumber, body)
    try {
      await env.OPENCLAW_STATE.put(kvKey, String(out.id), {
        expirationTtl: KV_TTL_SECONDS,
      })
    } catch {
      // Comment posted; KV warm-up failed. Next webhook will GH-search
      // and find the comment. Acceptable degradation.
    }
    console.log(JSON.stringify({
      event: "command-config-error-comment-posted",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
      commentId: out.id,
    }))
    return { kind: "posted", commentId: out.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "command-config-error-comment-failed",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
      err: msg,
    }))
    return { kind: "failed", err: msg }
  }
}
