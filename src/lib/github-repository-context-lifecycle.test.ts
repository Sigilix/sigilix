import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RepositoryContextReadResult, RepositoryContextWriteResult } from "@/src/features/repository-context"

const mocks = vi.hoisted(() => ({
  readRepositoryContext: vi.fn(),
  purgeRepositoryContext: vi.fn(),
}))

vi.mock("@/src/features/repository-context", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/repository-context")>(
    "@/src/features/repository-context",
  )
  return {
    ...actual,
    readRepositoryContext: mocks.readRepositoryContext,
    purgeRepositoryContext: mocks.purgeRepositoryContext,
  }
})

import { tombstoneGitHubRepositoryContextOnUninstall } from "@/src/lib/github-repository-context-lifecycle"

const NOW = "2026-07-13T23:00:00.000Z"

function snapshot(revision: number, deletedAt: string | null = null): RepositoryContextReadResult {
  return {
    status: "ok",
    snapshot: {
      provider: "github",
      scopeId: "42",
      revision,
      repositories: deletedAt ? [] : [{ externalId: "101", fullName: "acme/api", context: "", position: 0 }],
      relationships: [],
      conventions: "",
      snapshotSha256: "a".repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: "github:111",
      deletedAt,
    },
  }
}

function updated(revision: number): RepositoryContextWriteResult {
  const read = snapshot(revision, NOW)
  if (read.status !== "ok") throw new Error("expected snapshot")
  return { status: "updated", snapshot: read.snapshot }
}

async function tombstone() {
  return tombstoneGitHubRepositoryContextOnUninstall({
    db: {} as D1Database,
    installationId: 42,
    deliveryId: "delivery-123",
    nowIso: NOW,
  })
}

describe("GitHub repository-context uninstall tombstone", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("creates a revision-one tombstone when the scope is absent", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce({ status: "not_found" })
    mocks.purgeRepositoryContext.mockResolvedValueOnce(updated(1))

    await expect(tombstone()).resolves.toEqual({ status: "ok", changed: true, revision: 1 })
    expect(mocks.purgeRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "github",
        scopeId: "42",
        expectedRevision: 0,
        nowIso: NOW,
        updatedBy: expect.stringMatching(/^github-webhook:installation\.deleted:[a-f0-9]{64}$/),
      }),
    )
  })

  it("does not copy or hash an oversized delivery header into the audit actor", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce({ status: "not_found" })
    mocks.purgeRepositoryContext.mockResolvedValueOnce(updated(1))

    await tombstoneGitHubRepositoryContextOnUninstall({
      db: {} as D1Database,
      installationId: 42,
      deliveryId: "x".repeat(129),
      nowIso: NOW,
    })

    expect(mocks.purgeRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ updatedBy: "github-webhook:installation.deleted" }),
    )
  })

  it("hashes a delivery header at the accepted boundary", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce({ status: "not_found" })
    mocks.purgeRepositoryContext.mockResolvedValueOnce(updated(1))

    await tombstoneGitHubRepositoryContextOnUninstall({
      db: {} as D1Database,
      installationId: 42,
      deliveryId: "x".repeat(128),
      nowIso: NOW,
    })

    expect(mocks.purgeRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        updatedBy: expect.stringMatching(/^github-webhook:installation\.deleted:[a-f0-9]{64}$/),
      }),
    )
  })

  it("does not write or churn revision when the scope is already tombstoned", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(snapshot(3, NOW))

    await expect(tombstone()).resolves.toEqual({ status: "ok", changed: false, revision: 3 })
    expect(mocks.purgeRepositoryContext).not.toHaveBeenCalled()
  })

  it("accepts a concurrent duplicate winner after a conflict", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(5, NOW))
    mocks.purgeRepositoryContext.mockResolvedValueOnce({ status: "conflict", currentRevision: 5 })

    await expect(tombstone()).resolves.toEqual({ status: "ok", changed: false, revision: 5 })
    expect(mocks.readRepositoryContext).toHaveBeenCalledTimes(2)
    expect(mocks.purgeRepositoryContext).toHaveBeenCalledTimes(1)
  })

  it("fails retryably when a conflicting writer leaves the scope active", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(5))
    mocks.purgeRepositoryContext.mockResolvedValueOnce({ status: "conflict", currentRevision: 5 })

    await expect(tombstone()).resolves.toEqual({ status: "retryable_failure" })
    expect(mocks.purgeRepositoryContext).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["initial read", { status: "unavailable" } satisfies RepositoryContextReadResult, null],
    ["write", snapshot(2), { status: "unavailable" } satisfies RepositoryContextWriteResult],
    [
      "post-conflict read",
      snapshot(2),
      { status: "conflict", currentRevision: 3 } satisfies RepositoryContextWriteResult,
    ],
  ])("fails retryably for an unavailable %s", async (phase, firstRead, write) => {
    mocks.readRepositoryContext.mockResolvedValueOnce(firstRead)
    if (phase === "post-conflict read") {
      mocks.readRepositoryContext.mockResolvedValueOnce({ status: "unavailable" })
    }
    if (write) mocks.purgeRepositoryContext.mockResolvedValueOnce(write)

    await expect(tombstone()).resolves.toEqual({ status: "retryable_failure" })
  })

  it("fails closed before D1 for an invalid installation id", async () => {
    const result = await tombstoneGitHubRepositoryContextOnUninstall({
      db: {} as D1Database,
      installationId: Number.MAX_SAFE_INTEGER + 1,
      deliveryId: "delivery-123",
      nowIso: NOW,
    })

    expect(result).toEqual({ status: "retryable_failure" })
    expect(mocks.readRepositoryContext).not.toHaveBeenCalled()
    expect(mocks.purgeRepositoryContext).not.toHaveBeenCalled()
  })
})
