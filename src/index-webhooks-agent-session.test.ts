// SIG-545 (agent): tests for the handleLinearWebhook AgentSessionEvent trigger —
// the CANONICAL agent path (delegation / @-mention sets the agent as DELEGATE and
// fires AgentSessionEvent, not an Issue.update assignee diff).
//
// Mocks:
//   @/src/lib/webhook-verify — verifyLinearWebhook (skip real HMAC signing)
//   @/src/lib/linear         — buildLinearAgentClient (the ack path)
//
// Coverage:
//   (a) mode on + action "created" → acks (thought) + enqueues linear-agent-run w/ sessionId (202)
//   (b) mode on + action "prompted" → acks + enqueues (202)
//   (c) mode off → not acked, not enqueued (200)
//   (d) missing agentSession.id → 200, not enqueued
//   (e) missing issue id → acked, NOT enqueued (200)
//   (f) ack failure (no agent token) → still enqueues (202)
//   (g) invalid signature → 401, not enqueued

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

// ── mocks must precede the import of the module under test ───────────────────
vi.mock("@/src/lib/webhook-verify", () => ({
  verifyLinearWebhook: vi.fn(),
}))
vi.mock("@/src/lib/linear", () => ({
  LinearClient: vi.fn(),
  buildLinearAuth: vi.fn(),
  buildLinearAgentClient: vi.fn(),
  buildLinearClient: vi.fn(),
}))

import { handleLinearWebhook } from "@/src/index-webhooks"
import { verifyLinearWebhook } from "@/src/lib/webhook-verify"
import { buildLinearAgentClient } from "@/src/lib/linear"

const SESSION_ID = "agent-session-1"
const ISSUE_ID = "issue-uuid-1"

function makeEnv(extra?: Record<string, unknown>): { env: Env; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(() => Promise.resolve(undefined))
  const env = {
    LINEAR_WEBHOOK_SECRET: "secret",
    LINEAR_API_KEY: "linear-key",
    OPENCLAW_STATE: {} as KVNamespace,
    OPENCLAW_JOBS: { send },
    OPENCLAW_LINEAR_AGENT_RUN_MODE: "on",
    ...extra,
  } as unknown as Env
  return { env, send }
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

function sessionRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.example.com/linear/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "linear-signature": "sig" },
    body: JSON.stringify(body),
  })
}

function eventBody(action: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "AgentSessionEvent",
    action,
    agentSession: { id: SESSION_ID, issue: { id: ISSUE_ID } },
    ...overrides,
  }
}

