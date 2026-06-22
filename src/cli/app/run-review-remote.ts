// SIG-304 Phase 2.2/2.4 — the HOSTED (thin-client) review drivers. They POST to the
// Sigilix `/v1/review` endpoint with the user's $SIGILIX_API_KEY and return the
// DryRunReview the renderers consume. The engine runs SERVER-SIDE on our models —
// this module imports NO engine code (only the `DryRunReview` TYPE, erased at build),
// so it can be bundled into a published thin client that ships no moat (Phase 2.3).
//
//   runReviewRemote          — Mode A: computes the LOCAL diff via read-only git and
//                              posts it (ungrounded, no GitHub token needed).
//   runReviewRemoteGrounded  — Mode B: posts a PR reference; the server fetches the PR
//                              via its GitHub App and reviews it GROUNDED. No token,
//                              no local diff — the client only names owner/repo/#.

import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import { localGitClient } from "@/src/cli/adapters/local-git-client"

export interface RunReviewRemoteArgs {
  /** Base URL of the Sigilix API, e.g. https://api.sigilix.ai (no trailing /v1). */
  endpoint: string
  /** The user's hosted key ($SIGILIX_API_KEY) → server-side OpenRouter, no BYO key. */
  apiKey: string
  /** owner/repo only label the run server-side (local sources use stubs). */
  owner: string
  repo: string
  /** Local-git source: working tree (`--uncommitted`) or `<base>...HEAD` (`--diff`). */
  git: { cwd: string; base?: string }
}

export interface RunReviewRemoteGroundedArgs {
  endpoint: string
  apiKey: string
  /** A REAL GitHub PR (the server resolves the App installation for owner/repo). */
  owner: string
  repo: string
  prNumber: number
}

interface ApiError {
  error?: string
  detail?: string
}

/**
 * POST a review request and return the built review. `allowEmpty` controls the
 * recall-safety contract for a 200 body: Mode A pre-checks empty diffs so a server
 * `null` is malformed (→ throw); Mode B can't pre-check, so a server `null` legitimately
 * means "the PR had nothing to review" (→ return null). A non-object / verdict-less
 * body is ALWAYS malformed (a degraded server / proxy error page must never read as a
 * clean pass), as is any transport or non-2xx error.
 */
async function postReview(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  allowEmpty: boolean,
): Promise<DryRunReview | null> {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/review`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`sigilix: could not reach ${url} (${err instanceof Error ? err.message : String(err)})`)
  }

  if (!res.ok) {
    let detail = ""
    try {
      const errBody = (await res.json()) as ApiError
      detail = errBody.detail ?? errBody.error ?? ""
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401)
      throw new Error("sigilix: hosted review rejected the API key (401) — check $SIGILIX_API_KEY")
    throw new Error(`sigilix: hosted review failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`)
  }

  const parsed = (await res.json().catch(() => undefined)) as unknown
  if (parsed === null && allowEmpty) return null // server had nothing to review (Mode B)
  if (parsed === null || typeof parsed !== "object" || !("verdict" in parsed)) {
    throw new Error("sigilix: hosted review returned a malformed response (no verdict)")
  }
  return parsed as DryRunReview
}

/**
 * Mode A (diff-only): run a review of the LOCAL diff against the hosted endpoint and
 * return the built review (or null when the diff is empty). Throws on a transport or
 * server error so the bin surfaces it + exits non-zero (recall-safety).
 */
export async function runReviewRemote(args: RunReviewRemoteArgs): Promise<DryRunReview | null> {
  const git = localGitClient(args.git)
  const meta = await git.getPullRequest(args.owner, args.repo, 0)
  const headSha = meta.head.sha // "" when `git rev-parse HEAD` fails
  if (!headSha) throw new Error("sigilix: could not resolve HEAD for the local diff")
  const diff = await git.getPullRequestDiff(args.owner, args.repo, 0)
  if (diff.trim() === "") return null // nothing changed → nothing to review

  // allowEmpty=false: Mode A already short-circuited the empty case above, so a server
  // null is a malformed success, never a clean pass.
  return postReview(
    args.endpoint,
    args.apiKey,
    {
      owner: args.owner,
      repo: args.repo,
      prNumber: 0,
      headSha,
      baseSha: meta.base.sha,
      diff,
    },
    false,
  )
}

/**
 * Mode B (grounded): run a GROUNDED review of a real GitHub PR against the hosted
 * endpoint — the server fetches the PR via its App, so no token / local clone is
 * needed. Returns null when the PR had nothing to review. Throws on a transport or
 * server error (recall-safety: a failed hosted review must never read as a clean pass).
 */
export async function runReviewRemoteGrounded(args: RunReviewRemoteGroundedArgs): Promise<DryRunReview | null> {
  // allowEmpty=true: the client can't pre-check a remote PR, so a server null here is
  // the legitimate "nothing to review" signal (not a malformed body).
  return postReview(
    args.endpoint,
    args.apiKey,
    {
      mode: "grounded",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
    },
    true,
  )
}
