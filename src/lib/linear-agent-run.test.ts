// SIG-545 B3: runLinearAgentRun tests.
//
// Mocks:
//   @/src/lib/linear                  — stubs LinearClient (getIssue/createComment) + buildLinearAuth
//   @/src/lib/agent-runner/dispatch   — stubs dispatchAgentRun
//
// github-installation (listTeamRepoMappings / resolveInstallation) is NOT mocked —
// the real resolution runs against JSON env vars so the gate logic is exercised.
//
// Coverage:
//   (a) happy path → builds the correct AgentRunTaskInput (owner/repo/installationId/
//       ticket/engine:"minimal"/model.id) + posts the Linear ack
//   (b) no team→repo mapping → no dispatch
//   (c) no installation → no dispatch
//   (d) no OLLAMA_API_KEY → no dispatch
//   (e) issue not found → no dispatch
//   (f) the model key NEVER appears in any console output
//   (g) SIG-145b milestone thought stream: both milestones post NON-terminal + strictly
//       before the terminal on a normal run; a milestone's own cancel-check skips just that
//       milestone without aborting the run; milestone post failures are swallowed; no
//       milestone on the interim-assignee (no sessionId) path; a dedupe skips milestones too

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest"

// ── mocks must be declared before the module-under-test is imported ──────────
vi.mock("@/src/lib/linear", () => ({
  LinearClient: vi.fn(),
  buildLinearAuth: vi.fn(),
  buildLinearAgentClient: vi.fn(),
  // SIG-144 slice 4: runLinearAgentRun now builds its client via
  // buildLinearClient instead of `new LinearClient(await buildLinearAuth(env))`.
  buildLinearClient: vi.fn(),
}))
vi.mock("@/src/lib/agent-runner/dispatch", () => ({
  dispatchAgentRun: vi.fn(),
}))
// SIG-145 (stop): the cancel-flag reads are mocked so the run-path checkpoints can be
// driven deterministically (default false = not cancelled; overridden per stop test).
vi.mock("@/src/lib/linear-agent-cancel", () => ({
  isAgentSessionCancelled: vi.fn(),
}))

import { runLinearAgentRun, dispatchTicketImplementation } from "@/src/lib/linear-agent-run"
import { isAgentSessionCancelled } from "@/src/lib/linear-agent-cancel"
import {
  LinearClient,
  buildLinearAuth,
  buildLinearAgentClient,
  buildLinearClient,
  type LinearIssue,
} from "@/src/lib/linear"
import { dispatchAgentRun, type AgentRunTaskInput } from "@/src/lib/agent-runner/dispatch"
import type { Env } from "@/src/shared/types/env"

// ── typed mock handles ────────────────────────────────────────────────────────
const mockBuildLinearAuth = vi.mocked(buildLinearAuth)
const mockBuildLinearAgentClient = vi.mocked(buildLinearAgentClient)
const mockBuildLinearClient = vi.mocked(buildLinearClient)
const mockDispatchAgentRun = vi.mocked(dispatchAgentRun)
const mockIsAgentSessionCancelled = vi.mocked(isAgentSessionCancelled)
const MockLinearClient = vi.mocked(LinearClient)

/** A recorded createAgentActivity call: (sessionId, content, type[, opts]). */
type ActivityCall = [sessionId: string, content: string, type: string, ...rest: unknown[]]
/** Terminal calls = the activities that RESOLVE the session (response/error). SIG-145
 *  posts exactly one terminal per AgentSession run (or zero when deduped/cancelled). */
function terminalActivityCalls(calls: ActivityCall[]): ActivityCall[] {
  return calls.filter((c) => c[2] === "response" || c[2] === "error")
}

// ── per-test instance method spies ──────────────────────────────────────────
let mockGetIssue: Mock<(id: string) => Promise<LinearIssue | null>>
let mockCreateComment: Mock<(issueId: string, body: string, parentId?: string) => Promise<string>>
let mockCreateAgentActivity: Mock<(sessionId: string, content: string, type: string) => Promise<void>>

// ── constants ─────────────────────────────────────────────────────────────────
const OLLAMA_KEY = "sk-ollama-secret-key-do-not-log"
const ISSUE_ID = "issue-uuid-1"

const ISSUE: LinearIssue = {
  id: ISSUE_ID,
  identifier: "SIG-545",
  title: "Implement the thing",
  description: "Do the thing carefully",
  url: "https://linear.app/sigilix/issue/SIG-545",
  team: { id: "team-uuid", key: "SIG" },
  creator: null,
  labels: { nodes: [] },
  comments: { nodes: [] },
}

