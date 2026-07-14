// Fetch a PR's title/body/diff/files for a Linear @-mention that
// referenced the PR. Returns a `PrContext` injected into the prompt
// as ground truth for "what changed in PR #N" questions.
//
// Failure isolation: per-call timeouts (5s each) so a slow diff/files
// call doesn't kill the title/body the model could've used. The meta
// call (`getPullRequest`) is the only fatal one — without title we
// have no usable context.
//
// Per-error mapping distinguishes timeout from HTTP failures so the
// model isn't told a 403 was a timeout.

import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import type { PullRequestMeta, PrChangedFile } from "@/src/shared/types/github"
import { withTimeout } from "@/src/shared/util/with-timeout"
import type { Env } from "@/src/shared/types/env"

const TIMEOUT_MS = 5_000
const BODY_MAX_CHARS = 2_000
const FILES_MAX = 50
const DIFF_LINE_MAX_CHARS = 1_500
const DIFF_LINES_MAX = 250
const DIFF_TOTAL_CHARS_MAX = 20_000

const VALID_STATES = new Set(["open", "closed", "merged"])

export type PrFetchResult =
  | { ok: true; context: PrContext }
  | {
      ok: false
      reason: "no_installation" | "not_found" | "forbidden" | "timeout" | "error"
    }

export interface PrContext {
  owner: string
  repo: string
  number: number
  title: string
  body: string
  diff: string | "[timeout]" | "[error]" | "[truncated]"
  filesChanged: { items: string[]; total: number } | "[timeout]" | "[error]"
  state: "open" | "closed" | "merged"
  mergedAt: string | null
}

export interface FetchPrContextFromEnvArgs {
  owner: string
  repo: string
  number: number
  env: Env
}

export interface FetchPrContextWithClientArgs {
  owner: string
  repo: string
  number: number
  client: GitHubClient
}

/** Resolve an installation from the operator map for the Linear linked-PR
 * path, then delegate to the client-bound fetcher. Tenant-scoped callers must
 * use `fetchPullRequestContextWithClient` so this mutable map cannot replace
 * an already-authorized installation client. */
export async function fetchPullRequestContextFromEnv(args: FetchPrContextFromEnvArgs): Promise<PrFetchResult> {
  const { owner, repo, number, env } = args

  const lookup = resolveInstallation(owner, repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
  if (!lookup.ok) return { ok: false, reason: "no_installation" }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return { ok: false, reason: "no_installation" }
  }

  let client: GitHubClient
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: lookup.installationId,
    })
    client = new GitHubClient({ token })
  } catch (error) {
    console.warn("[gh-pr-context] installation token failed", {
      owner,
      repo,
      number,
      error: String(error),
    })
    return { ok: false, reason: "error" }
  }

  return fetchPullRequestContextWithClient({ owner, repo, number, client })
}

/** Fetch PR context using exactly the caller-supplied GitHub client. The
 * client is the authorization boundary: this function does not inspect env,
 * resolve an installation, mint a token, or construct a replacement client. */
export async function fetchPullRequestContextWithClient(args: FetchPrContextWithClientArgs): Promise<PrFetchResult> {
  const { owner, repo, number, client } = args

  // Meta is the only fatal call — without title/body we abort entirely.
  let meta: PullRequestMeta
  try {
    meta = await withTimeout((signal) => client.getPullRequest(owner, repo, number, { signal }), TIMEOUT_MS)
  } catch (error) {
    return { ok: false, reason: mapTopLevelError(error) }
  }

  // Diff and files are best-effort: each gets its own timeout, and a
  // failure of one does not block the other.
  const [diffResult, filesResult] = await Promise.all([
    fetchDiffPartial(client, owner, repo, number),
    fetchFilesPartial(client, owner, repo, number),
  ])

  const totalChanged = typeof meta.changed_files === "number" ? meta.changed_files : null

  const filesChanged: PrContext["filesChanged"] =
    filesResult.kind === "items"
      ? {
          items: filesResult.items.map((f) => f.filename).filter((s) => s.length > 0),
          total: totalChanged ?? filesResult.items.length,
        }
      : filesResult.kind === "timeout"
        ? "[timeout]"
        : "[error]"

  return {
    ok: true,
    context: {
      owner,
      repo,
      number,
      title: meta.title ?? "",
      body: truncate(meta.body ?? "", BODY_MAX_CHARS),
      diff: diffResult,
      filesChanged,
      state: normalizeState(meta),
      mergedAt: meta.merged_at ?? null,
    },
  }
}

type FilesPartial = { kind: "items"; items: PrChangedFile[] } | { kind: "timeout" } | { kind: "error" }

async function fetchDiffPartial(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PrContext["diff"]> {
  try {
    const raw = await withTimeout((signal) => client.getPullRequestDiff(owner, repo, number, { signal }), TIMEOUT_MS)
    return truncateDiff(raw ?? "")
  } catch (error) {
    return isAbortError(error) ? "[timeout]" : "[error]"
  }
}

async function fetchFilesPartial(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<FilesPartial> {
  try {
    const items = await withTimeout(
      (signal) =>
        client.listPullRequestFiles(owner, repo, number, {
          perPage: 100,
          maxFiles: FILES_MAX,
          signal,
        }),
      TIMEOUT_MS,
    )
    return { kind: "items", items }
  } catch (error) {
    return { kind: isAbortError(error) ? "timeout" : "error" }
  }
}

type FailReason = Extract<PrFetchResult, { ok: false }>["reason"]

function mapTopLevelError(error: unknown): FailReason {
  if (isAbortError(error)) return "timeout"
  if (error instanceof GitHubHttpError) {
    if (error.status === 404) return "not_found"
    if (error.status === 403) return "forbidden"
  }
  return "error"
}

function isAbortError(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name
    return typeof name === "string" && name === "AbortError"
  }
  return false
}

/**
 * Triple-bounded diff truncation:
 *   1. Per-line cap at DIFF_LINE_MAX_CHARS so a minified single line
 *      can't bomb the prompt.
 *   2. Line-count cap at DIFF_LINES_MAX.
 *   3. Total-char cap at DIFF_TOTAL_CHARS_MAX as final safety net.
 */
function truncateDiff(raw: string): string {
  const lines = raw.split("\n")
  const cappedLines = lines.map((line) =>
    line.length > DIFF_LINE_MAX_CHARS ? `${line.slice(0, DIFF_LINE_MAX_CHARS)} […line truncated…]` : line,
  )
  const truncatedLines =
    cappedLines.length > DIFF_LINES_MAX
      ? cappedLines.slice(0, DIFF_LINES_MAX).concat([`[…+${cappedLines.length - DIFF_LINES_MAX} more lines truncated]`])
      : cappedLines
  let joined = truncatedLines.join("\n")
  if (joined.length > DIFF_TOTAL_CHARS_MAX) {
    const marker = "\n[…truncated to char cap…]"
    joined = joined.slice(0, DIFF_TOTAL_CHARS_MAX - marker.length) + marker
  }
  return joined
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * GitHub REST `state` is only "open" or "closed" — "merged" is inferred
 * from `merged_at`. Defensive runtime check (TypeScript union doesn't
 * enforce at runtime, and a malformed payload could otherwise inject
 * arbitrary values into the state attribute).
 */
function normalizeState(meta: PullRequestMeta): "open" | "closed" | "merged" {
  const raw = typeof meta.state === "string" ? meta.state : "closed"
  if (raw === "closed" && meta.merged_at) return "merged"
  if (VALID_STATES.has(raw)) return raw as "open" | "closed" | "merged"
  return "closed"
}
