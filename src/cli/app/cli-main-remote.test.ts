// SIG-304 Phase 2.3 — the engine-free remote-only main: arg parsing, auth/source
// gating, dispatch. runReviewRemote is mocked (its own tests cover the transport).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"

vi.mock("./run-review-remote", () => ({ runReviewRemote: vi.fn(), runReviewRemoteGrounded: vi.fn() }))
import { runReviewRemote, runReviewRemoteGrounded } from "./run-review-remote"
import { cliMainRemote } from "./cli-main-remote"

const mockRemote = vi.mocked(runReviewRemote)
const mockGrounded = vi.mocked(runReviewRemoteGrounded)
const review = (findings: PrReviewFinding[]): DryRunReview => ({
  verdict: { summary: "s", confidence: 4, confidenceReason: "x", findings } as PrReviewVerdict,
  unanchoredFindings: [],
})
const finding = (score: number): PrReviewFinding =>
  ({ path: "src/a.ts", line: 1, score, category: "security", headline: "h", body: "b" }) as PrReviewFinding

let out: string[]
let err: string[]
beforeEach(() => {
  out = []
  err = []
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true))
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true))
  mockRemote.mockReset()
  mockGrounded.mockReset()
})
afterEach(() => vi.restoreAllMocks())

const withKey = async (fn: () => Promise<number>): Promise<number> => {
  const saved = process.env.SIGILIX_API_KEY
  process.env.SIGILIX_API_KEY = "hk"
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.SIGILIX_API_KEY
    else process.env.SIGILIX_API_KEY = saved
  }
}

describe("cliMainRemote", () => {
  it("--help → exit 0, prints hosted usage", async () => {
    expect(await cliMainRemote(["--help"])).toBe(0)
    expect(out.join("")).toContain("hosted code review")
  })
  it("review --help → exit 0 (the full guide), even after the subcommand", async () => {
    expect(await cliMainRemote(["review", "--help"])).toBe(0)
    expect(out.join("")).toContain("hosted code review")
  })
  it("unknown command → exit 2", async () => {
    expect(await cliMainRemote(["frob"])).toBe(2)
  })
  it("missing $SIGILIX_API_KEY → exit 2, no remote call", async () => {
    const saved = process.env.SIGILIX_API_KEY
    delete process.env.SIGILIX_API_KEY
    try {
      expect(await cliMainRemote(["review", "--diff", "main"])).toBe(2)
      expect(err.join("")).toContain("SIGILIX_API_KEY")
      expect(mockRemote).not.toHaveBeenCalled()
    } finally {
      if (saved !== undefined) process.env.SIGILIX_API_KEY = saved
    }
  })
  it("no source → exit 2", async () => {
    expect(await withKey(() => cliMainRemote(["review", "--plain"]))).toBe(2)
    expect(err.join("")).toContain("exactly one source")
  })
  it("both sources → exit 2", async () => {
    expect(await withKey(() => cliMainRemote(["review", "--uncommitted", "--diff", "main"]))).toBe(2)
  })
  it("happy: posts to the remote endpoint and returns the finding-based exit code", async () => {
    mockRemote.mockResolvedValue(review([finding(5)]))
    const code = await withKey(() => cliMainRemote(["review", "--diff", "main", "--plain"]))
    expect(mockRemote).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "hk", endpoint: expect.any(String) }))
    expect(out.join("")).toContain("src/a.ts:1")
    expect(code).toBe(1) // a P0 is blocking
  })
  it("nothing-to-review → exit 0", async () => {
    mockRemote.mockResolvedValue(null)
    expect(await withKey(() => cliMainRemote(["review", "--uncommitted"]))).toBe(0)
    expect(out.join("")).toContain("nothing to review")
  })
  it("--rich renders the panel (null overview) without crashing", async () => {
    const savedFC = process.env.FORCE_COLOR
    process.env.FORCE_COLOR = "1"
    try {
      mockRemote.mockResolvedValue(review([finding(5)]))
      const code = await withKey(() => cliMainRemote(["review", "--diff", "main", "--rich", "--no-splash"]))
      expect(out.join("")).toContain("sigilix") // the rich header rendered
      expect(code).toBe(1)
    } finally {
      if (savedFC === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = savedFC
    }
  })
  it("RECALL-SAFETY: a remote failure propagates (throws → bin exits non-zero), never a clean pass", async () => {
    mockRemote.mockImplementation(async () => {
      throw new Error("hosted review failed (HTTP 500)")
    })
    await expect(withKey(() => cliMainRemote(["review", "--diff", "main", "--plain"]))).rejects.toThrow(/HTTP 500/)
  })

  // Mode B: a real PR reviewed grounded via the GitHub App (no token, no local git).
  it("grounded: --repo/--pr posts a PR reference (no local git) and returns the exit code", async () => {
    mockGrounded.mockResolvedValue(review([finding(5)]))
    const code = await withKey(() => cliMainRemote(["review", "--repo", "o/r", "--pr", "7", "--plain"]))
    expect(mockGrounded).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "hk", owner: "o", repo: "r", prNumber: 7 }),
    )
    expect(mockRemote).not.toHaveBeenCalled() // no local-diff path
    expect(code).toBe(1)
  })
  it("grounded + a local source → exit 2 (one source only)", async () => {
    expect(await withKey(() => cliMainRemote(["review", "--repo", "o/r", "--pr", "7", "--uncommitted"]))).toBe(2)
    expect(mockGrounded).not.toHaveBeenCalled()
  })
  it("--pr without a valid --repo → exit 2", async () => {
    expect(await withKey(() => cliMainRemote(["review", "--pr", "7"]))).toBe(2)
    expect(err.join("")).toContain("--repo")
  })
  it("--repo without a valid --pr → exit 2", async () => {
    expect(await withKey(() => cliMainRemote(["review", "--repo", "o/r", "--pr", "x"]))).toBe(2)
    expect(err.join("")).toContain("--pr")
  })
})
