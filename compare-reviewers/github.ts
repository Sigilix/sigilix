// SIG-70 — thin GitHub fetch layer (via the `gh` CLI).
//
// The only module that touches the network. `gh` must be authenticated for
// the target repo. We use `gh api --paginate --slurp` so multi-page responses
// come back as a single JSON array-of-pages we can flatten — no hand-rolled
// concatenated-JSON parsing. Not unit-tested (needs the network + auth),
// mirroring the IO layers of the other offline scripts.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { RawComment } from "./normalize"

const exec = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { maxBuffer: MAX_BUFFER })
  return stdout
}

async function ghJson<T>(args: string[]): Promise<T> {
  const raw = await gh(args)
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`gh ${args.join(" ")} returned non-JSON: ${(err as Error).message}`)
  }
}

/** Fetch the PR's canonical html_url (also confirms the PR exists). */
export async function fetchPrUrl(owner: string, repo: string, pr: number): Promise<string> {
  const obj = await ghJson<{ html_url?: string }>([
    "api",
    `repos/${owner}/${repo}/pulls/${pr}`,
    "--jq",
    "{ html_url: .html_url }",
  ])
  return obj.html_url ?? `https://github.com/${owner}/${repo}/pull/${pr}`
}

/**
 * Fetch every inline review comment on the PR (all pages). The caller filters
 * to the bot logins it cares about — GitHub's API has no author-filter param.
 */
export async function fetchReviewComments(
  owner: string,
  repo: string,
  pr: number,
): Promise<RawComment[]> {
  // `--slurp` wraps each page's array in an outer array → flatten to one list.
  const pages = await ghJson<RawComment[][]>([
    "api",
    "--paginate",
    "--slurp",
    `repos/${owner}/${repo}/pulls/${pr}/comments?per_page=100`,
  ])
  return pages.flat()
}
