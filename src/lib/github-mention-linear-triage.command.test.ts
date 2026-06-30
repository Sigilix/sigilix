// SIG-545 A: Direct unit tests for handleLinearTriageCommand.
//
// The integration tests in github-mention.linear-triage.test.ts mock
// handleLinearTriageCommand itself, so the security-critical logic
// (auth gate, shadow mode, KV dedupe, no-team path, created/error replies)
// that lives inside it was previously untested. This file covers it directly.
//
// Mocking strategy: mock the leaf dependencies of runLinearTriageAction
// (LinearClient + buildLinearAuth from @/src/lib/linear, triageIssue from
// @/src/lib/triage) instead of runLinearTriageAction itself — intra-module
// calls in the same ESM file are not interceptable via vi.mock at the
// call-site level. The client is passed in as a fake object.

import { beforeEach, describe, expect, it, vi } from "vitest"

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { createIssueMock, buildLinearAuthMock } = vi.hoisted(() => ({
  createIssueMock: vi.fn(),
  buildLinearAuthMock: vi.fn(async () => ({ apiKey: "fake-linear-key" })),
}))

vi.mock("@/src/lib/linear", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/linear")>()
  class FakeLinearClient {
    createIssue = createIssueMock
  }
  return {
    ...actual,
    LinearClient: FakeLinearClient,
    buildLinearAuth: buildLinearAuthMock,
    // SIG-144 slice 4: handleLinearTriageCommand's runLinearTriageAction now
    // builds its client via buildLinearClient. Spreading `...actual` would
    // otherwise leave the REAL buildLinearClient in place, which calls the
    // REAL buildLinearAuth/LinearClient internally (mock overrides don't
    // propagate into the actual module's own internal references) — so this
    // must be overridden explicitly, returning the same FakeLinearClient the
    // rest of this suite already asserts against.
    buildLinearClient: vi.fn(async () => new FakeLinearClient()),
  }
})

const { triageIssueMock } = vi.hoisted(() => ({
  triageIssueMock: vi.fn(async () => {}),
}))

vi.mock("@/src/lib/triage", () => ({
  triageIssue: triageIssueMock,
}))

// ─── Imports (after vi.mock calls) ─────────────────────────────────────────

import { handleLinearTriageCommand } from "@/src/lib/github-mention-linear-triage"
import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"

// ─── Helpers ───────────────────────────────────────────────────────────────

const TRIAGE_QUESTION = "make a linear triage"
const NON_TRIAGE_QUESTION = "what does this PR do?"

const TEAM_MAP = JSON.stringify({ "acme/myapp": "team-uuid-123" })
const OWNER = "acme"
const REPO = "myapp"
const PR_NUMBER = 7
const COMMENT_ID = 1001

const FAKE_ISSUE = {
  id: "issue-abc",
  identifier: "ARC-42",
  url: "https://linear.app/acme/issue/ARC-42",
}

function makeKv(seed: Map<string, string> = new Map()): KVNamespace {
  return {
    get: vi.fn(async (key: string) => seed.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      seed.set(key, value)
    }),
    delete: vi.fn(async () => {}),
  } as unknown as KVNamespace
}

function makeEnv(mode: string | undefined, teamMap: string | undefined, kv: KVNamespace): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: mode,
    OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP: teamMap,
    LINEAR_API_KEY: "fake-linear-api-key",
  } as unknown as Env
}

function makeClient(prTitle = "PR title", prBody = "PR body"): GitHubClient {
  return {
    getPullRequest: vi.fn(async () => ({ title: prTitle, body: prBody })),
  } as unknown as GitHubClient
}

function baseArgs(overrides: Partial<Parameters<typeof handleLinearTriageCommand>[0]> = {}) {
  return {
    env: makeEnv("on", TEAM_MAP, makeKv()),
    client: makeClient(),
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    commentId: COMMENT_ID,
    authorLogin: "dev-human",
    authorAssociation: "OWNER" as const,
    question: TRIAGE_QUESTION,
    ...overrides,
  }
}

