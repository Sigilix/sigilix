// SIG-545 Task 3 — unit tests for runLinearTriageAction.
//
// Mocks: LinearClient.createIssue + buildLinearAuth (@/src/lib/linear),
//        triageIssue (@/src/lib/triage).
// resolveLinearTeamForRepo is pure (no I/O) — driven via env values instead.
//
// Cases:
//   (a) happy path  → {kind:"created", identifier:"SIG-1", triaged:true}
//   (b) no team     → {kind:"no-team"}, createIssue NOT called
//   (c) createIssue throws → {kind:"error"}
//   (d) triageIssue throws after create → {kind:"created", triaged:false}

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockCreateIssue, mockBuildLinearAuth } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(async () => ({
    id: "id1",
    identifier: "SIG-1",
    url: "https://linear.app/sigilix/issue/SIG-1",
  })),
  mockBuildLinearAuth: vi.fn(async () => ({ apiKey: "fake-key" })),
}))

vi.mock("@/src/lib/linear", () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    createIssue: mockCreateIssue,
  })),
  buildLinearAuth: mockBuildLinearAuth,
  // SIG-144 slice 4: runLinearTriageAction now builds its client via
  // buildLinearClient (the single helper that also wires the unified-mode
  // 401-retry hook) instead of `new LinearClient(await buildLinearAuth(env))`.
  buildLinearClient: vi.fn(async () => ({ createIssue: mockCreateIssue })),
}))

const { mockTriageIssue } = vi.hoisted(() => ({
  mockTriageIssue: vi.fn(async () => undefined),
}))

vi.mock("@/src/lib/triage", () => ({
  triageIssue: mockTriageIssue,
}))

import { runLinearTriageAction } from "@/src/lib/github-mention-linear-triage"

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_API_KEY: "test-key",
    OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP: JSON.stringify({ "acme/api": "team-123" }),
    ...overrides,
  } as Env
}

const BASE_ARGS = {
  owner: "acme",
  repo: "api",
  prNumber: 42,
  title: "Fix the thing",
  body: "This PR fixes the thing.",
  author: "alice",
  prUrl: "https://github.com/acme/api/pull/42",
} as const

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("runLinearTriageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateIssue.mockResolvedValue({
      id: "id1",
      identifier: "SIG-1",
      url: "https://linear.app/sigilix/issue/SIG-1",
    })
    mockBuildLinearAuth.mockResolvedValue({ apiKey: "fake-key" })
    mockTriageIssue.mockResolvedValue(undefined)
  })

  it("(a) returns created with triaged:true on the happy path", async () => {
    const env = makeEnv()
    const result = await runLinearTriageAction(env, BASE_ARGS)

    expect(result).toEqual({
      kind: "created",
      identifier: "SIG-1",
      url: "https://linear.app/sigilix/issue/SIG-1",
      triaged: true,
    })

    // createIssue received the resolved teamId and a description that
    // contains the author handle and PR URL (attribution footer).
    expect(mockCreateIssue).toHaveBeenCalledOnce()
    expect(mockCreateIssue).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-123" }))
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("@alice") }),
    )
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("https://github.com/acme/api/pull/42") }),
    )

    // triageIssue received the newly created issue id and the same env.
    expect(mockTriageIssue).toHaveBeenCalledOnce()
    expect(mockTriageIssue).toHaveBeenCalledWith("id1", env)
  })

  it("(b) returns no-team when map is empty; createIssue is never called", async () => {
    const env = makeEnv({
      OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP: JSON.stringify({}),
    })
    const result = await runLinearTriageAction(env, BASE_ARGS)

    expect(result).toEqual({ kind: "no-team" })
    expect(mockCreateIssue).not.toHaveBeenCalled()
  })

  it("(c) returns error when createIssue throws", async () => {
    mockCreateIssue.mockRejectedValue(new Error("Linear GraphQL error"))
    const env = makeEnv()
    const result = await runLinearTriageAction(env, BASE_ARGS)

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(typeof result.message).toBe("string")
      expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it("(d) returns created with triaged:false when triageIssue throws after create", async () => {
    mockTriageIssue.mockRejectedValue(new Error("triage timeout"))
    const env = makeEnv()
    const result = await runLinearTriageAction(env, BASE_ARGS)

    expect(result).toEqual({
      kind: "created",
      identifier: "SIG-1",
      url: "https://linear.app/sigilix/issue/SIG-1",
      triaged: false,
    })
    // Issue was created; triage failure is absorbed.
    expect(mockCreateIssue).toHaveBeenCalledOnce()
  })

  it("fails closed instead of using the global team map when D1 is present but installation proof is missing", async () => {
    const env = makeEnv({ SIGILIX_PLATFORM_DB: {} as D1Database })

    await expect(runLinearTriageAction(env, BASE_ARGS)).resolves.toEqual({ kind: "no-team" })
    expect(mockCreateIssue).not.toHaveBeenCalled()
    expect(mockTriageIssue).not.toHaveBeenCalled()
  })
})