/** In-memory KV stub backing the per-ticket idempotency marker (get/put/delete). */
function makeKv(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    store,
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    put: vi.fn((k: string, v: string) => {
      store.set(k, v)
      return Promise.resolve(undefined)
    }),
    delete: vi.fn((k: string) => {
      store.delete(k)
      return Promise.resolve(undefined)
    }),
  }
}

function makeEnv(extra?: Record<string, unknown>): Env {
  return {
    OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({ SIG: { owner: "Sigilix", repo: "sigilix" } }),
    OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "Sigilix/sigilix": "99" }),
    OLLAMA_API_KEY: OLLAMA_KEY,
    LINEAR_API_KEY: "linear-key",
    OPENCLAW_STATE: makeKv(),
    ...extra,
  } as unknown as Env
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runLinearAgentRun", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    mockGetIssue = vi.fn<(id: string) => Promise<LinearIssue | null>>(() => Promise.resolve(ISSUE))
    mockCreateComment = vi.fn<(issueId: string, body: string, parentId?: string) => Promise<string>>(() =>
      Promise.resolve("comment-id"),
    )
    MockLinearClient.mockImplementation(
      () => ({ getIssue: mockGetIssue, createComment: mockCreateComment }) as unknown as LinearClient,
    )
    mockBuildLinearClient.mockResolvedValue({
      getIssue: mockGetIssue,
      createComment: mockCreateComment,
    } as unknown as LinearClient)
    mockCreateAgentActivity = vi.fn<(sessionId: string, content: string, type: string) => Promise<void>>(() =>
      Promise.resolve(undefined),
    )
    mockBuildLinearAgentClient.mockResolvedValue({
      createAgentActivity: mockCreateAgentActivity,
    } as unknown as LinearClient)
    mockBuildLinearAuth.mockResolvedValue({ apiKey: "linear-key" })
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true })
    // Default: not cancelled — the run proceeds normally. Stop tests override per-call.
    mockIsAgentSessionCancelled.mockResolvedValue(false)
  })

  afterEach(() => {
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })

  // ── (a) happy path ────────────────────────────────────────────────────────

  it("dispatches the agent-runner with the correct minimal-engine input + posts the ack", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.owner).toBe("Sigilix")
    expect(input.repo).toBe("sigilix")
    expect(input.baseBranch).toBe("main")
    expect(input.installationId).toBe(99)
    expect(input.engine).toBe("minimal")
    expect(input.model.id).toBe("glm-5.2:cloud")
    expect(input.model.baseUrl).toBe("https://ollama.com/v1")
    expect(input.model.key).toBe(OLLAMA_KEY)
    expect(input.ticket).toEqual({
      identifier: "SIG-545",
      title: "Implement the thing",
      body: "Do the thing carefully",
      url: "https://linear.app/sigilix/issue/SIG-545",
    })
    expect(input.caps).toEqual({ maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 })

    // Best-effort Linear ack on the issue.
    expect(mockCreateComment).toHaveBeenCalledOnce()
    expect(mockCreateComment.mock.calls[0]![0]).toBe(ISSUE_ID)
  })

  // ── SIG-145: AgentSession completion post (resolves the "Working" spinner) ──

  it("AgentSession path: run opened a PR → posts a TERMINAL `response` activity with the PR link, NOT a comment", async () => {
    const prUrl = "https://github.com/Sigilix/sigilix/pull/9"
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true, outcome: { status: "opened", prUrl } })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    // Exactly ONE terminal activity — the `response` that leaves the session out of "Working".
    const terminal = terminalActivityCalls(mockCreateAgentActivity.mock.calls)
    expect(terminal).toHaveLength(1)
    const [sid, body, type] = terminal[0]!
    expect(sid).toBe("agent-session-1")
    expect(type).toBe("response")
    expect(body).toContain(prUrl)
    // No plain comment ack on the agent-session path.
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it("AgentSession path: a no-change run posts a terminal `response` (resolves; no PR link)", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true, outcome: { status: "no-change" } })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    const terminal = terminalActivityCalls(mockCreateAgentActivity.mock.calls)
    expect(terminal).toHaveLength(1)
    const [, body, type] = terminal[0]!
    expect(type).toBe("response")
    expect(String(body)).not.toContain("http")
  })

  it("AgentSession path: a dispatched run with an unexpected non-error status resolves as a neutral `response`, NOT an error", async () => {
    // The container contract is opened|no-change|error post-completion; a stray `started`
    // must still resolve the session, and must NOT read as the misleading "couldn't complete".
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true, outcome: { status: "started" } })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    const terminal = terminalActivityCalls(mockCreateAgentActivity.mock.calls)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]![2]).toBe("response")
  })

  it("AgentSession path: a container run FAILURE posts a terminal `error` activity (resolves, never hangs)", async () => {
    mockDispatchAgentRun.mockResolvedValue({
      runId: "run-1",
      dispatched: true,
      outcome: { status: "error", error: "container blew up" },
    })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    const terminal = terminalActivityCalls(mockCreateAgentActivity.mock.calls)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]![2]).toBe("error")
  })

  it("AgentSession path: a non-deduped non-dispatch (e.g. container fault) still posts a terminal `error` so the session resolves", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    const terminal = terminalActivityCalls(mockCreateAgentActivity.mock.calls)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]![2]).toBe("error")
  })

  it("AgentSession path: a DEDUPE does NOT post any activity (a concurrent run owns + resolves the session)", async () => {
    const kv = makeKv({ "linear-agent-run:issue-uuid-1": "1" })
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }), "agent-session-1")

    // Deduped → dispatchAgentRun never runs AND no terminal activity is posted here:
    // resolving the session would prematurely close the live run that owns it.
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it("AgentSession path swallows a completion-post failure (never throws; still dispatched)", async () => {
    mockCreateAgentActivity.mockRejectedValue(new Error("Linear API down"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")).resolves.toBeUndefined()
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  it("AgentSession path: a null agent client (no token) skips the post + logs, never throws", async () => {
    mockBuildLinearAgentClient.mockResolvedValue(null)
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")).resolves.toBeUndefined()
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-ack-no-token")
  })

  // ── SIG-145b: milestone thought stream (live progress instead of a silent "Working…") ──

  it("posts both milestones (thought then action) STRICTLY BEFORE the terminal response, on a normal run", async () => {
    const prUrl = "https://github.com/Sigilix/sigilix/pull/9"
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true, outcome: { status: "opened", prUrl } })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    const calls = mockCreateAgentActivity.mock.calls as ActivityCall[]
    expect(calls).toHaveLength(3)
    const [planning, implementing, terminal] = calls
    expect(planning![2]).toBe("thought")
    expect(String(planning![1])).toContain("Reading the codebase")
    expect(implementing![2]).toBe("action")
    expect(String(implementing![1])).toContain("Implementing")
    expect(terminal![2]).toBe("response")
    expect(String(terminal![1])).toContain(prUrl)
    // The terminal (response/error) is always LAST — never followed by a milestone.
    const terminalIndex = calls.findIndex((c) => c[2] === "response" || c[2] === "error")
    expect(terminalIndex).toBe(calls.length - 1)
  })

  it("skips a milestone whose OWN cancel-check reads cancelled, without aborting the whole run", async () => {
    // checkpoint 0: not cancelled; the planning-milestone's own cancel check: cancelled
    // (skips just that milestone); checkpoint 1, the implementing-milestone check, and
    // checkpoint 2 all read not-cancelled — the run proceeds normally otherwise.
    mockIsAgentSessionCancelled
      .mockResolvedValueOnce(false) // checkpoint 0 (pre-start)
      .mockResolvedValueOnce(true) // planning-milestone cancel check
      .mockResolvedValueOnce(false) // checkpoint 1 (pre-dispatch)
      .mockResolvedValueOnce(false) // implementing-milestone cancel check
      .mockResolvedValueOnce(false) // checkpoint 2 (post-dispatch)

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    const nonTerminal = (mockCreateAgentActivity.mock.calls as ActivityCall[]).filter(
      (c) => c[2] !== "response" && c[2] !== "error",
    )
    // Only the implementing milestone posted — the planning one was skipped for its own
    // cancel check, not for aborting the run.
    expect(nonTerminal).toHaveLength(1)
    expect(nonTerminal[0]![2]).toBe("action")
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-milestone-skipped-cancelled")
  })

  it("swallows a milestone post failure without failing the run or blocking the terminal post", async () => {
    let call = 0
    mockCreateAgentActivity.mockImplementation(() => {
      call += 1
      // Fail only the FIRST call (the planning milestone) — the rest still succeed.
      return call === 1 ? Promise.reject(new Error("Linear API down")) : Promise.resolve(undefined)
    })

    await expect(runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")).resolves.toBeUndefined()

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    // The terminal post still went through despite the milestone failure.
    expect(terminalActivityCalls(mockCreateAgentActivity.mock.calls)).toHaveLength(1)
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-milestone-failed")
  })

  it("does NOT post a milestone on the interim-assignee path (no sessionId — no session to narrate into)", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
  })

  it("a DEDUPE skips both milestones too (not just the terminal) — zero activity, matching dispatchTicketImplementation's contract", async () => {
    const kv = makeKv({ "linear-agent-run:issue-uuid-1": "1" })
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }), "agent-session-1")

    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
  })

  // ── SIG-145: stop/cancel checkpoints ──

  it("stop before start (cancelled at checkpoint 0) → no dispatch, no activity posted at all", async () => {
    mockIsAgentSessionCancelled.mockResolvedValue(true)

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-cancelled")
  })

  it("stop before dispatch (cancelled at checkpoint 1) → NO container dispatch, NO terminal post", async () => {
    // checkpoint 0 and the planning-milestone cancel check both see not-cancelled (so the
    // planning milestone posts), then checkpoint 1 (pre-dispatch) sees cancelled and aborts
    // — before the container ever dispatches and before the implementing milestone / terminal.
    mockIsAgentSessionCancelled
      .mockResolvedValueOnce(false) // checkpoint 0 (pre-start)
      .mockResolvedValueOnce(false) // planning-milestone cancel check
      .mockResolvedValueOnce(true) // checkpoint 1 (pre-dispatch)

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    // No TERMINAL activity — the abort happens before dispatch and before the terminal
    // post. A non-terminal planning milestone may already have posted; that's fine, it
    // never resolves the session.
    expect(terminalActivityCalls(mockCreateAgentActivity.mock.calls)).toHaveLength(0)
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-cancelled")
  })

  it("stop mid-run (cancelled at checkpoint 2, after dispatch) → does NOT post its own completion (webhook already resolved as stopped)", async () => {
    // checkpoint 0, both milestone cancel checks, and checkpoint 1 all see not-cancelled
    // (so both milestones post); the post-dispatch checkpoint 2 sees cancelled.
    mockIsAgentSessionCancelled
      .mockResolvedValueOnce(false) // checkpoint 0 (pre-start)
      .mockResolvedValueOnce(false) // planning-milestone cancel check
      .mockResolvedValueOnce(false) // checkpoint 1 (pre-dispatch)
      .mockResolvedValueOnce(false) // implementing-milestone cancel check
      .mockResolvedValueOnce(true) // checkpoint 2 (post-dispatch)
    mockDispatchAgentRun.mockResolvedValue({
      runId: "run-1",
      dispatched: true,
      outcome: { status: "opened", prUrl: "https://github.com/Sigilix/sigilix/pull/9" },
    })

    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    // The container ran, but the run does NOT post a "Done" completion over the webhook's
    // "stopped" resolution.
    expect(terminalActivityCalls(mockCreateAgentActivity.mock.calls)).toHaveLength(0)
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-cancelled")
  })

  it('engine is ALWAYS "minimal" (untrusted input path — never "full")', async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.engine).toBe("minimal")
    expect(input.engine).not.toBe("full")
  })

  it("falls back to an empty ticket body when the issue has no description", async () => {
    mockGetIssue.mockResolvedValue({ ...ISSUE, description: null })
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.ticket.body).toBe("")
  })

  it("does NOT post an ack when dispatch reports dispatched:false", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it("swallows an ack failure (never throws; still counts as dispatched)", async () => {
    mockCreateComment.mockRejectedValue(new Error("Linear API down"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv())).resolves.toBeUndefined()
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  // ── per-ticket idempotency (SIG-545 B3) ─────────────────────────────────────

  it("dedupes a repeat run for the same issue (marker present → no dispatch)", async () => {
    const kv = makeKv({ "linear-agent-run:issue-uuid-1": "1" })
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-deduped")
  })

  it("sets the idempotency marker (1h TTL) before dispatching", async () => {
    const kv = makeKv()
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(kv.put).toHaveBeenCalledWith("linear-agent-run:issue-uuid-1", "1", { expirationTtl: 3600 })
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  it("releases the marker on a no-op dispatch (dispatched:false) so retries aren't suppressed", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    const kv = makeKv()
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(kv.delete).toHaveBeenCalledWith("linear-agent-run:issue-uuid-1")
    expect(kv.store.has("linear-agent-run:issue-uuid-1")).toBe(false)
  })

  // ── (b) no team→repo mapping ────────────────────────────────────────────────

  it("does NOT dispatch when the issue's team has no repo mapping", async () => {
    const env = makeEnv({ OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({ OTHER: { owner: "x", repo: "y" } }) })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-repo-mapping")
  })

  // ── (c) no installation ─────────────────────────────────────────────────────

  it("does NOT dispatch when no installation resolves for the repo", async () => {
    const env = makeEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "other/repo": "1" }) })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-installation")
  })

  // ── (d) no OLLAMA_API_KEY ───────────────────────────────────────────────────

  it("does NOT dispatch when OLLAMA_API_KEY is unset", async () => {
    const env = makeEnv({ OLLAMA_API_KEY: undefined })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-model-key")
  })

  // ── (e) issue not found ─────────────────────────────────────────────────────

  it("does NOT dispatch when the issue is not found", async () => {
    mockGetIssue.mockResolvedValue(null)
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-issue-not-found")
  })

  // ── (f) secrets never logged ────────────────────────────────────────────────

  it("never logs the model key in any console output", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")
    expect(allOutput).toContain("linear-agent-run-dispatched")
    expect(allOutput).not.toContain(OLLAMA_KEY)
  })

  it("never throws out (a thrown getIssue is logged + swallowed)", async () => {
    mockGetIssue.mockRejectedValue(new Error("Linear unreachable"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv())).resolves.toBeUndefined()
    expect(spyError.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-failed")
  })
})