// ─── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  buildLinearAuthMock.mockResolvedValue({ apiKey: "fake-linear-key" })
  triageIssueMock.mockResolvedValue(undefined)
  createIssueMock.mockResolvedValue(FAKE_ISSUE)
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("handleLinearTriageCommand — direct unit tests", () => {
  it("(a) non-matching question → {handled:false}", async () => {
    const result = await handleLinearTriageCommand(baseArgs({ question: NON_TRIAGE_QUESTION }))
    expect(result).toEqual({ handled: false })
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(b) mode off + matching question → {handled:false}", async () => {
    const kv = makeKv()
    const env = makeEnv(undefined, TEAM_MAP, kv)
    const result = await handleLinearTriageCommand(baseArgs({ env }))
    expect(result).toEqual({ handled: false })
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(c) mode on + untrusted author (NONE) → {handled:true, reply:null}, no Linear create", async () => {
    const getPullRequest = vi.fn()
    const client = { getPullRequest } as unknown as GitHubClient
    const result = await handleLinearTriageCommand(baseArgs({ authorAssociation: "NONE", client }))
    expect(result).toEqual({ handled: true, reply: null })
    expect(getPullRequest).not.toHaveBeenCalled()
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(d) mode shadow + trusted author + matching → {handled:true, reply:null}, no create", async () => {
    const kv = makeKv()
    const env = makeEnv("shadow", TEAM_MAP, kv)
    const getPullRequest = vi.fn()
    const client = { getPullRequest } as unknown as GitHubClient
    const result = await handleLinearTriageCommand(baseArgs({ env, client, authorAssociation: "MEMBER" }))
    expect(result).toEqual({ handled: true, reply: null })
    expect(getPullRequest).not.toHaveBeenCalled()
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(e) mode on + trusted author (OWNER) + matching → reply contains Created, dedupe written", async () => {
    const kv = makeKv()
    const env = makeEnv("on", TEAM_MAP, kv)
    const putSpy = kv.put as ReturnType<typeof vi.fn>
    const result = await handleLinearTriageCommand(baseArgs({ env }))
    expect(result).toMatchObject({ handled: true })
    expect((result as { handled: true; reply: string }).reply).toContain("Created")
    expect((result as { handled: true; reply: string }).reply).toContain("ARC-42")
    expect(createIssueMock).toHaveBeenCalledOnce()
    // Dedupe key written
    expect(putSpy).toHaveBeenCalledWith(
      `linear-triage:${COMMENT_ID}`,
      expect.stringContaining("ARC-42"),
      expect.objectContaining({ expirationTtl: 86400 }),
    )
  })

  it("(f) pre-seeded dedupe record → reply contains prior identifier, no new create", async () => {
    const seed = new Map([[`linear-triage:${COMMENT_ID}`, "ARC-99|https://linear.app/acme/issue/ARC-99"]])
    const kv = makeKv(seed)
    const env = makeEnv("on", TEAM_MAP, kv)
    const result = await handleLinearTriageCommand(baseArgs({ env }))
    expect(result).toMatchObject({ handled: true })
    expect((result as { handled: true; reply: string }).reply).toContain("ARC-99")
    expect((result as { handled: true; reply: string }).reply).toContain("Already created")
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(g) no-team (empty/missing map) + mode on + trusted → reply contains No Linear team, no create", async () => {
    const kv = makeKv()
    const env = makeEnv("on", undefined, kv)
    const result = await handleLinearTriageCommand(baseArgs({ env }))
    expect(result).toMatchObject({ handled: true })
    expect((result as { handled: true; reply: string }).reply).toContain("No Linear team")
    expect(createIssueMock).not.toHaveBeenCalled()
  })

  it("(h) Linear action fails (createIssue rejects) → error reply, no dedupe written", async () => {
    createIssueMock.mockRejectedValueOnce(new Error("Linear API error"))
    const kv = makeKv()
    const env = makeEnv("on", TEAM_MAP, kv)
    const putSpy = kv.put as ReturnType<typeof vi.fn>
    const result = await handleLinearTriageCommand(baseArgs({ env }))
    expect(result).toEqual({
      handled: true,
      reply: "I couldn't create the Linear issue just now — please try again.",
    })
    expect(putSpy).not.toHaveBeenCalled()
  })
})
