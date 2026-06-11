// SIG-156 PR3 — runIndexReconciliation: enumerate installs → repos → enqueue
// ONLY for repos missing a manifest. Catches dropped install / repos-added
// webhooks; idempotent (existing manifests = no work).

import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  listAppInstallationIds: vi.fn(),
  listInstallationRepoFullNames: vi.fn(),
}))
vi.mock("@/src/lib/index-producer", async () => {
  // Keep the real `parseFullName` — it's pure, no IO, and reconcile delegates
  // to it so its "missing manifest" decision matches what the producer
  // actually accepts on enqueue.
  const actual = await vi.importActual<typeof import("@/src/lib/index-producer")>("@/src/lib/index-producer")
  return { ...actual, enqueueIndexJobsForRepos: vi.fn() }
})
vi.mock("@/src/lib/repo-index-manifest", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/repo-index-manifest")>("@/src/lib/repo-index-manifest")
  return { ...actual, readRepoIndexManifest: vi.fn() }
})
vi.mock("@/src/lib/repo-graph-client", () => ({
  debugActiveGraphVersion: vi.fn(),
}))

import { runIndexReconciliation } from "@/src/lib/index-reconciliation"
import { listAppInstallationIds, listInstallationRepoFullNames } from "@/src/shared/adapters/github/github-app"
import { enqueueIndexJobsForRepos } from "@/src/lib/index-producer"
import { readRepoIndexManifest } from "@/src/lib/repo-index-manifest"
import { debugActiveGraphVersion } from "@/src/lib/repo-graph-client"
import type { Env } from "@/src/shared/types/env"

const mockListInstalls = vi.mocked(listAppInstallationIds)
const mockListRepos = vi.mocked(listInstallationRepoFullNames)
const mockEnqueue = vi.mocked(enqueueIndexJobsForRepos)
const mockReadManifest = vi.mocked(readRepoIndexManifest)
const mockDebugActiveGraphVersion = vi.mocked(debugActiveGraphVersion)

const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", OPENCLAW_STATE: {} } as unknown as Env
const ok = <T>(items: T[]) => ({ items, complete: true })

// Minimal manifest shape — the reconciler only cares about kind:"ok" vs not.
const okManifest = () => ({
  kind: "ok" as const,
  manifest: {
    v: 1,
    repo: "r",
    owner: "o",
    headSha: "h",
    runId: "run",
    fileCount: 0,
    chunkCount: 0,
    shardCount: 1,
    indexedAt: "2026-05-22T00:00:00Z",
    modelId: "m",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 80,
    overlapLines: 16,
  },
})

beforeEach(() => {
  mockListInstalls.mockReset()
  mockListRepos.mockReset()
  mockEnqueue.mockReset()
  mockReadManifest.mockReset()
  mockDebugActiveGraphVersion.mockReset()
})

