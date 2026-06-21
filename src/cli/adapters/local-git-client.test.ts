// SIG-304 (review CLI) Phase 1b — the read-only local-git adapter. Hermetic:
// builds a throwaway git repo in a tmp dir, makes uncommitted changes, and checks
// the adapter against real git — including that it has ZERO side effects.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localGitClient } from "./local-git-client"

let dir: string
const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sigilix-git-"))
  git(["init", "-q"])
  git(["config", "user.email", "t@example.com"])
  git(["config", "user.name", "Test"])
  git(["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "a.ts"), "export const x = 1\n")
  writeFileSync(join(dir, "del.ts"), "doomed\n")
  git(["add", "."])
  git(["commit", "-qm", "init"])
  // uncommitted: modify a.ts, delete del.ts (tracked); b.ts stays untracked.
  writeFileSync(join(dir, "a.ts"), "export const x = 2\n")
  rmSync(join(dir, "del.ts"))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("localGitClient — --uncommitted (working tree)", () => {
  it("getPullRequestDiff matches `git diff HEAD` byte-for-byte", async () => {
    const c = localGitClient({ cwd: dir })
    expect(await c.getPullRequestDiff("o", "r", 0)).toBe(git(["diff", "HEAD"]))
  })

  it("listPullRequestFiles reports the modified + deleted files", async () => {
    const c = localGitClient({ cwd: dir })
    const files = await c.listPullRequestFiles("o", "r", 0)
    const byName = Object.fromEntries(files.map((f) => [f.filename, f.status]))
    expect(byName["a.ts"]).toBe("modified")
    expect(byName["del.ts"]).toBe("removed")
  })

  it("getPullRequest fabricates a head SHA = git rev-parse HEAD", async () => {
    const c = localGitClient({ cwd: dir })
    const meta = await c.getPullRequest("o", "r", 0)
    expect(meta.head.sha).toBe(git(["rev-parse", "HEAD"]).trim())
    expect(meta.state).toBe("open")
  })

  it("getFileContent returns the committed version at a ref; null for a missing path", async () => {
    const c = localGitClient({ cwd: dir })
    expect(await c.getFileContent("o", "r", "a.ts", "HEAD")).toBe("export const x = 1\n")
    expect(await c.getFileContent("o", "r", "nope.ts", "HEAD")).toBeNull()
  })

  it("has ZERO side effects (git status unchanged after all reads)", async () => {
    const before = git(["status", "--porcelain"])
    const c = localGitClient({ cwd: dir })
    await c.getPullRequest("o", "r", 0)
    await c.getPullRequestDiff("o", "r", 0)
    await c.listPullRequestFiles("o", "r", 0)
    await c.listPullFilesForManifest("o", "r", 0)
    await c.getFileContent("o", "r", "a.ts", "HEAD")
    expect(git(["status", "--porcelain"])).toBe(before)
  })

  it("listOpenPullRequests + listPullRequestReviews are empty; submitReview throws", async () => {
    const c = localGitClient({ cwd: dir })
    expect(await c.listOpenPullRequests("o", "r")).toEqual([])
    expect(await c.listPullRequestReviews("o", "r", 0)).toEqual([])
    await expect(c.submitReview("o", "r", 0, {})).rejects.toThrow(/submitReview/)
  })
})
