// SIG-156 — POST /admin/index-repo: auth, validation, enqueue.

import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock the App-JWT installation resolver so the route can be tested without a
// real RSA key / GitHub API call.
vi.mock("../src/lib/github-app", () => ({ resolveRepoInstallationId: vi.fn() }))

import { handleAdminIndexRoute } from "../src/lib/admin-index-route"
import { resolveRepoInstallationId } from "../src/lib/github-app"
import type { Env } from "../src/index"
import type { JobMessage } from "../src/lib/job-message"

const mockResolve = vi.mocked(resolveRepoInstallationId)
const TOKEN = "admin-token"

function makeEnv(overrides: Partial<Env> = {}): { env: Env; sent: JobMessage[] } {
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_ADMIN_TOKEN: TOKEN,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_JOBS: { send: async (m: JobMessage) => { sent.push(m) } },
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
    expect((await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o&repo=r", "Bearer no"), env)).status).toBe(401)
  })

  it("400 when owner or repo is missing", async () => {
    const { env } = makeEnv()
    expect((await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=o", `Bearer ${TOKEN}`), env)).status).toBe(400)
    expect((await handleAdminIndexRoute(post("https://x/admin/index-repo?repo=r", `Bearer ${TOKEN}`), env)).status).toBe(400)
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
    const res = await handleAdminIndexRoute(post("https://x/admin/index-repo?owner=Arc-and-Anchor&repo=sigilix", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(202)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 998877,
      reason: "manual",
    })
  })
})
