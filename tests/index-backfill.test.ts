// SIG-156 — runIndexBackfill: enumerate installs → repos → fan out index jobs.

import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("../src/lib/github-app", () => ({
  listAppInstallationIds: vi.fn(),
  listInstallationRepoFullNames: vi.fn(),
}))
vi.mock("../src/lib/index-producer", () => ({ enqueueIndexJobsForRepos: vi.fn() }))

import { runIndexBackfill } from "../src/lib/index-backfill"
import { listAppInstallationIds, listInstallationRepoFullNames } from "../src/lib/github-app"
import { enqueueIndexJobsForRepos } from "../src/lib/index-producer"
import type { Env } from "../src/index"

const mockListInstalls = vi.mocked(listAppInstallationIds)
const mockListRepos = vi.mocked(listInstallationRepoFullNames)
const mockEnqueue = vi.mocked(enqueueIndexJobsForRepos)

const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", OPENCLAW_STATE: {} } as unknown as Env
const ok = <T>(items: T[]) => ({ items, complete: true })

beforeEach(() => {
  mockListInstalls.mockReset()
  mockListRepos.mockReset()
  mockEnqueue.mockReset()
})

describe("runIndexBackfill", () => {
  it("returns an empty summary when the GitHub App isn't configured", async () => {
    const out = await runIndexBackfill({} as Env, { dryRun: false })
    expect(out.installations).toBe(0)
    expect(mockListInstalls).not.toHaveBeenCalled()
  })

  it("dry-run counts installations + repos but enqueues nothing", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"])).mockResolvedValueOnce(ok(["o/c"]))
    const out = await runIndexBackfill(env, { dryRun: true })
    expect(out).toMatchObject({ installations: 2, repos: 3, enqueued: 0, dryRun: true, enumerationIncomplete: false })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("fans out index jobs per installation and sums the results", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"])).mockResolvedValueOnce(ok(["o/c"]))
    mockEnqueue
      .mockResolvedValueOnce({ attempted: 2, succeeded: 2, perRepoFailed: 0, sensitiveSkipped: 0 })
      .mockResolvedValueOnce({ attempted: 1, succeeded: 0, perRepoFailed: 0, sensitiveSkipped: 1 })
    const out = await runIndexBackfill(env, { dryRun: false })
    expect(out).toMatchObject({ installations: 2, repos: 3, enqueued: 2, sensitiveSkipped: 1, perRepoFailed: 0, enumerationIncomplete: false })
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
    expect(mockEnqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      installationId: 111,
      reason: "manual",
      repositories: [{ full_name: "o/a" }, { full_name: "o/b" }],
    }))
  })

  it("flags enumerationIncomplete when installation listing is partial", async () => {
    mockListInstalls.mockResolvedValue({ items: [111], complete: false })
    mockListRepos.mockResolvedValue(ok(["o/a"]))
    mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 })
    const out = await runIndexBackfill(env, { dryRun: false })
    expect(out.enumerationIncomplete).toBe(true)
  })

  it("flags enumerationIncomplete when a repo listing is partial, and keeps fanning out", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    // install 111: complete; install 222: partial repo listing
    mockListRepos
      .mockResolvedValueOnce(ok(["o/a"]))
      .mockResolvedValueOnce({ items: ["o/b"], complete: false })
    mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 })
    const out = await runIndexBackfill(env, { dryRun: false })
    expect(out.enumerationIncomplete).toBe(true)
    expect(out.repos).toBe(2)
    expect(mockEnqueue).toHaveBeenCalledTimes(2) // didn't abort
  })

  it("per-installation fail-soft: an enqueue throw on one install doesn't abort the run", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"])).mockResolvedValueOnce(ok(["o/c"]))
    mockEnqueue
      .mockRejectedValueOnce(new Error("queue binding broken"))
      .mockResolvedValueOnce({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 })
    const out = await runIndexBackfill(env, { dryRun: false })
    expect(mockEnqueue).toHaveBeenCalledTimes(2) // didn't abort after the throw
    expect(out.enqueued).toBe(1) // only the successful install counted
    expect(out.enumerationIncomplete).toBe(true) // coverage incomplete → re-run
  })

  it("per-installation fail-soft: an install with zero repos is skipped, others still run", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok(["o/c"]))
    mockEnqueue.mockResolvedValue({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 })
    const out = await runIndexBackfill(env, { dryRun: false })
    expect(out).toMatchObject({ installations: 2, repos: 1, enqueued: 1 })
    expect(mockEnqueue).toHaveBeenCalledTimes(1) // only the install with repos
  })
})
