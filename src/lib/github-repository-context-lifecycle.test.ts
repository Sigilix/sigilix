import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RepositoryContextReadResult, RepositoryContextWriteResult } from "@/src/features/repository-context"

const mocks = vi.hoisted(() => ({
  readRepositoryContext: vi.fn(),
  purgeRepositoryContext: vi.fn(),
  replaceRepositoryContext: vi.fn(),
}))

vi.mock("@/src/features/repository-context", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/repository-context")>(
    "@/src/features/repository-context",
  )
  return {
    ...actual,
    readRepositoryContext: mocks.readRepositoryContext,
    purgeRepositoryContext: mocks.purgeRepositoryContext,
    replaceRepositoryContext: mocks.replaceRepositoryContext,
  }
})

import {
  reconcileGitHubRepositoryContextOnRepositoriesRemoved,
  tombstoneGitHubRepositoryContextOnUninstall,
} from "@/src/lib/github-repository-context-lifecycle"

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

function activeSnapshot(
  revision: number,
  options: {
    repositories?: Array<{ externalId: string; fullName: string; context: string; position: number }>
    relationships?: Array<{
      fromExternalId: string
      toExternalId: string
      label: string
      normalizedLabel: string
      position: number
    }>
    updatedBy?: string
  } = {},
): RepositoryContextReadResult {
  return {
    status: "ok",
    snapshot: {
      provider: "github",
      scopeId: "42",
      revision,
      repositories: options.repositories ?? [
        { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
        { externalId: "202", fullName: "acme/worker", context: "Background jobs", position: 1 },
        { externalId: "303", fullName: "acme/web", context: "Web application", position: 2 },
      ],
      relationships: options.relationships ?? [
        {
          fromExternalId: "101",
          toExternalId: "202",
          label: "publishes jobs",
          normalizedLabel: "publishes jobs",
          position: 0,
        },
        {
          fromExternalId: "101",
          toExternalId: "303",
          label: "serves web",
          normalizedLabel: "serves web",
          position: 1,
        },
      ],
      conventions: "Use conventional commits.",
      snapshotSha256: "b".repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: options.updatedBy ?? "github:111",
      deletedAt: null,
    },
  }
}

function removalArgs(repositories: Array<{ id?: number; full_name?: string }> = [{ id: 202 }]) {
  return {
    db: {} as D1Database,
    installationId: 42,
    repositories,
    deliveryId: "delivery-removed-123",
    nowIso: NOW,
  }
}

describe("GitHub repository-context repository removal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("filters exact repository ids and every incident relationship while preserving unrelated context", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(activeSnapshot(4))
    mocks.replaceRepositoryContext.mockImplementationOnce(async (_db, args) => ({
      status: "updated",
      snapshot: {
        ...(activeSnapshot(5) as Extract<RepositoryContextReadResult, { status: "ok" }>).snapshot,
        repositories: args.repositories,
        relationships: args.relationships,
        updatedBy: args.updatedBy,
      },
    }))

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toMatchObject({
      status: "ok",
      changed: true,
      revision: 5,
      removedCount: 1,
    })
    expect(mocks.replaceRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "github",
        scopeId: "42",
        expectedRevision: 4,
        repositories: [
          { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
          { externalId: "303", fullName: "acme/web", context: "Web application", position: 2 },
        ],
        relationships: [expect.objectContaining({ fromExternalId: "101", toExternalId: "303" })],
        conventions: "Use conventional commits.",
        updatedBy: expect.stringMatching(/^github-webhook:installation_repositories\.removed:[a-f0-9]{64}$/),
      }),
    )
  })

  it("creates an active empty revision-one fence when the scope is absent", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce({ status: "not_found" })
    mocks.replaceRepositoryContext.mockResolvedValueOnce({
      status: "updated",
      snapshot: {
        ...(
          activeSnapshot(1, { repositories: [], relationships: [] }) as Extract<
            RepositoryContextReadResult,
            { status: "ok" }
          >
        ).snapshot,
        conventions: "",
      },
    })

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toMatchObject({
      status: "ok",
      changed: true,
      revision: 1,
      removedCount: 0,
    })
    expect(mocks.replaceRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedRevision: 0,
        repositories: [],
        relationships: [],
        conventions: "",
      }),
    )
  })

  it("rewrites an already-clean active snapshot once to fence stale writers", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(
      activeSnapshot(7, {
        repositories: [{ externalId: "101", fullName: "acme/api", context: "Public API", position: 0 }],
        relationships: [],
      }),
    )
    mocks.replaceRepositoryContext.mockResolvedValueOnce({
      status: "updated",
      snapshot: (
        activeSnapshot(8, {
          repositories: [{ externalId: "101", fullName: "acme/api", context: "Public API", position: 0 }],
          relationships: [],
        }) as Extract<RepositoryContextReadResult, { status: "ok" }>
      ).snapshot,
    })

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toMatchObject({
      status: "ok",
      changed: true,
      revision: 8,
      removedCount: 0,
    })
    expect(mocks.replaceRepositoryContext).toHaveBeenCalledTimes(1)
  })

  it("does not churn revision on an exact-delivery redelivery after the postcondition is satisfied", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("delivery-removed-123"))
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    mocks.readRepositoryContext.mockResolvedValueOnce(
      activeSnapshot(8, {
        repositories: [{ externalId: "101", fullName: "acme/api", context: "Public API", position: 0 }],
        relationships: [],
        updatedBy: `github-webhook:installation_repositories.removed:${fingerprint}`,
      }),
    )

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toMatchObject({
      status: "ok",
      changed: false,
      revision: 8,
      removedCount: 0,
    })
    expect(mocks.replaceRepositoryContext).not.toHaveBeenCalled()
  })

  it("makes malformed ids retryable after fencing and processing valid ids", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(activeSnapshot(4))
    mocks.replaceRepositoryContext.mockResolvedValueOnce({
      status: "updated",
      snapshot: (activeSnapshot(5) as Extract<RepositoryContextReadResult, { status: "ok" }>).snapshot,
    })

    await expect(
      reconcileGitHubRepositoryContextOnRepositoriesRemoved(
        removalArgs([{ id: 202 }, {}, { id: Number.MAX_SAFE_INTEGER + 1 }]),
      ),
    ).resolves.toEqual({ status: "retryable_failure" })
    expect(mocks.replaceRepositoryContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositories: expect.not.arrayContaining([expect.objectContaining({ externalId: "202" })]),
      }),
    )
  })

  it("accepts a concurrent writer only when it established the removal postcondition", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(activeSnapshot(4)).mockResolvedValueOnce(
      activeSnapshot(5, {
        repositories: [{ externalId: "101", fullName: "acme/api", context: "Public API", position: 0 }],
        relationships: [],
      }),
    )
    mocks.replaceRepositoryContext.mockResolvedValueOnce({ status: "conflict", currentRevision: 5 })

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toMatchObject({
      status: "ok",
      changed: false,
      revision: 5,
    })
  })

  it("fails retryably when a conflicting writer retains the removed repository", async () => {
    mocks.readRepositoryContext.mockResolvedValueOnce(activeSnapshot(4)).mockResolvedValueOnce(activeSnapshot(5))
    mocks.replaceRepositoryContext.mockResolvedValueOnce({ status: "conflict", currentRevision: 5 })

    await expect(reconcileGitHubRepositoryContextOnRepositoriesRemoved(removalArgs())).resolves.toEqual({
      status: "retryable_failure",
    })
  })
})