describe("handleLinearWebhook — AgentSessionEvent trigger", () => {
  const mockCreateAgentActivity = vi.fn<
    (sessionId: string, content: string, type: string, opts?: unknown) => Promise<void>
  >(() => Promise.resolve(undefined))

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyLinearWebhook).mockResolvedValue(true)
    vi.mocked(buildLinearAgentClient).mockResolvedValue({
      createAgentActivity: mockCreateAgentActivity,
    } as never)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  it('(a) mode on + "created" → acks (thought) + enqueues linear-agent-run with sessionId (202)', async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(sessionRequest(eventBody("created")), env, makeCtx())

    expect(res.status).toBe(202)
    // ACK is bounded with an AbortSignal.timeout so it can't overrun Linear's ack
    // window (un-timed → redelivery → duplicate runs). SIG-225 pattern.
    expect(mockCreateAgentActivity).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      "thought",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // SIG-145: the ACK builds its client with allowRefresh:false so a stale-token 401
    // can't trigger a blocking broker forceRefresh that the AbortSignal doesn't bound
    // (which would overrun the ack window). The token read stays on the cached readOnly path.
    expect(buildLinearAgentClient).toHaveBeenCalledWith(env, { allowRefresh: false })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })

  it("(a2) a thrown ack (e.g. AbortError on timeout) is swallowed → still enqueues (202)", async () => {
    mockCreateAgentActivity.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    )
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(sessionRequest(eventBody("created")), env, makeCtx())

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })

  it('(b) mode on + "prompted" → acks + enqueues (202)', async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(sessionRequest(eventBody("prompted")), env, makeCtx())

    expect(res.status).toBe(202)
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })

  it("(c) mode off → not acked, not enqueued (200)", async () => {
    const { env, send } = makeEnv({ OPENCLAW_LINEAR_AGENT_RUN_MODE: "off" })
    const res = await handleLinearWebhook(sessionRequest(eventBody("created")), env, makeCtx())

    expect(res.status).toBe(200)
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("(d) missing agentSession.id → 200, not enqueued", async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(
      sessionRequest(eventBody("created", { agentSession: { issue: { id: ISSUE_ID } } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it("(e) missing issue id → acked but NOT enqueued (200)", async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(
      sessionRequest(eventBody("created", { agentSession: { id: SESSION_ID } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it("(f) ack failure (no agent token) → still enqueues (202)", async () => {
    vi.mocked(buildLinearAgentClient).mockResolvedValue(null)
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(sessionRequest(eventBody("created")), env, makeCtx())

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })

  it("(g) invalid signature → 401, not enqueued", async () => {
    vi.mocked(verifyLinearWebhook).mockResolvedValue(false)
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(sessionRequest(eventBody("created")), env, makeCtx())

    expect(res.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  // ── SIG-145 (stop): a user Stop arrives as a `prompted` event with signal "stop" ──

  it("(h) prompted + agentActivity.signal 'stop' → marks cancelled + posts terminal stopped `response`, does NOT enqueue (200)", async () => {
    const put = vi.fn(() => Promise.resolve(undefined))
    const get = vi.fn(() => Promise.resolve(null))
    const { env, send } = makeEnv({ OPENCLAW_STATE: { put, get } as unknown as KVNamespace })

    const res = await handleLinearWebhook(
      sessionRequest(eventBody("prompted", { agentActivity: { signal: "stop" } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    // A stop is a control signal, NOT a new turn — no run is enqueued (handled before dedupe).
    expect(send).not.toHaveBeenCalled()
    // The session is marked cancelled (short-TTL marker) so an in-flight run aborts.
    expect(put).toHaveBeenCalledWith(`linear-agent-cancel:${SESSION_ID}`, "1", { expirationTtl: 3600 })
    // A TERMINAL `response` "stopped" activity resolves the session immediately. The stop
    // post uses the same bounded/allowRefresh:false hot-path client as the ACK.
    expect(buildLinearAgentClient).toHaveBeenCalledWith(env, { allowRefresh: false })
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce()
    const [sid, body, type] = mockCreateAgentActivity.mock.calls[0]!
    expect(sid).toBe(SESSION_ID)
    expect(type).toBe("response")
    expect(String(body)).toMatch(/stopped/i)
  })

  it("(h2) a normal prompted turn (no stop signal) still ACKs + enqueues (not treated as a stop)", async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(
      sessionRequest(eventBody("prompted", { agentActivity: { body: "also handle X" } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })

  it("(h3) a stop with the run mode OFF is a no-op (no cancel mark, no post, no enqueue)", async () => {
    const put = vi.fn(() => Promise.resolve(undefined))
    const { env, send } = makeEnv({
      OPENCLAW_LINEAR_AGENT_RUN_MODE: "off",
      OPENCLAW_STATE: { put, get: vi.fn(() => Promise.resolve(null)) } as unknown as KVNamespace,
    })

    const res = await handleLinearWebhook(
      sessionRequest(eventBody("prompted", { agentActivity: { signal: "stop" } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(put).not.toHaveBeenCalled()
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("(h4) marks cancelled ONLY AFTER a successful 'stopped' post; a null-token post does NOT mark (avoids a hang)", async () => {
    // No agent token → the stopped post is skipped → the cancel flag must NOT be set, so
    // the in-flight run resolves the session itself instead of deferring to a post that
    // never landed (P2b).
    vi.mocked(buildLinearAgentClient).mockResolvedValue(null)
    const put = vi.fn(() => Promise.resolve(undefined))
    const { env } = makeEnv({
      OPENCLAW_STATE: { put, get: vi.fn(() => Promise.resolve(null)) } as unknown as KVNamespace,
    })

    const res = await handleLinearWebhook(
      sessionRequest(eventBody("prompted", { agentActivity: { signal: "stop" } })),
      env,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(mockCreateAgentActivity).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("(h5) a non-stop turn CLEARS any stale cancel marker before enqueuing (a re-prompt on the same session is not cancelled)", async () => {
    const del = vi.fn(() => Promise.resolve(undefined))
    const { env, send } = makeEnv({
      OPENCLAW_STATE: {
        delete: del,
        put: vi.fn(() => Promise.resolve(undefined)),
        get: vi.fn(() => Promise.resolve(null)),
      } as unknown as KVNamespace,
    })

    const res = await handleLinearWebhook(sessionRequest(eventBody("prompted")), env, makeCtx())

    expect(res.status).toBe(202)
    // A stale stop marker from a prior turn is cleared so this fresh turn's run doesn't
    // abort at its first checkpoint and hang the session (P1).
    expect(del).toHaveBeenCalledWith(`linear-agent-cancel:${SESSION_ID}`)
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID, sessionId: SESSION_ID })
  })
})
