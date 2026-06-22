// SIG-304 (review CLI) Phase 1b — a READ-ONLY git-backed client that structurally
// satisfies GitHubPort, so the review engine can review LOCAL changes (a working
// tree, or a `<base>...HEAD` range) with no GitHub API + no portal. Every method
// shells out to read-only git verbs (diff / show / rev-parse / ls-tree /
// merge-base) via execFile — never a mutating verb, so running it has zero side
// effects (the test asserts `git status` is unchanged afterward).
//
// `base` undefined ⇒ `--uncommitted` (working tree vs HEAD). Tracked changes come from
// `git diff HEAD`; untracked (new, non-ignored) files are ALSO reviewed (SIG-490 — new
// files are the highest-risk pre-commit code) as new-file diffs via the read-only
// `git diff --no-index /dev/null <f>` (NO index-mutating `add -N`).
// `base` set ⇒ `--diff <base>` (the PR-style `<base>...HEAD` range; untracked irrelevant).

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { GitHubPort } from "@/src/lib/ensemble/ports/github"
import type { PrChangedFile, PrCommit, PullRequestMeta } from "@/src/shared/types/github"

const pexec = promisify(execFile)

const MAX_FILE_BYTES = 1_000_000 // mirror the GitHub client's >1MB → null

export interface LocalGitArgs {
  /** absolute path to the git working-tree root (`git rev-parse --show-toplevel`). */
  cwd: string
  /** base ref for `--diff <base>`; omit for `--uncommitted` (working tree vs HEAD). */
  base?: string
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await pexec("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
  return stdout
}
async function gitOrNull(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}
// `git diff --no-index /dev/null <file>` → a new-file diff for an UNTRACKED file, with
// NO index mutation (read-only). It exits 1 when there are differences (always, for a
// new file), which execFile surfaces as a rejection carrying `.stdout` — return that;
// exit >1 (e.g. a read error) → null (skip the file, never fail the review).
async function diffNoIndex(cwd: string, file: string): Promise<string | null> {
  try {
    // core.quotePath=false so the diff headers carry the REAL path (not C-quoted
    // `"caf\303\251.ts"`), matching how the file is named for the parser + renderer.
    return await git(cwd, ["-c", "core.quotePath=false", "diff", "--no-index", "--no-color", "/dev/null", file])
  } catch (e) {
    const err = e as { code?: number; stdout?: string }
    return err.code === 1 && typeof err.stdout === "string" ? err.stdout : null
  }
}

// `git diff` range: the working tree (HEAD) for --uncommitted, else `<base>...HEAD`.
const diffRange = (base: string | undefined): string[] => (base ? [`${base}...HEAD`] : ["HEAD"])

const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "modified",
}

/**
 * The review engine's injected-client surface: the read-side GitHubPort plus the
 * two extra methods the orchestrator calls on it — `getCommit` (graph receipt
 * join; flag-gated off in the local env) and `submitReview` (publish path, never
 * reached under dryRun). run-review-in-node casts this to `GitHubClient` (the
 * seam's declared type) at injection; every method the engine actually invokes is
 * implemented here, so the cast is sound.
 */
export type LocalReviewClient = GitHubPort & {
  getCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ headSha: string; treeSha: string; parents: string[] } | null>
  getPullRequestCommits(owner: string, repo: string, prNumber: number): Promise<PrCommit[]>
  submitReview(owner: string, repo: string, prNumber: number, review: unknown): Promise<{ id: number; state: string }>
  // Comment surface the overview pass references. Under dryRun only the reads run
  // (return empty — a local review has no GitHub comments); the writes are
  // publish-only and throw if ever reached.
  listIssueComments(owner: string, repo: string, prNumber: number): Promise<unknown[]>
  listIssueCommentsPage(owner: string, repo: string, prNumber: number, page: number): Promise<unknown[]>
  getIssueComment(owner: string, repo: string, commentId: number): Promise<unknown>
  createIssueComment(owner: string, repo: string, prNumber: number, body: string): Promise<{ id: number }>
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<unknown>
  deleteIssueComment(owner: string, repo: string, commentId: number): Promise<unknown>
}

