// ARC-190 Task 10 — slash-command 👀 ack dispatch wiring tests.
//
// Validates `queueGithubMention`'s call into `postSlashCommandEyesAck`:
// fires when slash + ACL passes + coalesce misses; never fires on
// rejection / coalesce hit / @-mention path. Helper-internals tests
// live in `tests/slash-command-eyes-ack.test.ts`.

import { describe, it, expect, vi } from "vitest"

const { eyesAckDispatchMock } = vi.hoisted(() => ({
  eyesAckDispatchMock: vi.fn(async () => {}),
}))
vi.mock("@/src/lib/slash-command-eyes-ack", () => ({
  postSlashCommandEyesAck: eyesAckDispatchMock,
}))

import { queueGithubMention } from "@/src/index"
import type { Env } from "@/src/shared/types/env"

interface FakePayloadOpts {
  body?: string
  authorAssoc?: string
  commentId?: number
}

function makePayload(opts: FakePayloadOpts = {}) {
  return {
    action: "created",
    installation: { id: 99 },
    repository: { name: "sigilix", owner: { login: "Arc-and-Anchor" } },
    issue: { number: 7, pull_request: { url: "..." } },
    comment: {
      id: opts.commentId ?? 4242,
      body: opts.body ?? "/sigilix help",
      user: { login: "human-user" },
      author_association: opts.authorAssoc ?? "MEMBER",
    },
  } as unknown as Parameters<typeof queueGithubMention>[0]["payload"]
}

function makeEnv(opts: { coalesceKeyExists?: boolean } = {}): { env: Env; queueSent: unknown[] } {
  const store = new Map<string, string>()
  if (opts.coalesceKeyExists) {
    store.set("slash-cmd:help:Arc-and-Anchor/sigilix#7", String(Date.now()))
  }
  const queueSent: unknown[] = []
  const env = {
    OPENCLAW_STATE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key); return true },
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: {
      send: async (msg: unknown) => { queueSent.push(msg) },
    } as unknown as Queue<unknown>,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
  } as unknown as Env
  return { env, queueSent }
}

const fakeCtx: ExecutionContext = {
  waitUntil: (p: Promise<unknown>) => { void p },
  passThroughOnException: () => {},
} as unknown as ExecutionContext

describe("queueGithubMention dispatch — slash-command 👀 ack wiring", () => {
  it("eyes-ack fires when slash command parses AND ACL passes AND coalesce misses", async () => {
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv()
    const res = await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix help", authorAssoc: "MEMBER" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(res.status).toBe(202)
    expect(queueSent).toHaveLength(1)
    expect(eyesAckDispatchMock).toHaveBeenCalledOnce()
    expect(eyesAckDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      commentId: 4242,
      surface: "issue",
      installationId: 99,
    }))
  })

  it("/sigilix review queues a manual rerun without consulting pull-request draft state", async () => {
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv()
    const res = await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix review", authorAssoc: "MEMBER" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(res.status).toBe(202)
    expect(queueSent).toHaveLength(1)
    expect(queueSent[0]).toMatchObject({
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
    })
    expect(eyesAckDispatchMock).toHaveBeenCalledOnce()
  })

  it("eyes-ack does NOT fire when ACL rejects (untrusted author_association)", async () => {
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv()
    const res = await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix help", authorAssoc: "FIRST_TIME_CONTRIBUTOR" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(res.status).toBe(403)
    expect(queueSent).toHaveLength(0)
    expect(eyesAckDispatchMock).not.toHaveBeenCalled()
  })

  it("eyes-ack does NOT fire when coalesce hits", async () => {
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv({ coalesceKeyExists: true })
    const res = await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix help", authorAssoc: "MEMBER" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(res.status).toBe(202)
    expect(queueSent).toHaveLength(0)
    expect(eyesAckDispatchMock).not.toHaveBeenCalled()
  })

  it("eyes-ack does NOT fire on @-mention path (already handled by the mention consumer)", async () => {
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv()
    const res = await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "@sigilix what does this do?" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(res.status).toBe(202)
    expect(queueSent).toHaveLength(1)
    expect((queueSent[0] as { type: string }).type).toBe("github-mention")
    expect(eyesAckDispatchMock).not.toHaveBeenCalled()
  })

  it("eyes-ack does NOT fire on describe-unknown fast path (synchronous usage comment IS the ack)", async () => {
    // The unknown-arg fast path posts a usage comment synchronously
    // (see src/index.ts handling of `slashCmd.cmd === "describe" &&
    // slashCmd.mode === "unknown"`) and returns before reaching the
    // coalesce / dispatch site. A future refactor that moved the
    // dispatch above the fast path would silently break the contract.
    eyesAckDispatchMock.mockClear()
    const { env, queueSent } = makeEnv()
    // Mock createIssueComment via a minimal client surface — the
    // describe-unknown fast path constructs its own GitHubClient
    // inline. Posting will fail in this harness; the path catches +
    // logs that. We only care that eyes is NOT dispatched.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix describe garbage", authorAssoc: "MEMBER" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "issue", prNumber: 7,
    })
    expect(queueSent).toHaveLength(0)
    expect(eyesAckDispatchMock).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("review-comment surface threads 'review-comment' through to the helper", async () => {
    eyesAckDispatchMock.mockClear()
    const { env } = makeEnv()
    await queueGithubMention({
      env, ctx: fakeCtx,
      payload: makePayload({ body: "/sigilix improve", authorAssoc: "OWNER" }),
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
      surface: "review-comment", prNumber: 7,
    })
    expect(eyesAckDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      surface: "review-comment",
    }))
  })
})
