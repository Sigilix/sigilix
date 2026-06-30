// SIG-38 free-launch caps — end-to-end test of the Linear-triage rate-limit
// gate wired into triageIssue() (its real call path, not just the orchestrator
// in isolation). Mocks LinearClient/model/retrieval/dedupe (genuinely external
// IO) but exercises the REAL checkTriageRateLimit + appendTriageUsage against
// a real D1 shim, so the gate's wiring — not just its pure logic — is proven.
//
// Strategy mirrors index-dispatch.rate-limit.test.ts (the PR-review admission
// gate's e2e suite): hoisted mocks for the IO boundary, then assert on
// whether the costly model call ran and what got written to D1.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0002_create_triage_usage_ledger.sql", import.meta.url),
  "utf8",
)

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({
    text: JSON.stringify({ headline: "Headline", severity: "P2", estimate: "S", labels: [], body: "Body text." }),
  })),
}))
vi.mock("@/src/shared/adapters/model", () => ({ generate: generateMock }))

const ISSUE = {
  id: "issue-abc",
  identifier: "SIG-1",
  title: "Test issue",
  description: "A description",
  url: "https://linear.app/sigilix/issue/SIG-1",
  team: { id: "team-1", key: "SIG" },
  creator: { name: "bob", displayName: "Bob" },
  labels: { nodes: [] },
  comments: { nodes: [] },
}

const { getIssueMock, createCommentMock, updateCommentMock, resolveLabelsMock, updateIssueMock, LinearClientMock } =
  vi.hoisted(() => ({
    getIssueMock: vi.fn(async () => ISSUE),
    createCommentMock: vi.fn(async () => "comment-1"),
    updateCommentMock: vi.fn(async () => undefined),
    resolveLabelsMock: vi.fn(async () => [] as string[]),
    updateIssueMock: vi.fn(async () => undefined),
    LinearClientMock: vi.fn(),
  }))
vi.mock("@/src/lib/linear", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/linear")>()
  return {
    ...actual,
    buildLinearAuth: vi.fn(async () => ({ apiKey: "fake-key" })),
    LinearClient: LinearClientMock,
    // SIG-144 slice 4: triageIssue now builds its client via buildLinearClient.
    // Spreading `...actual` would otherwise leave the REAL buildLinearClient in
    // place (it calls the real buildLinearAuth/LinearClient internally, not
    // these overrides), so it must be overridden explicitly — reuse the same
    // LinearClientMock constructor the rest of this suite already configures.
    buildLinearClient: vi.fn(async () => LinearClientMock()),
  }
})