// ── dispatchTicketImplementation (SIG-545 B3b shared core) ──────────────────────

describe("dispatchTicketImplementation", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  const TICKET = {
    identifier: "SIG-545",
    title: "Implement the thing",
    body: "Do the thing carefully",
    url: "https://linear.app/sigilix/issue/SIG-545",
  }
  const DEDUPE_ID = "issue-uuid-1"
  const DEDUPE_KEY = `linear-agent-run:${DEDUPE_ID}`

  function args() {
    return { owner: "Sigilix", repo: "sigilix", installationId: 99, ticket: TICKET, dedupeId: DEDUPE_ID }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true })
  })

  afterEach(() => {
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })

  it("happy path → dispatched:true + correct minimal-engine AgentRunTaskInput + sets the marker", async () => {
    const kv = makeKv()
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    expect(result).toEqual({ dispatched: true })
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.owner).toBe("Sigilix")
    expect(input.repo).toBe("sigilix")
    expect(input.baseBranch).toBe("main")
    expect(input.installationId).toBe(99)
    expect(input.engine).toBe("minimal")
    expect(input.model.id).toBe("glm-5.2:cloud")
    expect(input.model.baseUrl).toBe("https://ollama.com/v1")
    expect(input.model.key).toBe(OLLAMA_KEY)
    expect(input.ticket).toEqual(TICKET)
    expect(input.caps).toEqual({ maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 })
    expect(kv.put).toHaveBeenCalledWith(DEDUPE_KEY, "1", { expirationTtl: 3600 })
  })

  it("dedupes when the marker is already present (no dispatch) and flags deduped:true", async () => {
    const kv = makeKv({ [DEDUPE_KEY]: "1" })
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    // SIG-145: `deduped:true` tells the AgentSession caller NOT to resolve the session —
    // a concurrent/earlier run owns it.
    expect(result).toEqual({ dispatched: false, deduped: true })
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-deduped")
  })

  it("returns dispatched:false (no dispatch, no marker) when OLLAMA_API_KEY is unset", async () => {
    const kv = makeKv()
    const result = await dispatchTicketImplementation(
      makeEnv({ OPENCLAW_STATE: kv, OLLAMA_API_KEY: undefined }),
      args(),
    )

    expect(result).toEqual({ dispatched: false })
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-model-key")
  })

  it("releases the marker when dispatch reports dispatched:false", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    const kv = makeKv()
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    expect(result).toEqual({ dispatched: false })
    expect(kv.delete).toHaveBeenCalledWith(DEDUPE_KEY)
    expect(kv.store.has(DEDUPE_KEY)).toBe(false)
  })

  it("never logs the model key", async () => {
    await dispatchTicketImplementation(makeEnv(), args())
    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")
    expect(allOutput).not.toContain(OLLAMA_KEY)
  })
})
