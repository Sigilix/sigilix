// SIG-304 Phase 2.1 — a DIFF-BACKED GitHubClient for POST /v1/review Mode A
// (diff-only, ungrounded). The caller POSTs a unified diff + PR meta; this client
// structurally satisfies the engine's GitHubPort (+ the extra methods the dry-run
// orchestrator calls) by serving everything from that diff — no GitHub API, no repo
// content. `getFileContent` returns null (no working tree → the engine reviews the
// diff alone, which IS the ungrounded Mode-A tier). All write/publish methods throw
// (never reached under dryRun). Mirrors src/cli/adapters/local-git-client.ts, but
// the diff is a request field instead of being shelled from git.

import type { GitHubPort } from "@/src/lib/ensemble/ports/github"
import type { PrChangedFile, PrCommit, PullRequestMeta } from "@/src/shared/types/github"

export interface DiffReviewArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha?: string
  /** The full unified diff (`git diff <base>...<head>`) to review. */
  diff: string
}

const STATUS = (code: string): string =>
  code === "A" ? "added" : code === "D" ? "removed" : code === "R" ? "renamed" : code === "C" ? "copied" : "modified"

interface ParsedFile {
  filename: string
  previousFilename: string | null
  status: string
  additions: number
  deletions: number
  patch: string
}

/** Parse a unified diff into per-file entries (status + line counts + per-file patch). */
export function parseUnifiedDiff(diff: string): ParsedFile[] {
  const out: ParsedFile[] = []
  // Each file section starts with "diff --git a/<old> b/<new>".
  const sections = diff.split(/^diff --git /m)
  for (const raw of sections) {
    if (raw.trim() === "") continue
    const body = "diff --git " + raw
    const lines = body.split(/\r?\n/) // CRLF-safe: strip a trailing \r per line
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "")
    if (!m) continue
    const oldPath = m[1]!
    const newPath = m[2]!
    let code = "M"
    let previousFilename: string | null = null
    let additions = 0
    let deletions = 0
    for (const l of lines) {
      if (l.startsWith("new file mode")) code = "A"
      else if (l.startsWith("deleted file mode")) code = "D"
      else if (l.startsWith("rename from ")) {
        code = "R"
        previousFilename = l.slice("rename from ".length).trim()
      } else if (l.startsWith("copy from ")) {
        code = "C"
        previousFilename = l.slice("copy from ".length).trim()
      } else if (l.startsWith("+") && !l.startsWith("+++")) additions++
      else if (l.startsWith("-") && !l.startsWith("---")) deletions++
    }
    const filename = code === "D" ? oldPath : newPath
    if (filename) out.push({ filename, previousFilename, status: STATUS(code), additions, deletions, patch: body })
  }
  return out
}

/** The engine's injected-client surface (read-side GitHubPort + the extra methods
 *  the dry-run orchestrator calls). Cast to `GitHubClient` at the route; every
 *  method the engine touches on the dry-run path is implemented here. */
export type DiffReviewClient = GitHubPort & {
  getCommit(o: string, r: string, sha: string): Promise<{ headSha: string; treeSha: string; parents: string[] } | null>
  getPullRequestCommits(o: string, r: string, n: number): Promise<PrCommit[]>
  submitReview(o: string, r: string, n: number, review: unknown): Promise<{ id: number; state: string }>
  listIssueComments(o: string, r: string, n: number): Promise<unknown[]>
  listIssueCommentsPage(o: string, r: string, n: number, page: number): Promise<unknown[]>
  getIssueComment(o: string, r: string, id: number): Promise<unknown>
  createIssueComment(o: string, r: string, n: number, body: string): Promise<{ id: number }>
  updateIssueComment(o: string, r: string, id: number, body: string): Promise<unknown>
  deleteIssueComment(o: string, r: string, id: number): Promise<unknown>
}

export function diffReviewClient(args: DiffReviewArgs): DiffReviewClient {
  const parsed = parseUnifiedDiff(args.diff)
  const unavailable = (m: string): never => {
    throw new Error(`api-review-diff-client: ${m} is unavailable for a hosted diff-only (dry-run) review`)
  }

  return {
    async getPullRequest(): Promise<PullRequestMeta> {
      return {
        number: args.prNumber,
        title: `Hosted diff review (${args.owner}/${args.repo}#${args.prNumber})`,
        body: null,
        user: null,
        head: { sha: args.headSha, ref: "HEAD" },
        base: { sha: args.baseSha ?? args.headSha, ref: args.baseSha ?? "BASE" },
        state: "open",
      }
    },
    async getPullRequestDiff(): Promise<string> {
      return args.diff
    },
    async listPullRequestFiles(): Promise<PrChangedFile[]> {
      return parsed.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }))
    },
    async listPullFilesForManifest(): Promise<{
      overflow: boolean
      entries: Array<{ filename: string; previous_filename: string | null; status: string }>
    }> {
      return {
        overflow: false,
        entries: parsed.map((f) => ({ filename: f.filename, previous_filename: f.previousFilename, status: f.status })),
      }
    },
    // No repo content in diff-only mode → null (engine reviews the diff alone).
    async getFileContent(): Promise<string | null> {
      return null
    },
    async getRepoTree(): Promise<{ tree: Array<Record<string, unknown>>; truncated: boolean } | null> {
      return null
    },
    async getBranch(): Promise<{ headSha: string; treeSha: string } | null> {
      return null
    },
    async getMergeBase(): Promise<string | null> {
      return args.baseSha ?? null
    },
    async getCommit(): Promise<{ headSha: string; treeSha: string; parents: string[] } | null> {
      return null
    },
    async getPullRequestCommits(): Promise<PrCommit[]> {
      return []
    },
    async submitReview(): Promise<{ id: number; state: string }> {
      return unavailable("submitReview")
    },
    async listIssueComments(): Promise<unknown[]> {
      return []
    },
    async listIssueCommentsPage(): Promise<unknown[]> {
      return []
    },
    async getIssueComment(): Promise<unknown> {
      return null
    },
    async createIssueComment(): Promise<{ id: number }> {
      return unavailable("createIssueComment")
    },
    async updateIssueComment(): Promise<unknown> {
      return unavailable("updateIssueComment")
    },
    async deleteIssueComment(): Promise<unknown> {
      return unavailable("deleteIssueComment")
    },
    async listOpenPullRequests(): Promise<never[]> {
      return []
    },
    async listPullRequestReviews(): Promise<never[]> {
      return []
    },
  }
}