const { getMarkerMock, setMarkerMock } = vi.hoisted(() => ({
  getMarkerMock: vi.fn(async () => null),
  setMarkerMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/shared/util/dedupe", () => ({ getMarker: getMarkerMock, setMarker: setMarkerMock }))

const { markBotAuthoredCommentMock } = vi.hoisted(() => ({
  markBotAuthoredCommentMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/bot-authored-comments", () => ({ markBotAuthoredComment: markBotAuthoredCommentMock }))

vi.mock("@/src/lib/retrieval", () => ({
  retrieveChunks: vi.fn(async () => []),
  formatChunksForPrompt: vi.fn(() => null),
}))

// ─── import SUT after mocks ───────────────────────────────────────────────────

import { triageIssue } from "@/src/lib/triage"
import { buildLinearClient } from "@/src/lib/linear"

const mockBuildLinearClient = vi.mocked(buildLinearClient)

// ─── helpers ──────────────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000

function recentIso(hoursAgo = 0.5): string {
  return new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString()
}

async function insertTriage(db: D1Database, teamId: string, idx: number, createdAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO triage_usage_ledger (team_id, issue_id, created_at) VALUES (?, ?, ?)")
    .bind(teamId, `issue-${idx}`, createdAt)
    .run()
}

async function triageRowCount(db: D1Database, teamId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM triage_usage_ledger WHERE team_id = ?")
    .bind(teamId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

function makeEnv(db: D1Database, mode: string): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_RATE_LIMIT_MODE: mode,
    OPENCLAW_STATE: {} as unknown as KVNamespace,
    OLLAMA_API_KEY: "fake-ollama-key",
  } as unknown as Env
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  // Explicitly re-establish every mock's default implementation (not just
  // mockClear) — vi.restoreAllMocks() in the previous test's afterEach
  // strips the implementation off plain vi.fn() mocks, not just their call
  // history, so each test must re-arm them. Mirrors
  // index-dispatch-rate-limit-gate.test.ts's beforeEach convention.
  LinearClientMock.mockReset().mockImplementation(() => ({
    getIssue: getIssueMock,
    createComment: createCommentMock,
    updateComment: updateCommentMock,
    resolveLabels: resolveLabelsMock,
    updateIssue: updateIssueMock,
  }))
  generateMock.mockReset().mockResolvedValue({
    text: JSON.stringify({ headline: "Headline", severity: "P2", estimate: "S", labels: [], body: "Body text." }),
  })
  getIssueMock.mockReset().mockResolvedValue(ISSUE)
  createCommentMock.mockReset().mockResolvedValue("comment-1")
  updateCommentMock.mockReset().mockResolvedValue(undefined)
  resolveLabelsMock.mockReset().mockResolvedValue([])
  updateIssueMock.mockReset().mockResolvedValue(undefined)
  getMarkerMock.mockReset().mockResolvedValue(null)
  setMarkerMock.mockReset().mockResolvedValue(undefined)
  markBotAuthoredCommentMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Real Date.now() is used by triageIssue's internal `since()` timer AND by
// the rate-limit gate's `Date.now()` call — pin it so `recentIso` windows
// line up deterministically with what the gate sees. Restores ONLY the
// Date.now spy (not vi.restoreAllMocks()) so the mock CALL HISTORY on
// generateMock/createCommentMock survives for the test's assertions, which
// run after this resolves.
function withFixedNow<T>(fn: () => Promise<T>): Promise<T> {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW)
  return fn().finally(() => nowSpy.mockRestore())
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("triageIssue — SIG-38 free-launch Linear-triage rate-limit gate", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("shadow mode (default), team OVER cap (used=3) → still triages (shadow never blocks)", async () => {
    for (let i = 0; i < 3; i++) await insertTriage(db, "team-1", i, recentIso(0.5))

    await withFixedNow(() => triageIssue("issue-abc", makeEnv(db, "shadow")))

    expect(generateMock).toHaveBeenCalledOnce()
    expect(createCommentMock).toHaveBeenCalledOnce() // the real triage verdict comment, not a notice.
    // A new triage row is appended for this issue (real triage ran to completion).
    expect(await triageRowCount(db, "team-1")).toBe(4)
  })

  it("enforce mode, team UNDER cap (used=2) → triages normally", async () => {
    for (let i = 0; i < 2; i++) await insertTriage(db, "team-1", i, recentIso(0.5))

    await withFixedNow(() => triageIssue("issue-abc", makeEnv(db, "enforce")))

    expect(generateMock).toHaveBeenCalledOnce()
    expect(createCommentMock).toHaveBeenCalledOnce()
    expect(await triageRowCount(db, "team-1")).toBe(3)
  })

  it("enforce mode, team OVER cap (used=3) → skips triage, posts a rate-limit notice, never calls the model", async () => {
    for (let i = 0; i < 3; i++) await insertTriage(db, "team-1", i, recentIso(0.5))

    await withFixedNow(() => triageIssue("issue-abc", makeEnv(db, "enforce")))

    expect(generateMock).not.toHaveBeenCalled()
    expect(createCommentMock).toHaveBeenCalledOnce()
    expect(createCommentMock).toHaveBeenCalledWith("issue-abc", expect.stringMatching(/Rate limit reached/))
    expect(markBotAuthoredCommentMock).toHaveBeenCalledWith({}, "comment-1")
    // No NEW row appended — the skip never reaches appendTriageUsage.
    expect(await triageRowCount(db, "team-1")).toBe(3)
  })

  it("enforce mode, over cap, notice-comment post FAILS → fail-open: falls through and triages anyway", async () => {
    for (let i = 0; i < 3; i++) await insertTriage(db, "team-1", i, recentIso(0.5))
    createCommentMock.mockRejectedValueOnce(new Error("linear API down"))
    createCommentMock.mockResolvedValueOnce("comment-2") // the verdict comment that follows.

    await withFixedNow(() => triageIssue("issue-abc", makeEnv(db, "enforce")))

    // First call (the notice) threw; the gate falls open and the real
    // triage still runs, posting the verdict comment as its second call.
    expect(generateMock).toHaveBeenCalledOnce()
    expect(createCommentMock).toHaveBeenCalledTimes(2)
  })
})

// ── SIG-144 slice 4 spot-check: the REAL caller (triageIssue) under unified
// mode, through the REAL buildLinearAuth/buildLinearClient — not the
// per-suite LinearClientMock above. Proves the production wiring, not just
// that triageIssue calls *a* mocked client.
describe("triageIssue — SIG-144 slice 4 spot-check (real buildLinearAuth/buildLinearClient under unified mode)", () => {
  it("OPENCLAW_LINEAR_UNIFIED=on routes triageIssue's Linear calls through the broker agent token, never the human LINEAR_API_KEY", async () => {
    const actual = await vi.importActual<typeof import("@/src/lib/linear")>("@/src/lib/linear")
    mockBuildLinearClient.mockImplementationOnce(actual.buildLinearClient)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const env = {
      OLLAMA_API_KEY: "fake-ollama-key",
      OPENCLAW_STATE: {} as unknown as KVNamespace,
      OPENCLAW_LINEAR_UNIFIED: "on",
      LINEAR_API_KEY: "human-key-must-never-be-used",
      LINEAR_TOKEN_BROKER: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => ({
          getValidToken: async () => ({ ok: true, accessToken: "agent-token-xyz" }),
          forceRefresh: async () => ({ ok: false, reason: "not-installed" }),
        }),
      },
    } as unknown as Env

    // issue:null short-circuits triageIssue right after getIssue (before the
    // rate-limit gate / model call / comment post) — the minimal real path
    // that still proves buildLinearAuth picked the broker token.
    await withFixedNow(() => triageIssue("issue-missing", env))

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const authHeader = (init.headers as Record<string, string>).authorization
    expect(authHeader).toBe("Bearer agent-token-xyz")
    expect(authHeader).not.toContain("human-key-must-never-be-used")
  })
})