export function localGitClient(args: LocalGitArgs): LocalReviewClient {
  const { cwd, base } = args

  async function changedFiles(): Promise<PrChangedFile[]> {
    // numstat → additions/deletions per path; name-status (-M) → status + renames.
    const [numraw, nameraw] = await Promise.all([
      gitOrNull(cwd, ["diff", "--numstat", "-M", ...diffRange(base)]),
      gitOrNull(cwd, ["diff", "--name-status", "-M", ...diffRange(base)]),
    ])
    const counts = new Map<string, { additions: number; deletions: number }>()
    for (const line of (numraw ?? "").split("\n")) {
      if (line.trim() === "") continue
      const [a, d, ...rest] = line.split("\t")
      const path = rest[rest.length - 1] ?? ""
      if (path) counts.set(path, { additions: Number(a) || 0, deletions: Number(d) || 0 })
    }
    const files: PrChangedFile[] = []
    for (const line of (nameraw ?? "").split("\n")) {
      if (line.trim() === "") continue
      const parts = line.split("\t")
      const code = (parts[0] ?? "").charAt(0)
      const filename = parts[parts.length - 1] ?? ""
      if (!filename) continue
      const c = counts.get(filename) ?? { additions: 0, deletions: 0 }
      files.push({ filename, status: STATUS_WORD[code] ?? "modified", additions: c.additions, deletions: c.deletions })
    }
    return files
  }

  // SIG-490: untracked (new, non-ignored) files for `--uncommitted`, each as a read-only
  // new-file diff. `git ls-files --others --exclude-standard` already honors .gitignore.
  // Oversized files (>MAX_FILE_BYTES) are skipped to bound the diff. [] for `--diff`.
  async function untrackedEntries(): Promise<Array<{ path: string; diff: string; additions: number }>> {
    if (base !== undefined) return []
    // `core.quotePath=false` → real paths, NOT C-quoted (`"caf\303\251.ts"`), so
    // diffNoIndex can actually find Unicode/space-named files instead of failing and
    // dropping them (the file would otherwise go unreviewed — a recall gap).
    const listRaw =
      (await gitOrNull(cwd, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"])) ?? ""
    const paths = listRaw.split("\n").filter((p) => p.trim() !== "")
    const out: Array<{ path: string; diff: string; additions: number }> = []
    for (const path of paths) {
      const diff = await diffNoIndex(cwd, path)
      // Skip: null/empty (exit >1, or a "Could not access" failure → exit 1 + empty stdout)
      // or oversized. A new file's diff is non-empty; an empty result means we couldn't read it.
      if (!diff || diff.length > MAX_FILE_BYTES) continue
      const additions = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
      // additions === 0 ⇒ a binary file ("Binary files … differ", no + lines) or an empty
      // file → nothing reviewable, and pushing it would inject a phantom `added` entry.
      if (additions === 0) continue
      out.push({ path, diff, additions })
    }
    return out
  }

  return {
    async getPullRequest(_owner: string, _repo: string, prNumber: number): Promise<PullRequestMeta> {
      const headSha = (await gitOrNull(cwd, ["rev-parse", "HEAD"]))?.trim() ?? ""
      const baseRef = base ?? "HEAD"
      const baseSha = (await gitOrNull(cwd, ["rev-parse", baseRef]))?.trim() ?? headSha
      const headRef = (await gitOrNull(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? "HEAD"
      return {
        number: prNumber,
        title: base ? `Local diff ${base}...HEAD` : "Local uncommitted changes",
        body: null,
        user: null,
        head: { sha: headSha, ref: headRef },
        base: { sha: baseSha, ref: baseRef },
        state: "open",
      }
    },

    async getPullRequestDiff(): Promise<string> {
      const tracked = await git(cwd, ["diff", ...diffRange(base)])
      // --uncommitted: append untracked new-file diffs so new files get reviewed (SIG-490).
      const untracked = (await untrackedEntries()).map((e) => e.diff).join("")
      return untracked ? tracked + untracked : tracked
    },

    async listPullRequestFiles(): Promise<PrChangedFile[]> {
      const files = await changedFiles()
      for (const e of await untrackedEntries()) {
        files.push({ filename: e.path, status: "added", additions: e.additions, deletions: 0 })
      }
      return files
    },

    async listPullFilesForManifest(): Promise<{
      overflow: boolean
      entries: Array<{ filename: string; previous_filename: string | null; status: string }>
    }> {
      // name-status with -M so renames carry the old path (parts: [Rxxx, old, new]).
      const raw = (await gitOrNull(cwd, ["diff", "--name-status", "-M", ...diffRange(base)])) ?? ""
      const entries = raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const parts = line.split("\t")
          const code = (parts[0] ?? "").charAt(0)
          const renamed = code === "R" || code === "C"
          return {
            filename: parts[parts.length - 1] ?? "",
            previous_filename: renamed ? (parts[1] ?? null) : null,
            status: STATUS_WORD[code] ?? "modified",
          }
        })
        .filter((e) => e.filename !== "")
      for (const e of await untrackedEntries()) {
        entries.push({ filename: e.path, previous_filename: null, status: "added" })
      }
      return { overflow: false, entries }
    },

    async getFileContent(_owner: string, _repo: string, path: string, ref: string): Promise<string | null> {
      const out = await gitOrNull(cwd, ["show", `${ref}:${path}`])
      if (out === null) return null
      return Buffer.byteLength(out, "utf8") > MAX_FILE_BYTES ? null : out
    },

    async getRepoTree(
      _owner: string,
      _repo: string,
      treeSha: string,
    ): Promise<{
      tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>
      truncated: boolean
    } | null> {
      const raw = await gitOrNull(cwd, ["ls-tree", "-r", treeSha])
      if (raw === null) return null
      const tree = raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [meta, path] = line.split("\t")
          const cols = (meta ?? "").split(/\s+/)
          return { path: path ?? "", type: cols[1] ?? "blob", sha: cols[2] ?? "" }
        })
      return { tree, truncated: false }
    },

    async getBranch(
      _owner: string,
      _repo: string,
      branch: string,
    ): Promise<{ headSha: string; treeSha: string } | null> {
      const headSha = (await gitOrNull(cwd, ["rev-parse", branch]))?.trim()
      const treeSha = (await gitOrNull(cwd, ["rev-parse", `${branch}^{tree}`]))?.trim()
      if (!headSha || !treeSha) return null
      return { headSha, treeSha }
    },

    async getMergeBase(_owner: string, _repo: string, mbBase: string, head: string): Promise<string | null> {
      return (await gitOrNull(cwd, ["merge-base", mbBase, head]))?.trim() ?? null
    },

    // getCommit: used only by the graph receipt-join (flag-gated off locally). Read-only via git.
    async getCommit(
      _owner: string,
      _repo: string,
      sha: string,
    ): Promise<{ headSha: string; treeSha: string; parents: string[] } | null> {
      const treeSha = (await gitOrNull(cwd, ["rev-parse", `${sha}^{tree}`]))?.trim()
      if (!treeSha) return null
      const parentsRaw = (await gitOrNull(cwd, ["rev-list", "--parents", "-n", "1", sha]))?.trim() ?? ""
      const parents = parentsRaw ? parentsRaw.split(/\s+/).slice(1) : []
      return { headSha: sha, treeSha, parents }
    },

    // getPullRequestCommits: the overview pass uses these for context. --uncommitted
    // has none (changes aren't committed); --diff <base> = `git log <base>..HEAD`.
    async getPullRequestCommits(): Promise<PrCommit[]> {
      if (!base) return []
      const raw = (await gitOrNull(cwd, ["log", "--format=%H%x09%s", `${base}..HEAD`])) ?? ""
      return raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const tab = line.indexOf("\t")
          return tab === -1 ? { sha: line, message: "" } : { sha: line.slice(0, tab), message: line.slice(tab + 1) }
        })
    },

    // submitReview: the publish path is gated out under dryRun, so this must never run.
    async submitReview(): Promise<{ id: number; state: string }> {
      throw new Error("local-git-client: submitReview is unavailable for a local (dry-run) review — nothing is posted")
    },

    // Comment reads → empty (no GitHub comments on a local review); writes → throw.
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
      throw new Error("local-git-client: createIssueComment unavailable for a local (dry-run) review")
    },
    async updateIssueComment(): Promise<unknown> {
      throw new Error("local-git-client: updateIssueComment unavailable for a local (dry-run) review")
    },
    async deleteIssueComment(): Promise<unknown> {
      throw new Error("local-git-client: deleteIssueComment unavailable for a local (dry-run) review")
    },

    // No local equivalents — the engine tolerates empties (ARC-182).
    async listOpenPullRequests() {
      return []
    },
    async listPullRequestReviews() {
      return []
    },
  }
}
