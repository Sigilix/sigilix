// SIG-304 (review CLI) Phase 1 — arg parsing + dispatch + exit-code wiring for
// `cliMain` (the engine driver is mocked; the real engine path is the live test).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"

vi.mock("./run-review-in-node", () => ({ runReviewInNode: vi.fn() }))
vi.mock("./run-review-remote", () => ({ runReviewRemote: vi.fn(), runReviewRemoteGrounded: vi.fn() }))
vi.mock("./run-overview-in-node", () => ({ runOverviewInNode: vi.fn(async () => null) }))
import { runReviewInNode } from "./run-review-in-node"
import { runReviewRemote, runReviewRemoteGrounded } from "./run-review-remote"
import { cliMain } from "./cli-main"

const mockRun = vi.mocked(runReviewInNode)
const mockRemote = vi.mocked(runReviewRemote)
const mockGrounded = vi.mocked(runReviewRemoteGrounded)

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
const KEY_ENV = ["SIGILIX_API_KEY", "OPENROUTER_API_KEY", "OPENCLAW_MODEL"] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  out = []
  err = []
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true))
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true))
  mockRun.mockReset()
  mockRemote.mockReset()
  mockGrounded.mockReset()
  // Hermetic: control hosted + local model keys per-test (tests set what they need).
  savedEnv = {}
  for (const k of KEY_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const k of KEY_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe("cliMain — validation + dispatch", () => {
  it("--help → exit 0, prints usage", async () => {
    expect(await cliMain(["--help"])).toBe(0)
    expect(out.join("")).toContain("sigilix review")
  })
  it("review --help → exit 0 (the full guide), even after the subcommand", async () => {
    expect(await cliMain(["review", "--help"])).toBe(0)
    expect(out.join("")).toContain("Source (pick one)")
  })
  it("no args → exit 2 (usage)", async () => {
    expect(await cliMain([])).toBe(2)
  })
  it("unknown command → exit 2", async () => {
    expect(await cliMain(["frobnicate"])).toBe(2)
    expect(err.join("")).toContain("unknown command")
  })
  it("no keys at all (no $SIGILIX_API_KEY, no $OPENROUTER_API_KEY) → exit 2", async () => {
    expect(await cliMain(["review", "--uncommitted"])).toBe(2)
    expect(err.join("")).toContain("SIGILIX_API_KEY")
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockRemote).not.toHaveBeenCalled()
  })
  it("auto-local: no hosted key but $OPENROUTER_API_KEY present → runs the local engine, no flags", async () => {
    process.env.OPENROUTER_API_KEY = "byo"
    mockRun.mockResolvedValue(review([finding(5)]))
    const code = await cliMain(["review", "--uncommitted", "--plain"]) // no --local, no --rich
    expect(mockRun).toHaveBeenCalled() // fell back to the local engine
    expect(mockRemote).not.toHaveBeenCalled()
    expect(err.join("")).toContain("running locally")
    expect(code).toBe(1)
  })
  it("--local: missing --repo → exit 2, no engine call", async () => {
    expect(await cliMain(["review", "--pr", "5", "--token", "t", "--local"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("--local: missing --pr → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--token", "t", "--local"])).toBe(2)
  })
  it("conflicting sources (--pr + --uncommitted) → exit 2, no engine call", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "5", "--token", "t", "--uncommitted", "--local"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
    expect(err.join("")).toContain("pick ONE source")
  })
  it("conflicting sources (--uncommitted + --diff) → exit 2", async () => {
    expect(await cliMain(["review", "--uncommitted", "--diff", "main", "--local"])).toBe(2)
    expect(err.join("")).toContain("pick ONE source")
  })
  it("--local on a PR with no token → exit 2", async () => {
    const saved = { gh: process.env.GITHUB_TOKEN, g: process.env.GH_TOKEN }
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    try {
      expect(await cliMain(["review", "--repo", "o/r", "--pr", "5", "--local"])).toBe(2)
      expect(err.join("")).toContain("token")
    } finally {
      if (saved.gh !== undefined) process.env.GITHUB_TOKEN = saved.gh
      if (saved.g !== undefined) process.env.GH_TOKEN = saved.g
    }
  })
  it("--local: runs the local engine, prints output, returns the finding-based exit code", async () => {
    mockRun.mockResolvedValue(review([finding(5)]))
    const code = await cliMain(["review", "--repo", "acme/app", "--pr", "12", "--token", "t", "--local", "--plain"])
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app", prNumber: 12, githubToken: "t" }),
    )
    expect(out.join("")).toContain("src/a.ts:1")
    expect(code).toBe(1) // a P0 is blocking
  })
  it("--local: nothing-to-review → exit 0", async () => {
    mockRun.mockResolvedValue(null)
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t", "--local"])).toBe(0)
    expect(out.join("")).toContain("nothing to review")
  })
  it("hosted: $SIGILIX_API_KEY + a local source → the remote endpoint, NOT the local engine", async () => {
    process.env.SIGILIX_API_KEY = "hk"
    mockRemote.mockResolvedValue(review([finding(5)]))
    const code = await cliMain(["review", "--diff", "main", "--plain"])
    expect(mockRemote).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "hk", git: expect.anything() }))
    expect(mockRun).not.toHaveBeenCalled() // local engine bypassed
    expect(code).toBe(1) // exit derived from the remote review (P0 blocking)
  })
  it("hosted: $SIGILIX_API_KEY + --repo/--pr → GROUNDED remote, no token required", async () => {
    process.env.SIGILIX_API_KEY = "hk"
    mockGrounded.mockResolvedValue(review([finding(5)]))
    // no --token: grounded uses the server's GitHub App
    const code = await cliMain(["review", "--repo", "acme/app", "--pr", "12", "--plain"])
    expect(mockGrounded).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "hk", owner: "acme", repo: "app", prNumber: 12 }),
    )
    expect(mockRun).not.toHaveBeenCalled() // local engine bypassed
    expect(mockRemote).not.toHaveBeenCalled() // not the diff path
    expect(code).toBe(1)
  })
  it("hosted grounded: nothing-to-review (server null) → exit 0", async () => {
    process.env.SIGILIX_API_KEY = "hk"
    mockGrounded.mockResolvedValue(null)
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1"])).toBe(0)
    expect(out.join("")).toContain("nothing to review")
  })
  // RECALL-SAFETY: a degraded (partial-coverage) review — a specialist was unavailable —
  // must NEVER read as a clean pass, even with zero surviving findings.
  const degraded = (): DryRunReview => ({ ...review([]), incomplete: { rolesMissing: ["logic"] } })
  it("hosted grounded: a degraded review with NO findings → exit 2 + a visible banner, never 0", async () => {
    process.env.SIGILIX_API_KEY = "hk"
    mockGrounded.mockResolvedValue(degraded())
    const code = await cliMain(["review", "--repo", "o/r", "--pr", "1", "--plain"])
    expect(code).toBe(2) // NOT 0 — partial review
    expect(out.join("")).toContain("partial review")
  })
  it("--local: a degraded review with NO findings → exit 2 + banner, never 0", async () => {
    mockRun.mockResolvedValue(degraded())
    const code = await cliMain(["review", "--uncommitted", "--local", "--plain"])
    expect(code).toBe(2)
    expect(out.join("")).toContain("partial review")
  })
  it("--json selects JSON output", async () => {
    mockRun.mockResolvedValue(review([finding(3)]))
    const code = await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t", "--local", "--json"])
    expect(JSON.parse(out.join("")).counts.total).toBe(1)
    expect(code).toBe(2) // advisory only
  })
  it("unknown flag → exit 2 (a parse error must not look like a blocking finding)", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1", "--token", "t", "--nope"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("--local: malformed --repo (empty owner) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "/r", "--pr", "1", "--token", "t", "--local"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
  it("--local: malformed --repo (extra slash) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "a/b/c", "--pr", "1", "--token", "t", "--local"])).toBe(2)
  })
  it("--local: non-numeric --pr (1e3) → exit 2", async () => {
    expect(await cliMain(["review", "--repo", "o/r", "--pr", "1e3", "--token", "t", "--local"])).toBe(2)
    expect(mockRun).not.toHaveBeenCalled()
  })
})
