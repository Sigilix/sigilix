// sig-org-members — fetchInstallationRoster: the org-vs-personal listing
// decision + the fail-soft contract. The underlying GitHub listings
// (listOrgMembers / listInstallationCollaborators) are covered in
// github-app.test.ts; here they are mocked so we assert ONLY which one runs and
// how the result is shaped/reasoned.

import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchInstallationRoster } from "@/src/lib/org-members-roster"
import type { Env } from "@/src/shared/types/env"

const listOrgMembers = vi.fn()
const listInstallationCollaborators = vi.fn()

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  listOrgMembers: (...a: unknown[]) => listOrgMembers(...a),
  listInstallationCollaborators: (...a: unknown[]) => listInstallationCollaborators(...a),
}))

const KV = { get: async () => null, put: async () => {} } as unknown as KVNamespace
const appEnv = { OPENCLAW_STATE: KV, GITHUB_APP_ID: "123", GITHUB_PRIVATE_KEY: "pem" } as unknown as Env

afterEach(() => {
  vi.clearAllMocks()
})

describe("fetchInstallationRoster", () => {
  it("Organization install → lists org members", async () => {
    listOrgMembers.mockResolvedValue({
      items: [{ githubUserId: "101", login: "alice", avatarUrl: "a" }],
      complete: true,
    })
    const res = await fetchInstallationRoster(appEnv, 7, "acme", "Organization")
    expect(res).toEqual({
      members: [{ githubUserId: "101", login: "alice", avatarUrl: "a" }],
      complete: true,
      source: "org",
    })
    expect(listOrgMembers).toHaveBeenCalledWith(KV, "123", "pem", 7, "acme")
    expect(listInstallationCollaborators).not.toHaveBeenCalled()
  })

  it("personal (User) install → lists repo collaborators", async () => {
    listInstallationCollaborators.mockResolvedValue({
      items: [{ githubUserId: "301", login: "dana", avatarUrl: "d" }],
      complete: true,
    })
    const res = await fetchInstallationRoster(appEnv, 7, "octocat", "User")
    expect(res).toEqual({
      members: [{ githubUserId: "301", login: "dana", avatarUrl: "d" }],
      complete: true,
      source: "collaborators",
    })
    expect(listInstallationCollaborators).toHaveBeenCalledWith(KV, "123", "pem", 7)
    expect(listOrgMembers).not.toHaveBeenCalled()
  })

  it("unknown account type falls back to collaborators", async () => {
    listInstallationCollaborators.mockResolvedValue({ items: [], complete: true })
    const res = await fetchInstallationRoster(appEnv, 7, "", "")
    expect(res.source).toBe("collaborators")
    expect(listInstallationCollaborators).toHaveBeenCalled()
  })

  it("org members empty/partial → source org with a reason (fail-soft)", async () => {
    listOrgMembers.mockResolvedValue({ items: [], complete: false })
    const res = await fetchInstallationRoster(appEnv, 7, "acme", "Organization")
    expect(res).toEqual({ members: [], complete: false, source: "org", reason: "org_members_unavailable" })
  })

  it("missing App credentials → skipped, source none + reason (never calls GitHub)", async () => {
    const bare = { OPENCLAW_STATE: KV } as unknown as Env
    const res = await fetchInstallationRoster(bare, 7, "acme", "Organization")
    expect(res).toEqual({ members: [], complete: false, source: "none", reason: "app_unconfigured" })
    expect(listOrgMembers).not.toHaveBeenCalled()
    expect(listInstallationCollaborators).not.toHaveBeenCalled()
  })

  it("non-positive installation id → skipped, source none + reason", async () => {
    const res = await fetchInstallationRoster(appEnv, 0, "acme", "Organization")
    expect(res).toEqual({ members: [], complete: false, source: "none", reason: "no_installation" })
    expect(listOrgMembers).not.toHaveBeenCalled()
  })
})
