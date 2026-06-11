// SIG-156 — POST /admin/index-repo: auth, validation, enqueue.

import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock the App-JWT installation resolver so the route can be tested without a
// real RSA key / GitHub API call.
vi.mock("@/src/shared/adapters/github/github-app", () => ({ resolveRepoInstallationId: vi.fn() }))
vi.mock("@/src/lib/index-backfill", () => ({ runIndexBackfill: vi.fn() }))
vi.mock("@/src/lib/index-reconciliation", () => ({ runIndexReconciliation: vi.fn() }))

import { handleAdminIndexRoute, handleAdminBackfillRoute, handleAdminReconcileRoute } from "@/src/lib/admin-index-route"
import { resolveRepoInstallationId } from "@/src/shared/adapters/github/github-app"
import { runIndexBackfill } from "@/src/lib/index-backfill"
import { runIndexReconciliation } from "@/src/lib/index-reconciliation"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const mockResolve = vi.mocked(resolveRepoInstallationId)
const TOKEN = "admin-token"

function makeEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}): { env: Env; sent: JobMessage[] } {
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_ADMIN_TOKEN: TOKEN,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_JOBS: {
      send: async (m: JobMessage) => {
        sent.push(m)
      },
    },
    ...overrides,
  } as unknown as Env
  return { env, sent }
}

const post = (url: string, auth?: string) =>
  new Request(url, { method: "POST", ...(auth ? { headers: { authorization: auth } } : {}) })

beforeEach(() => mockResolve.mockReset())

