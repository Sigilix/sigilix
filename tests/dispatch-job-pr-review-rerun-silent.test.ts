// ARC-236 (code-reviewer M1 catch on PR #80) — when
// `enqueueWarmupRerunsForIndex` fires a `pr-review-rerun` job
// post-indexing, the customer didn't type `/sigilix review` and the
// slash-command ack ("👀 reviewing...") would be unsolicited noise on
// every open PR. The handler honors `job.silent === true` by skipping
// `createIssueComment`. Slash-command-driven reruns omit `silent` and
// keep the existing ack behavior.

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockGetInstallationToken,
  mockCreateIssueComment,
  mockGetPullRequest,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockCreateIssueComment: vi.fn(async () => undefined),
  mockGetPullRequest: vi.fn(async () => ({
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
  })),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import { dispatchJob } from "../src/index"
import type { Env } from "../src/shared/types/env"
import type { JobMessage } from "../src/shared/types/job"

function makeEnv(): { env: Env; sent: JobMessage[]; kv: Map<string, string> } {
  const store = new Map<string, string>()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: {
      send: async (m: JobMessage) => { sent.push(m) },
    } as unknown as Queue<unknown>,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, sent, kv: store }
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockCreateIssueComment.mockClear()
  mockGetPullRequest.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("dispatchJob — pr-review-rerun silent flag (ARC-236 M1)", () => {
  it("skips slash-command ack when silent=true (warmup-fired rerun)", async () => {
    const { env, sent, doCalls } = makeEnvWithDo()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: true,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    // The rerun still routes the review through the DO; silence is
    // ack-only, the review itself must still happen.
    expect(doCalls).toHaveLength(1)
    expect(doCalls[0]?.url).toContain("/enqueue")
    expect(sent).toHaveLength(0)
  })

  it("posts slash-command ack when silent is unset (slash-command-driven rerun)", async () => {
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })

  it("posts slash-command ack when silent=false (explicit opt-in to ack)", async () => {
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: false,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  it("ack failure when silent=false does NOT block the underlying review enqueue", async () => {
    mockCreateIssueComment.mockRejectedValueOnce(new Error("HTTP 403 Forbidden"))
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })
})

// SIG-11 — silent (warmup) reruns must route through enqueuePrReviewJob
// so DO `/enqueue` dedup catches the case where a normal webhook-driven
// review already ran on the same headSha. Pre-fix used a raw
// `OPENCLAW_JOBS.send` that bypassed both the DO and the consumer-
// wrapper's runId check, producing duplicate ensemble runs (PR #96).

function makeEnvWithDo(args: {
  doResponse?: { deduped: boolean; runId: string; action: string }
} = {}): { env: Env; sent: JobMessage[]; doCalls: Array<{ url: string; body: unknown }> } {
  const sent: JobMessage[] = []
  const doCalls: Array<{ url: string; body: unknown }> = []
  const stub = {
    fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined
      doCalls.push({ url, body })
      return new Response(
        JSON.stringify(args.doResponse ?? { deduped: false, runId: "rid", action: "create" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }),
  } as unknown as DurableObjectStub
  const env = {
    OPENCLAW_STATE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: {
      send: async (m: JobMessage) => { sent.push(m) },
    } as unknown as Queue<unknown>,
    PR_REVIEW_RUN: {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => stub) as unknown as DurableObjectNamespace["get"],
    } as unknown as DurableObjectNamespace,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, sent, doCalls }
}

describe("dispatchJob — pr-review-rerun SIG-11 DO dedup routing", () => {
  it("silent=true routes through DO /enqueue with no direct queue send", async () => {
    const { env, sent, doCalls } = makeEnvWithDo()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: true,
    }
    await dispatchJob(job, env)

    // DO /enqueue was hit with the current headSha — the DO owns
    // dedup against any active or terminal run on the same SHA.
    expect(doCalls).toHaveLength(1)
    expect(doCalls[0]?.url).toContain("/enqueue")
    expect(doCalls[0]?.body).toMatchObject({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    })
    // The helper does not direct-send; the DO's /enqueue handler
    // emits the queue message itself with runId populated.
    expect(sent).toHaveLength(0)
  })

  it("silent=true + DO dedup-terminal response: no second ensemble run is dispatched", async () => {
    // The scenario from PR #96: 8ad306a already had a completed
    // ensemble run; the warmup rerun arriving moments later must
    // observe the dedup-terminal and skip.
    const { env, sent, doCalls } = makeEnvWithDo({
      doResponse: { deduped: true, runId: "prior-run-id", action: "dedupe-terminal" },
    })
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: true,
    }
    await dispatchJob(job, env)

    // DO /enqueue called and returned dedup-terminal (200, deduped:true).
    expect(doCalls).toHaveLength(1)
    // No queue message sent in either direction — DO refuses to
    // re-emit because the run already terminated.
    expect(sent).toHaveLength(0)
  })

  it("silent=false (slash-command rerun) STILL uses raw queue send (intentional bypass per ARC-280)", async () => {
    // Slash-command-driven reruns intentionally bypass per-headSha
    // dedup — the user explicitly typed `/sigilix review` and wants
    // a fresh run. Preserve that contract; SIG-11 only changes the
    // silent (warmup) path.
    const { env, sent, doCalls } = makeEnvWithDo()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      // silent omitted — slash-command path
    }
    await dispatchJob(job, env)

    // No DO call — slash-command rerun went straight to queue send.
    expect(doCalls).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })
})

// SIG-98 — slash-command-driven (non-silent) reruns must run on a
// paused PR. The pause/ignore KV gate lives inside
// `enqueuePrReviewJob`; the non-silent rerun bypasses that helper
// entirely via a raw `OPENCLAW_JOBS.send`. This pair of tests locks
// the bypass behavior so a future refactor that routes the rerun
// path through `enqueuePrReviewJob` can't silently suppress
// user-typed re-runs on paused PRs.
describe("dispatchJob — pr-review-rerun SIG-98 pause gate bypass", () => {
  it("user-typed /sigilix review still runs when the PR is paused", async () => {
    const { env, sent, kv } = makeEnv()
    // Pre-seed both pause and ignore flags. Slash-command re-run
    // should still go through.
    kv.set("pr-paused:Arc-and-Anchor/sigilix#237", String(Date.now()))
    kv.set("pr-ignored:Arc-and-Anchor/sigilix#237", String(Date.now()))
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      // silent omitted → user-typed slash command path
    }
    await dispatchJob(job, env)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })

  it("silent (warmup) reruns DO honor the pause gate via enqueuePrReviewJob", async () => {
    const { env, sent, doCalls } = makeEnvWithDo()
    // Reach into the env's KV (makeEnvWithDo's KV always returns
    // null) and replace it with a stub that returns a pause flag.
    const kv = new Map<string, string>([
      ["pr-paused:Arc-and-Anchor/sigilix#237", String(Date.now())],
    ])
    ;(env as { OPENCLAW_STATE: KVNamespace }).OPENCLAW_STATE = {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v) },
      delete: async (k: string) => { kv.delete(k) },
    } as unknown as KVNamespace
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: true,
    }
    await dispatchJob(job, env)
    // Gate skipped the enqueue → no queue send, no DO call.
    expect(sent).toHaveLength(0)
    expect(doCalls).toHaveLength(0)
  })
})