describe("runIndexReconciliation", () => {
  it("returns an empty summary when the GitHub App isn't configured", async () => {
    const out = await runIndexReconciliation({} as Env, { dryRun: false })
    expect(out.installations).toBe(0)
    expect(out.reposChecked).toBe(0)
    expect(out.reposMissingManifest).toBe(0)
    expect(mockListInstalls).not.toHaveBeenCalled()
  })

  it("enqueues ONLY repos with a missing manifest; skips fresh ones", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b", "o/c"]))
    // a = fresh, b = missing, c = fresh
    mockReadManifest
      .mockResolvedValueOnce(okManifest())
      .mockResolvedValueOnce({ kind: "missing" })
      .mockResolvedValueOnce(okManifest())
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out).toMatchObject({
      installations: 1,
      reposChecked: 3,
      reposMissingManifest: 1,
      reposMissingGraph: 0,
      graphReadErrors: 0,
      enqueued: 1,
      sensitiveSkipped: 0,
      perRepoFailed: 0,
      enumerationIncomplete: false,
    })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 111,
        reason: "manual",
        // Only the missing repo is in the fan-out batch
        repositories: [{ full_name: "o/b" }],
      }),
    )
  })

  it("treats an invalid manifest as missing (corrupt KV value triggers re-index)", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"]))
    mockReadManifest.mockResolvedValueOnce({ kind: "invalid", reason: "shape" })
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out.reposMissingManifest).toBe(1)
    expect(out.enqueued).toBe(1)
  })

  it("skips an installation entirely if all repos are fresh (no enqueue call at all)", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"]))
    mockReadManifest.mockResolvedValueOnce(okManifest()).mockResolvedValueOnce(okManifest())

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out).toMatchObject({
      installations: 1,
      reposChecked: 2,
      reposMissingManifest: 0,
      enqueued: 0,
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("dry-run reports the missing-manifest count but enqueues nothing", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"]))
    mockReadManifest.mockResolvedValueOnce({ kind: "missing" }).mockResolvedValueOnce(okManifest())

    const out = await runIndexReconciliation(env, { dryRun: true })

    expect(out).toMatchObject({
      reposChecked: 2,
      reposMissingManifest: 1,
      enqueued: 0,
      dryRun: true,
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("enqueues repos whose manifest is fresh but graph active version is missing (SIG-155)", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"]))
    mockReadManifest.mockResolvedValueOnce(okManifest()).mockResolvedValueOnce(okManifest())
    mockDebugActiveGraphVersion.mockResolvedValueOnce("run").mockResolvedValueOnce(null)
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation({ ...env, OPENCLAW_GRAPH_INDEX: "shadow" } as Env, {
      dryRun: false,
    })

    expect(out).toMatchObject({
      reposChecked: 2,
      reposMissingManifest: 0,
      reposMissingGraph: 1,
      enqueued: 1,
    })
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ full_name: "o/b" }],
      }),
    )
  })

  it("enqueues repos whose manifest is fresh but graph active version is stale", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"]))
    mockReadManifest.mockResolvedValueOnce(okManifest())
    mockDebugActiveGraphVersion.mockResolvedValueOnce("older-run")
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation({ ...env, OPENCLAW_GRAPH_INDEX: "shadow" } as Env, {
      dryRun: false,
    })

    expect(out.reposMissingGraph).toBe(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ full_name: "o/a" }],
      }),
    )
  })

  it("treats graph active-version read errors as fail-soft and does not enqueue", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"]))
    mockReadManifest.mockResolvedValueOnce(okManifest())
    mockDebugActiveGraphVersion.mockRejectedValueOnce(new Error("DO transient"))

    const out = await runIndexReconciliation({ ...env, OPENCLAW_GRAPH_INDEX: "shadow" } as Env, {
      dryRun: false,
    })

    expect(out.reposMissingGraph).toBe(0)
    expect(out.graphReadErrors).toBe(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("does not read graph state when graph indexing is off", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"]))
    mockReadManifest.mockResolvedValueOnce(okManifest())

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out.reposMissingGraph).toBe(0)
    expect(mockDebugActiveGraphVersion).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("manifest-read throw is fail-soft: skips the repo + flags enumerationIncomplete (no enqueue)", async () => {
    mockListInstalls.mockResolvedValue(ok([111]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a", "o/b"]))
    mockReadManifest.mockRejectedValueOnce(new Error("KV transient")).mockResolvedValueOnce({ kind: "missing" })
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })

    // The throwing read is NOT treated as missing — next tick re-checks.
    expect(out.reposMissingManifest).toBe(1)
    expect(out.enumerationIncomplete).toBe(true)
    // The non-throwing missing repo IS enqueued (we don't abort the install).
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ full_name: "o/b" }],
      }),
    )
  })

  it("flags enumerationIncomplete when installation listing is partial", async () => {
    mockListInstalls.mockResolvedValue({ items: [111], complete: false })
    mockListRepos.mockResolvedValueOnce(ok(["o/a"]))
    mockReadManifest.mockResolvedValueOnce({ kind: "missing" })
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })
    expect(out.enumerationIncomplete).toBe(true)
  })

  it("flags enumerationIncomplete when a repo listing is partial, keeps fanning out", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"])).mockResolvedValueOnce({ items: ["o/b"], complete: false })
    mockReadManifest.mockResolvedValueOnce({ kind: "missing" }).mockResolvedValueOnce({ kind: "missing" })
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })
    expect(out.enumerationIncomplete).toBe(true)
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
  })

  it("distinguishes 'all repos healthy' from 'nothing scanned' via enumerationIncomplete (Codex review)", async () => {
    // Every install enumerates fine but every repo listing returns empty +
    // incomplete (GitHub side error, e.g. rate-limited mid-page). The
    // operator needs to read enumerationIncomplete=true + reposChecked=0
    // to tell this apart from "all healthy, nothing to do."
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos
      .mockResolvedValueOnce({ items: [], complete: false })
      .mockResolvedValueOnce({ items: [], complete: false })

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out.installations).toBe(2)
    expect(out.reposChecked).toBe(0)
    expect(out.reposMissingManifest).toBe(0)
    expect(out.enumerationIncomplete).toBe(true)
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockReadManifest).not.toHaveBeenCalled()
  })

  it("per-installation fail-soft: listInstallationRepoFullNames throw doesn't abort (CodeRabbit M1)", async () => {
    // Token refresh / GH 5xx mid-tick used to abort every remaining install.
    // Wrap fail-soft: log + enumerationIncomplete, continue to next install.
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockRejectedValueOnce(new Error("github 503")).mockResolvedValueOnce(ok(["o/x"]))
    mockReadManifest.mockResolvedValueOnce({ kind: "missing" })
    mockEnqueue.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      perRepoFailed: 0,
      sensitiveSkipped: 0,
    })

    const out = await runIndexReconciliation(env, { dryRun: false })

    expect(out.installations).toBe(2)
    expect(out.enumerationIncomplete).toBe(true)
    expect(out.enqueued).toBe(1) // 2nd install completed
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 222,
        repositories: [{ full_name: "o/x" }],
      }),
    )
  })

  it("per-installation fail-soft: enqueue throw on one install doesn't abort the run", async () => {
    mockListInstalls.mockResolvedValue(ok([111, 222]))
    mockListRepos.mockResolvedValueOnce(ok(["o/a"])).mockResolvedValueOnce(ok(["o/c"]))
    mockReadManifest.mockResolvedValueOnce({ kind: "missing" }).mockResolvedValueOnce({ kind: "missing" })
    mockEnqueue
      .mockRejectedValueOnce(new Error("queue binding broken"))
      .mockResolvedValueOnce({ attempted: 1, succeeded: 1, perRepoFailed: 0, sensitiveSkipped: 0 })

    const out = await runIndexReconciliation(env, { dryRun: false })
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
    expect(out.enqueued).toBe(1)
    expect(out.enumerationIncomplete).toBe(true)
  })
})