describe("handleAdminIndexRoute", () => {
  it("503 when the admin token is unset", async () => {
    const { env } = makeEnv({ OPENCLAW_ADMIN_TOKEN: undefined })
    const res = await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(503)
  })

  it("401 on missing/wrong bearer", async () => {
    const { env } = makeEnv()
    expect((await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r"), env)).status).toBe(401)
    expect(
      (await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r", "Bearer no"), env)).status,
    ).toBe(401)
  })

  it("400 when owner or repo is missing", async () => {
    const { env } = makeEnv()
    expect(
      (await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o", `Bearer ${TOKEN}`), env)).status,
    ).toBe(400)
    expect(
      (await handleAdminIndexRoute(post("https://x/admin/index-repo?repo=r", `Bearer ${TOKEN}`), env)).status,
    ).toBe(400)
  })

  it("503 when the GitHub App isn't configured (either credential missing)", async () => {
    for (const missing of [{ GITHUB_APP_ID: undefined }, { GITHUB_PRIVATE_KEY: undefined }]) {
      const { env } = makeEnv(missing)
      const res = await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r", `Bearer ${TOKEN}`), env)
      expect(res.status).toBe(503)
    }
  })

  it("400 on an invalid owner/repo slug", async () => {
    const { env, sent } = makeEnv()
    for (const q of ["owner=a%20b&repo=r", "owner=o&repo=..%2Fx", "owner=o&repo=a/b"]) {
      const res = await handleAdminIndexRoute(post(`https://x/admin/index-repo?${q}`, `Bearer ${TOKEN}`), env)
      expect(res.status).toBe(400)
    }
    expect(sent).toHaveLength(0)
  })

  it("404 when the app isn't installed on the repo", async () => {
    mockResolve.mockResolvedValue(null)
    const { env, sent } = makeEnv()
    const res = await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(404)
    expect(sent).toHaveLength(0) // nothing enqueued
  })

  it("202 enqueues a manual index-repo job with the resolved installationId", async () => {
    mockResolve.mockResolvedValue(998877)
    const { env, sent } = makeEnv()
    const res = await handleAdminIndexRoute(
      post("https://x/admin/index-repo?owner=Sigilix&repo=sigilix", `Bearer ${TOKEN}`),
      env,
    )
    expect(res.status).toBe(202)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Sigilix",
      repo: "sigilix",
      installationId: 998877,
      reason: "manual",
    })
  })
})

const mockBackfill = vi.mocked(runIndexBackfill)

describe("handleAdminBackfillRoute", () => {
  beforeEach(() => mockBackfill.mockReset())

  it("503 when the admin token is unset", async () => {
    const { env } = makeEnv({ OPENCLAW_ADMIN_TOKEN: undefined })
    expect(
      (await handleAdminBackfillRoute(post("https://x/admin/index-backfill", `Bearer ${TOKEN}`), env)).status,
    ).toBe(503)
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it("401 on missing/wrong bearer", async () => {
    const { env } = makeEnv()
    expect((await handleAdminBackfillRoute(post("https://x/admin/index-backfill"), env)).status).toBe(401)
  })

  it("503 when the GitHub App isn't configured", async () => {
    const { env } = makeEnv({ GITHUB_PRIVATE_KEY: undefined })
    expect(
      (await handleAdminBackfillRoute(post("https://x/admin/index-backfill", `Bearer ${TOKEN}`), env)).status,
    ).toBe(503)
  })

  it("200 returns the backfill summary (dryRun flag threaded)", async () => {
    mockBackfill.mockResolvedValue({
      installations: 3,
      repos: 12,
      enqueued: 12,
      sensitiveSkipped: 0,
      perRepoFailed: 0,
      dryRun: true,
      enumerationIncomplete: false,
    })
    const { env } = makeEnv()
    const res = await handleAdminBackfillRoute(
      post("https://x/admin/index-backfill?dryRun=true", `Bearer ${TOKEN}`),
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ installations: 3, repos: 12, dryRun: true })
    expect(mockBackfill).toHaveBeenCalledWith(env, { dryRun: true })
  })

  it("defaults dryRun=false when not specified", async () => {
    mockBackfill.mockResolvedValue({
      installations: 0,
      repos: 0,
      enqueued: 0,
      sensitiveSkipped: 0,
      perRepoFailed: 0,
      dryRun: false,
      enumerationIncomplete: false,
    })
    const { env } = makeEnv()
    await handleAdminBackfillRoute(post("https://x/admin/index-backfill", `Bearer ${TOKEN}`), env)
    expect(mockBackfill).toHaveBeenCalledWith(env, { dryRun: false })
  })
})

const mockReconcile = vi.mocked(runIndexReconciliation)
const reconcileSummary = (dryRun: boolean) => ({
  installations: 1,
  reposChecked: 2,
  reposMissingManifest: 1,
  reposMissingGraph: 0,
  graphReadErrors: 0,
  enqueued: 1,
  sensitiveSkipped: 0,
  perRepoFailed: 0,
  dryRun,
  enumerationIncomplete: false,
})

describe("handleAdminReconcileRoute", () => {
  beforeEach(() => mockReconcile.mockReset())

  it("503 when the admin token is unset", async () => {
    const { env } = makeEnv({ OPENCLAW_ADMIN_TOKEN: undefined })
    expect(
      (await handleAdminReconcileRoute(post("https://x/admin/index-reconcile", `Bearer ${TOKEN}`), env)).status,
    ).toBe(503)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it("401 on missing/wrong bearer", async () => {
    const { env } = makeEnv()
    expect((await handleAdminReconcileRoute(post("https://x/admin/index-reconcile"), env)).status).toBe(401)
  })

  it("503 when the GitHub App isn't configured", async () => {
    const { env } = makeEnv({ GITHUB_PRIVATE_KEY: undefined })
    expect(
      (await handleAdminReconcileRoute(post("https://x/admin/index-reconcile", `Bearer ${TOKEN}`), env)).status,
    ).toBe(503)
  })

  it("200 returns the reconciliation summary (dryRun flag threaded)", async () => {
    mockReconcile.mockResolvedValue(reconcileSummary(true))
    const { env } = makeEnv()
    const res = await handleAdminReconcileRoute(
      post("https://x/admin/index-reconcile?dryRun=true", `Bearer ${TOKEN}`),
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      reposChecked: 2,
      reposMissingManifest: 1,
      reposMissingGraph: 0,
      graphReadErrors: 0,
      dryRun: true,
    })
    expect(mockReconcile).toHaveBeenCalledWith(env, { dryRun: true })
  })

  it("defaults dryRun=false when not specified", async () => {
    mockReconcile.mockResolvedValue(reconcileSummary(false))
    const { env } = makeEnv()
    await handleAdminReconcileRoute(post("https://x/admin/index-reconcile", `Bearer ${TOKEN}`), env)
    expect(mockReconcile).toHaveBeenCalledWith(env, { dryRun: false })
  })
})
