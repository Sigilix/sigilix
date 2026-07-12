import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const mocks = vi.hoisted(() => ({
  createIssue: vi.fn(),
  triageIssue: vi.fn(),
  getLinearConnectionByInstallation: vi.fn(),
  getLinearConfig: vi.fn(),
  resolveLinearTeamBindingForRepo: vi.fn(),
}))

vi.mock("@/src/lib/linear", () => ({
  buildLinearClient: vi.fn(() => ({ createIssue: mocks.createIssue })),
}))
vi.mock("@/src/lib/triage", () => ({ triageIssue: mocks.triageIssue }))
vi.mock("@/src/features/linear-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/linear-integration")>()
  return {
    ...actual,
    getLinearConnectionByInstallation: mocks.getLinearConnectionByInstallation,
    getLinearConfig: mocks.getLinearConfig,
    resolveLinearTeamBindingForRepo: mocks.resolveLinearTeamBindingForRepo,
  }
})

import { runLinearTriageAction } from "@/src/lib/github-mention-linear-triage"

describe("runLinearTriageAction multi-repo bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLinearConnectionByInstallation.mockResolvedValue({
      status: "active",
      organizationId: "org-a",
    })
    mocks.getLinearConfig.mockResolvedValue({
      revision: 1,
      contextMode: "auto",
      scope: { mode: "explicit", teamIds: ["team-a"] },
      prValidation: false,
      createIssue: "manual",
      planning: true,
      writeback: { comments: true, status: false, labels: false },
    })
    mocks.resolveLinearTeamBindingForRepo.mockResolvedValue({
      organizationId: "org-a",
      installationId: 11,
      teamId: "team-a",
      accessState: "allowed",
      githubRepoId: 101,
      githubRepoFullName: "acme/api",
      useAllRepos: false,
      repos: [
        { githubRepoId: 101, githubRepoFullName: "acme/api" },
        { githubRepoId: 102, githubRepoFullName: "acme/web" },
      ],
    })
    mocks.createIssue.mockResolvedValue({
      id: "issue-a",
      identifier: "SIG-1",
      url: "https://linear.app/acme/issue/SIG-1",
    })
    mocks.triageIssue.mockResolvedValue(undefined)
  })

  it("trusts membership proved by the store for a secondary repository", async () => {
    const result = await runLinearTriageAction({ SIGILIX_PLATFORM_DB: {} as D1Database } as Env, {
      owner: "acme",
      repo: "web",
      prNumber: 42,
      title: "Fix web",
      body: "Body",
      author: "alice",
      prUrl: "https://github.com/acme/web/pull/42",
      installationId: 11,
    })

    expect(result.kind).toBe("created")
    expect(mocks.createIssue).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-a" }))
  })
})
