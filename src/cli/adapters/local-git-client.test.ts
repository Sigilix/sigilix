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

// SIG-490: --uncommitted must also review UNTRACKED (new, non-ignored) files.
describe("localGitClient — --uncommitted includes UNTRACKED files (SIG-490)", () => {
  let d2: string
  const g2 = (args: string[]): string => execFileSync("git", args, { cwd: d2, encoding: "utf8" })
  beforeAll(() => {
    d2 = mkdtempSync(join(tmpdir(), "sigilix-git-untracked-"))
    g2(["init", "-q"])
    g2(["config", "user.email", "t@example.com"])
    g2(["config", "user.name", "Test"])
    g2(["config", "commit.gpgsign", "false"])
    writeFileSync(join(d2, "tracked.ts"), "export const x = 1\n")
    writeFileSync(join(d2, ".gitignore"), "ignored.ts\n")
    g2(["add", "."])
    g2(["commit", "-qm", "init"])
    writeFileSync(join(d2, "tracked.ts"), "export const x = 2\n") // tracked modification
    writeFileSync(join(d2, "newfile.ts"), "export const danger = 1\nconst y = 2\n") // UNTRACKED new file
    writeFileSync(join(d2, "ignored.ts"), "secret\n") // untracked BUT .gitignored → must be excluded
    writeFileSync(join(d2, "spaced ünicode.ts"), "export const z = 3\n") // untracked, special/Unicode name
    writeFileSync(join(d2, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 99, 7])) // untracked BINARY
  })
  afterAll(() => rmSync(d2, { recursive: true, force: true }))

  it("getPullRequestDiff includes untracked new files (as new-file diffs) + the tracked change, excludes .gitignored", async () => {
    const diff = await localGitClient({ cwd: d2 }).getPullRequestDiff("o", "r", 0)
    expect(diff).toContain("+++ b/newfile.ts") // untracked new file rendered as a new-file diff
    expect(diff).toContain("export const danger = 1")
    expect(diff).toContain("tracked.ts") // tracked modification still present
    expect(diff).not.toContain("ignored.ts") // .gitignored untracked file excluded
  })

  it("listPullRequestFiles + manifest mark the untracked file as added", async () => {
    const c = localGitClient({ cwd: d2 })
    const files = await c.listPullRequestFiles("o", "r", 0)
    expect(files.find((f) => f.filename === "newfile.ts")?.status).toBe("added")
    expect(files.find((f) => f.filename === "newfile.ts")?.additions).toBeGreaterThan(0)
    const man = await c.listPullFilesForManifest("o", "r", 0)
    expect(man.entries.find((e) => e.filename === "newfile.ts")?.status).toBe("added")
  })

  it("ZERO side effects — the untracked file stays untracked (never `git add`-ed)", async () => {
    const before = g2(["status", "--porcelain"])
    const c = localGitClient({ cwd: d2 })
    await c.getPullRequestDiff("o", "r", 0)
    await c.listPullRequestFiles("o", "r", 0)
    await c.listPullFilesForManifest("o", "r", 0)
    expect(g2(["status", "--porcelain"])).toBe(before) // newfile.ts still "??", index untouched
  })

  it("--diff <base> does NOT pull in untracked files (committed range only)", async () => {
    const diff = await localGitClient({ cwd: d2, base: "HEAD" }).getPullRequestDiff("o", "r", 0)
    expect(diff).not.toContain("newfile.ts")
  })

  it("reviews a Unicode/space-named untracked file (core.quotePath=false), and SKIPS binary (no phantom entry)", async () => {
    const c = localGitClient({ cwd: d2 })
    const diff = await c.getPullRequestDiff("o", "r", 0)
    expect(diff).toContain("spaced ünicode.ts") // special-named file is found + reviewed, not dropped
    expect(diff).toContain("export const z = 3")
    expect(diff).not.toContain("blob.bin") // binary untracked → skipped (no "Binary files" block)
    const files = await c.listPullRequestFiles("o", "r", 0)
    expect(files.find((f) => f.filename === "spaced ünicode.ts")?.status).toBe("added")
    expect(files.some((f) => f.filename === "blob.bin")).toBe(false) // no phantom 0-line entry
  })
})
