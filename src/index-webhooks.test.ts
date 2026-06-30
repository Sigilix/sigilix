// SIG-545 B3: tests for the handleLinearWebhook assignment trigger.
//
// Mocks:
//   @/src/lib/webhook-verify — verifyLinearWebhook (so we skip real HMAC signing)
//   env.OPENCLAW_JOBS.send   — the queue producer
//
// Coverage:
//   (a) mode on + matching assignee + assignee changed → enqueues linear-agent-run (202)
//   (b) mode off → not enqueued
//   (c) wrong assignee → not enqueued
//   (d) assignee unchanged (no assigneeId in updatedFrom) → not enqueued
//   (e) OPENCLAW_LINEAR_AGENT_USER_ID unset (dark) → not enqueued

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

// ── mocks must precede the import of the module under test ───────────────────
vi.mock("@/src/lib/webhook-verify", () => ({
  verifyLinearWebhook: vi.fn(),
}))

import { handleLinearWebhook } from "@/src/index-webhooks"
import { verifyLinearWebhook } from "@/src/lib/webhook-verify"

// ── constants ─────────────────────────────────────────────────────────────────
const AGENT_USER_ID = "agent-user-uuid"
const ISSUE_ID = "issue-uuid-1"

// ── fakes ─────────────────────────────────────────────────────────────────────
function makeEnv(extra?: Record<string, unknown>): { env: Env; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(() => Promise.resolve(undefined))
  const env = {
    LINEAR_WEBHOOK_SECRET: "secret",
    LINEAR_API_KEY: "linear-key",
    OPENCLAW_STATE: {} as KVNamespace,
    OPENCLAW_JOBS: { send },
    OPENCLAW_LINEAR_AGENT_RUN_MODE: "on",
    OPENCLAW_LINEAR_AGENT_USER_ID: AGENT_USER_ID,
    ...extra,
  } as unknown as Env
  return { env, send }
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

function assignmentRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.example.com/linear/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "linear-signature": "sig" },
    body: JSON.stringify(body),
  })
}

const ASSIGN_TO_AGENT = {
  action: "update",
  type: "Issue",
  data: {
    id: ISSUE_ID,
    assigneeId: AGENT_USER_ID,
    updatedFrom: { assigneeId: null },
  },
  webhookTimestamp: 1,
}

// ── tests ─────────────────────────────────────────────────────────────────────
describe("handleLinearWebhook — SIG-545 B3 assignment trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyLinearWebhook).mockResolvedValue(true)
  })

  it("(a) mode on + matching assignee + assignee changed → enqueues linear-agent-run (202)", async () => {
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(assignmentRequest(ASSIGN_TO_AGENT), env, makeCtx())

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: "linear-agent-run", issueId: ISSUE_ID })
  })

  it("(b) mode off → not enqueued", async () => {
    const { env, send } = makeEnv({ OPENCLAW_LINEAR_AGENT_RUN_MODE: "off" })
    const res = await handleLinearWebhook(assignmentRequest(ASSIGN_TO_AGENT), env, makeCtx())

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it("(c) wrong assignee → not enqueued", async () => {
    const { env, send } = makeEnv()
    const body = {
      ...ASSIGN_TO_AGENT,
      data: { id: ISSUE_ID, assigneeId: "some-other-user", updatedFrom: { assigneeId: null } },
    }
    const res = await handleLinearWebhook(assignmentRequest(body), env, makeCtx())

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it("(d) assignee unchanged (no assigneeId key in updatedFrom) → not enqueued", async () => {
    const { env, send } = makeEnv()
    // Already assigned to the agent, but THIS update only changed the title.
    const body = {
      ...ASSIGN_TO_AGENT,
      data: { id: ISSUE_ID, assigneeId: AGENT_USER_ID, updatedFrom: { title: "old title" } },
    }
    const res = await handleLinearWebhook(assignmentRequest(body), env, makeCtx())

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it("(e) OPENCLAW_LINEAR_AGENT_USER_ID unset → not enqueued (dark)", async () => {
    const { env, send } = makeEnv({ OPENCLAW_LINEAR_AGENT_USER_ID: undefined })
    const res = await handleLinearWebhook(assignmentRequest(ASSIGN_TO_AGENT), env, makeCtx())

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it("invalid signature → 401, not enqueued", async () => {
    vi.mocked(verifyLinearWebhook).mockResolvedValue(false)
    const { env, send } = makeEnv()
    const res = await handleLinearWebhook(assignmentRequest(ASSIGN_TO_AGENT), env, makeCtx())

    expect(res.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  // SIG-144 dual-secret cutover: the handler threads env.OPENCLAW_LINEAR_AGENT_WEBHOOK_SECRET
  // into the 4th argument of verifyLinearWebhook (mocked here) so verification accepts either secret.
  it("threads OPENCLAW_LINEAR_AGENT_WEBHOOK_SECRET into the verify call as the 4th arg", async () => {
    const { env } = makeEnv({ OPENCLAW_LINEAR_AGENT_WEBHOOK_SECRET: "agent-webhook-secret" })
    await handleLinearWebhook(assignmentRequest(ASSIGN_TO_AGENT), env, makeCtx())

    expect(verifyLinearWebhook).toHaveBeenCalledWith(
      JSON.stringify(ASSIGN_TO_AGENT),
      "sig",
      "secret",
      "agent-webhook-secret",
    )
  })
})
