// SIG-304 (review CLI) Phase 1 — arg parsing + dispatch + exit-code wiring for
// `cliMain` (the engine driver is mocked; the real engine path is the live test).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"

vi.mock("./run-review-in-node", () => ({ runReviewInNode: vi.fn() }))
vi.mock("./run-review-remote", () => ({ runReviewRemote: vi.fn() }))
import { runReviewInNode } from "./run-review-in-node"
import { runReviewRemote } from "./run-review-remote"
import { cliMain } from "./cli-main"

const mockRun = vi.mocked(runReviewInNode)
const mockRemote = vi.mocked(runReviewRemote)

function review(findings: PrReviewFinding[]): DryRunReview {
  return {
    verdict: { summary: "s", confidence: 4, confidenceReason: "x", findings } as PrReviewVerdict,
    unanchoredFindings: [],
  }
}
const finding = (score: number): PrReviewFinding =>
  ({ path: "src/a.ts", line: 1, score, category: "security", headline: "h", body: "b" }) as PrReviewFinding

let out: string[]
let err: string[]
beforeEach(() => {
  out = []
  err = []
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true))
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true))
  mockRun.mockReset()
  mockRemote.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe("cliMain — validation + dispatch", () => {
  it("--help → exit 0, prints usage", async () => {
    expect(await cliMain(["--help"])).toBe(0)
    expect(out.join("")).toContain("sigilix review")
  })
  it("no args → exit 2 (usage)", async () => {
    expect(await cliMain([])).toBe(2)
  })
  it("unknown command → exit 2", async () => {
    expect(await cliMain(["frobnicate"])).toBe(2)
    expect(err.join("")).toContain("unknown command")
  })
  it("missing --repo → exit 2, no engine call", async () => {
    expect(await cliMain(["review", "--pr", "5", "--token", "t"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("missing --pr → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--token", "t"])).toBe(2)
  })
  it("conflicting sources (--pr + --uncommitted) → exit 2, no engine call", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "5", "--token", "t", "--uncommitted"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
    expect(err.join("")).toContain("pick ONE source")
  })
  it("conflicting sources (--uncommitted + --diff) → exit 2", async () => {
    expect(await cliMain(["review", "--uncommitted", "--diff", "main"])).toBe(2)
    expect(err.join("")).toContain("pick ONE source")
  })
  it("missing token → exit 2", async () => {
    const saved = { gh: process.env.GITHUB_TOKEN, g: process.env.GH_TOKEN }
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    try {
      expect(await cliMain(["review", "--repo", "o/r", "--pr", "5"])).toBe(2)
    } finally {
      if (saved.gh !== undefined) process.env.GITHUB_TOKEN = saved.gh
      if (saved.g !== undefined) process.env.GH_TOKEN = saved.g
    }
  })
  it("valid args → runs the engine, prints output, returns the finding-based exit code", async () => {
    mockRun.mockResolvedValue(review([finding(5)]))
    const code = await cliMain(["review", "--repo", "acme/app", "--pr", "12", "--token", "t", "--plain"])
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app", prNumber: 12, githubToken: "t" }),
    )
    expect(out.join("")).toContain("src/a.ts:1")
    expect(code).toBe(1) // a P0 is blocking
  })
  it("nothing-to-review → exit 0", async () => {
    mockRun.mockResolvedValue(null)
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t"])).toBe(0)
    expect(out.join("")).toContain("nothing to review")
  })
  it("hosted: $SIGILIX_API_KEY + a local source → the remote endpoint, NOT the local engine", async () => {
    const saved = process.env.SIGILIX_API_KEY
    process.env.SIGILIX_API_KEY = "hk"
    try {
      mockRemote.mockResolvedValue(review([finding(5)]))
      const code = await cliMain(["review", "--diff", "main", "--plain"])
      expect(mockRemote).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "hk", git: expect.anything() }))
      expect(mockRun).not.toHaveBeenCalled() // local engine bypassed
      expect(code).toBe(1) // exit derived from the remote review (P0 blocking)
    } finally {
      if (saved === undefined) delete process.env.SIGILIX_API_KEY
      else process.env.SIGILIX_API_KEY = saved
    }
  })
  it("--json selects JSON output", async () => {
    mockRun.mockResolvedValue(review([finding(3)]))
    const code = await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t", "--json"])
    expect(JSON.parse(out.join("")).counts.total).toBe(1)
    expect(code).toBe(2) // advisory only
  })
  it("unknown flag → exit 2 (a parse error must not look like a blocking finding)", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t", "--nope"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("malformed --repo (empty owner) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "/r", "--pr", "1", "--token", "t"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("malformed --repo (extra slash) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "a/b/c", "--pr", "1", "--token", "t"])).toBe(2)
  })
  it("non-numeric --pr (1e3) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1e3", "--token", "t"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
})
