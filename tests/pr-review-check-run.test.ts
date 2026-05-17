// ARC-258 — tests for the dispatcher-level "Sigilix Review" check
// run lifecycle helper. Two entry points:
//   - `startInProgressCheckRun`: creates the in_progress check;
//     returns a handle, or `null` on creds-missing / 403 / failure.
//   - `completeCheckRun`: transitions a handle to completed with
//     `neutral` | `failure` | `skipped`. No-op when handle is null.
//
// All behavior is best-effort — these helpers must NOT throw out of
// the dispatcher even on permission misconfigurations.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockCreateCheckRun,
  mockUpdateCheckRun,
  mockListCheckRunsForRef,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockCreateCheckRun: vi.fn(),
  mockUpdateCheckRun: vi.fn(),
  mockListCheckRunsForRef: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async createCheckRun(...args: unknown[]): Promise<unknown> {
      return mockCreateCheckRun(...args)
    }
    async updateCheckRun(...args: unknown[]): Promise<unknown> {
      return mockUpdateCheckRun(...args)
    }
    async listCheckRunsForRef(...args: unknown[]): Promise<unknown> {
      return mockListCheckRunsForRef(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  CHECK_RUN_NAME,
  completeCheckRun,
  startInProgressCheckRun,
} from "../src/lib/pr-review-check-run"
import type { Env } from "../src/index"

function makeEnv(opts: { credentials?: boolean } = {}): Env {
  const haveCreds = opts.credentials ?? true
  return {
    OPENCLAW_STATE: {
      async get(): Promise<string | null> { return null },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<void> { /* no-op */ },
    },
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  headSha: "a".repeat(40),
  installationId: 99,
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockCreateCheckRun.mockReset()
  mockUpdateCheckRun.mockReset()
  mockListCheckRunsForRef.mockReset().mockResolvedValue([]) // default: no stale checks
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("startInProgressCheckRun", () => {
  it("creates the check run and returns a handle on the happy path", async () => {
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).not.toBeNull()
    expect(handle!.id).toBe(7777)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    const [owner, repo, payload] = mockCreateCheckRun.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect((payload as { name: string }).name).toBe(CHECK_RUN_NAME)
    expect((payload as { headSha: string }).headSha).toBe(baseArgs.headSha)
    expect((payload as { status: string }).status).toBe("in_progress")
  })

  it("returns null (no throw) when credentials are missing", async () => {
    const env = makeEnv({ credentials: false })
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
    expect(mockCreateCheckRun).not.toHaveBeenCalled()
  })

  it("returns null (no throw) when createCheckRun 403s — App missing `checks: write`", async () => {
    mockCreateCheckRun.mockRejectedValue(new Error("HTTP 403 Resource not accessible by integration"))
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })

  it("returns null (no throw) on any other createCheckRun failure", async () => {
    mockCreateCheckRun.mockRejectedValue(new Error("HTTP 502 Bad Gateway"))
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
  })

  // Founder caught this on PR #80: two in-progress checks showed up
  // on the same head_sha after a rename-deploy ("Sigilix Review"
  // from old code + "Sigilix" from new code). Going forward we
  // self-clean: list existing Sigilix-named in-progress checks on
  // this head_sha and cancel them before creating the new one.
  // Handles both rename-switchovers AND queue-retry duplicates.
  it("cancels stale in-progress Sigilix checks on the same head_sha before creating a new one", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix Review", status: "in_progress" }, // legacy name
      { id: 222, name: "Sigilix", status: "queued" },              // current name, queued
      { id: 333, name: "Sigilix", status: "completed" },           // current name, completed → no cancel
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" }, // unrelated → no cancel
    ])
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    // 2 stale checks cancelled, 1 new check created.
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const cancelledIds = mockUpdateCheckRun.mock.calls.map((c) => c[2])
    expect(cancelledIds.sort()).toEqual([111, 222])
    for (const call of mockUpdateCheckRun.mock.calls) {
      expect((call[3] as { status: string }).status).toBe("completed")
      expect((call[3] as { conclusion: string }).conclusion).toBe("cancelled")
    }
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    expect(handle!.id).toBe(999)
  })

  it("skips cleanup early when no stale Sigilix checks are present (no PATCHes issued)", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" },
      { id: 555, name: "Some other check", status: "in_progress" },
    ])
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    await startInProgressCheckRun({ env, ...baseArgs })

    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })

  it("proceeds with create even if the list call fails (best-effort cleanup)", async () => {
    mockListCheckRunsForRef.mockRejectedValue(new Error("HTTP 502"))
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle!.id).toBe(999)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })

  it("proceeds with create even if a per-check cancel PATCH fails (isolated retry would orphan, but cleanup is best-effort)", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix Review", status: "in_progress" },
    ])
    mockUpdateCheckRun.mockRejectedValue(new Error("HTTP 422 Validation Failed"))
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle!.id).toBe(999)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })
})

describe("completeCheckRun", () => {
  it("no-ops when handle is null (creation was skipped or failed)", async () => {
    await completeCheckRun({ handle: null, conclusion: "neutral" })
    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
  })

  it("transitions to completed with `neutral` and customer-facing output copy", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "neutral" })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
    const [owner, repo, checkRunId, payload] = mockUpdateCheckRun.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect(checkRunId).toBe(7777)
    const p = payload as { status: string; conclusion: string; output: { title: string; summary: string } }
    expect(p.status).toBe("completed")
    expect(p.conclusion).toBe("neutral")
    expect(p.output.title).toBe("Review posted")
  })

  it("emits the `skipped` copy for stale-head conclusions", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "skipped" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string; summary: string } }
    expect(p.conclusion).toBe("skipped")
    expect(p.output.title).toContain("stale head")
  })

  it("emits the `failure` copy on the error path", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "failure" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string } }
    expect(p.conclusion).toBe("failure")
    expect(p.output.title).toContain("failed")
  })

  it("swallows updateCheckRun failures (best-effort — dispatcher must not crash)", async () => {
    mockUpdateCheckRun.mockRejectedValue(new Error("HTTP 422 Validation Failed"))
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    // Should NOT throw — the underlying review has already posted
    // (or failed) by this point and a check-update failure shouldn't
    // bubble up and corrupt the dispatcher.
    await expect(completeCheckRun({ handle, conclusion: "neutral" })).resolves.toBeUndefined()
  })
})
