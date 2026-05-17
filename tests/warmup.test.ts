// ARC-258 follow-up — tests for the unified warmup fan-out helper.
//
// Historical: ARC-236 originally shipped 3 warmup helpers (post
// sticky, update sticky to ready, fan-out reruns). The first two
// were deleted in the unification — warmup state now lives inside
// the pr-overview comment as a callout block, not a separate sticky.
// This file only covers `enqueueWarmupRerunsForIndex`.
//
// Fan-out behavior: for every open PR whose overview body shows the
// warmup callout (or carries the legacy standalone sticky marker
// — backward compat), enqueue BOTH:
//   - `pr-review-rerun` (refresh the code review with retrieval)
//   - `pr-overview` (re-render the overview without the callout)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockListIssueComments,
  mockListOpenPullRequests,
} = vi.hoisted(() => ({
  mockListIssueComments: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async listIssueComments(...args: unknown[]): Promise<unknown> {
      return mockListIssueComments(...args)
    }
    async listOpenPullRequests(...args: unknown[]): Promise<unknown> {
      return mockListOpenPullRequests(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  enqueueWarmupRerunsForIndex,
  LEGACY_WARMUP_MARKER,
  WARMUP_CALLOUT_MARKER,
} from "../src/lib/warmup"
import { GitHubClient } from "../src/lib/github"
import type { Env, JobMessage } from "../src/index"

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(): { env: Env; sent: JobMessage[]; kv: Map<string, string> } {
  const { kv, store } = makeKvStub()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: { send: async (m: JobMessage) => { sent.push(m) } },
  } as unknown as Env
  return { env, sent, kv: store }
}

function pr(number: number, headSha = "a".repeat(40)) {
  return { number, head: { sha: headSha } }
}

beforeEach(() => {
  mockListIssueComments.mockReset()
  mockListOpenPullRequests.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("enqueueWarmupRerunsForIndex", () => {
  it("for every open PR with the warmup callout, enqueues BOTH pr-review-rerun AND pr-overview", async () => {
    mockListOpenPullRequests.mockResolvedValue([pr(10, "h10"), pr(11, "h11"), pr(12, "h12")])
    // PR 10 has the new callout marker, PR 11 has nothing, PR 12 has the legacy marker.
    mockListIssueComments.mockImplementation(async (_o: string, _r: string, prNumber: number) => {
      if (prNumber === 10) return [{ id: 1, body: `## Sigilix Overview\n> [!NOTE] ${WARMUP_CALLOUT_MARKER}\n> warming...` }]
      if (prNumber === 11) return [{ id: 2, body: "no marker" }]
      if (prNumber === 12) return [{ id: 3, body: LEGACY_WARMUP_MARKER }]
      return []
    })

    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-abc",
    })

    // 2 PRs match → 2 pr-review-rerun + 2 pr-overview enqueues = 4 total messages.
    expect(result.enqueued).toBe(2)
    expect(result.scanned).toBe(3)
    expect(sent).toHaveLength(4)

    const reruns = sent.filter((m) => m.type === "pr-review-rerun")
    const overviews = sent.filter((m) => m.type === "pr-overview")
    expect(reruns.map((m) => "prNumber" in m ? m.prNumber : null).sort()).toEqual([10, 12])
    expect(overviews.map((m) => "prNumber" in m ? m.prNumber : null).sort()).toEqual([10, 12])

    // The pr-overview messages carry the head SHA so the re-render
    // can compute its own dedupe key.
    const overviewHeads = overviews.map((m) => "headSha" in m ? m.headSha : null).sort()
    expect(overviewHeads).toEqual(["h10", "h12"])
  })

  it("pr-review-rerun messages carry silent=true (no slash-command ack noise)", async () => {
    mockListOpenPullRequests.mockResolvedValue([pr(10, "h10")])
    mockListIssueComments.mockResolvedValue([{ id: 1, body: WARMUP_CALLOUT_MARKER }])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })

    await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-1",
    })

    const rerun = sent.find((m) => m.type === "pr-review-rerun")
    expect(rerun).toBeDefined()
    if (rerun && rerun.type === "pr-review-rerun") {
      expect(rerun.silent).toBe(true)
    }
  })

  it("skips pr-overview enqueue when the PR has no head SHA (defensive)", async () => {
    mockListOpenPullRequests.mockResolvedValue([{ number: 10, head: { sha: "" } }])
    mockListIssueComments.mockResolvedValue([{ id: 1, body: WARMUP_CALLOUT_MARKER }])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })

    await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-1",
    })

    // Rerun still fires; overview is skipped because headSha is missing.
    expect(sent.filter((m) => m.type === "pr-review-rerun")).toHaveLength(1)
    expect(sent.filter((m) => m.type === "pr-overview")).toHaveLength(0)
  })

  it("returns zero counts when listOpenPullRequests fails", async () => {
    mockListOpenPullRequests.mockRejectedValue(new Error("HTTP 502"))
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-abc",
    })
    expect(result).toEqual({ enqueued: 0, scanned: 0 })
    expect(sent).toHaveLength(0)
  })

  it("skips individual PR if listIssueComments fails for it (doesn't abort fan-out)", async () => {
    mockListOpenPullRequests.mockResolvedValue([pr(10, "h10"), pr(11, "h11")])
    mockListIssueComments.mockImplementation(async (_o: string, _r: string, prNumber: number) => {
      if (prNumber === 10) throw new Error("403 on PR 10")
      return [{ id: 99, body: WARMUP_CALLOUT_MARKER }]
    })

    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-abc",
    })

    expect(result.enqueued).toBe(1)
    expect(result.scanned).toBe(2)
    // Only PR 11 produces messages: 1 rerun + 1 overview.
    expect(sent).toHaveLength(2)
  })

  it("handles empty open-PR list", async () => {
    mockListOpenPullRequests.mockResolvedValue([])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-abc",
    })
    expect(result).toEqual({ enqueued: 0, scanned: 0 })
    expect(sent).toHaveLength(0)
  })

  // M4 (CodeRabbit PR #80): the index-repo consumer retries on
  // transient failures; without a dedupe breadcrumb, a redelivered
  // index-job would fan out a second batch of messages → every
  // warmup PR would get a duplicate review.
  it("dedupes against queue-retry redelivery via runId-keyed KV breadcrumb", async () => {
    mockListOpenPullRequests.mockResolvedValue([pr(10, "h10")])
    mockListIssueComments.mockResolvedValue([{ id: 1, body: WARMUP_CALLOUT_MARKER }])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })

    const first = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "same-run-id",
    })
    expect(first.enqueued).toBe(1)
    expect(sent).toHaveLength(2) // 1 rerun + 1 overview

    const second = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "same-run-id",
    })
    expect(second).toEqual({ enqueued: 0, scanned: 0, skipped: "already-fanned-out" })
    expect(sent).toHaveLength(2) // unchanged — second call short-circuited
  })

  it("re-fans-out when runId differs (genuine re-index → fresh dedupe key)", async () => {
    mockListOpenPullRequests.mockResolvedValue([pr(10, "h10")])
    mockListIssueComments.mockResolvedValue([{ id: 1, body: WARMUP_CALLOUT_MARKER }])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })

    await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-one",
    })
    await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      runId: "run-two",
    })

    // Two distinct runIds → 4 messages total (2 reruns + 2 overviews).
    expect(sent).toHaveLength(4)
  })
})
