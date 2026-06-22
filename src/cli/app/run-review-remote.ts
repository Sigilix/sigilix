// SIG-304 Phase 2.2 — the HOSTED (thin-client) review driver. Computes the local
// diff via read-only git, POSTs it to the Sigilix `/v1/review` endpoint with the
// user's $SIGILIX_API_KEY, and returns the DryRunReview the renderers consume. The
// engine runs SERVER-SIDE on our models — this module imports NO engine code (only
// the `DryRunReview` TYPE, erased at build), so it can be bundled into a published
// thin client that ships no moat (SIG-304 Phase 2.3).

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

interface ApiError {
  error?: string
  detail?: string
}

/**
 * Run a review against the HOSTED endpoint and return the built review (or null when
 * the diff is empty / the server had nothing to review). Throws on a transport or
 * server error so the bin surfaces it + exits non-zero (recall-safety: a failed
 * hosted review must never read as a clean pass).
 */
export async function runReviewRemote(args: RunReviewRemoteArgs): Promise<DryRunReview | null> {
  const git = localGitClient(args.git)
  const meta = await git.getPullRequest(args.owner, args.repo, 0)
  const headSha = meta.head.sha // "" when `git rev-parse HEAD` fails
  if (!headSha) throw new Error("sigilix: could not resolve HEAD for the local diff")
  const diff = await git.getPullRequestDiff(args.owner, args.repo, 0)
  if (diff.trim() === "") return null // nothing changed → nothing to review

  const url = `${args.endpoint.replace(/\/+$/, "")}/v1/review`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        owner: args.owner,
        repo: args.repo,
        prNumber: 0,
        headSha,
        baseSha: meta.base.sha,
        diff,
      }),
    })
  } catch (err) {
    throw new Error(`sigilix: could not reach ${url} (${err instanceof Error ? err.message : String(err)})`)
  }

  if (!res.ok) {
    let detail = ""
    try {
      const body = (await res.json()) as ApiError
      detail = body.detail ?? body.error ?? ""
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401)
      throw new Error("sigilix: hosted review rejected the API key (401) — check $SIGILIX_API_KEY")
    throw new Error(`sigilix: hosted review failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`)
  }

  // RECALL-SAFETY: a 200 MUST carry a real verdict. A null / non-object / verdict-less
  // body (a degraded server, a proxy/CDN error page) is a malformed success — throw,
  // never render it as a clean pass. The ONLY legitimate null is the pre-fetch
  // empty-diff short-circuit above.
  const body = (await res.json().catch(() => undefined)) as unknown
  if (body === null || typeof body !== "object" || !("verdict" in body)) {
    throw new Error("sigilix: hosted review returned a malformed response (no verdict)")
  }
  return body as DryRunReview
}
