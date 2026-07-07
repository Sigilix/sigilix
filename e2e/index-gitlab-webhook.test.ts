// sig-gitlab-adapter (GitLab support PR 2): end-to-end GitLab webhook ingress.
// Exercises the real `default.fetch` handler in src/index.ts with a GitLab
// Merge Request Hook: plaintext-token verify -> event-parse -> review decision
// -> `gitlab-mr-review` enqueue. Mirrors the GitHub webhook e2e shape.

import { beforeEach, describe, expect, it, vi } from "vitest"

const SECRET = "gitlab-hook-secret"
const TOKEN = "glpat-test"

function makeEnv(overrides: Record<string, unknown> = {}): {
  env: Record<string, unknown>
  sentJobs: Array<{ type: string; [k: string]: unknown }>
} {
  const sentJobs: Array<{ type: string; [k: string]: unknown }> = []
  const env = {
    SIGILIX_GITLAB_WEBHOOK_SECRET: SECRET,
    SIGILIX_GITLAB_TOKEN: TOKEN,
    OPENCLAW_JOBS: {
      send: async (msg: { type: string; [k: string]: unknown }) => {
        sentJobs.push(msg)
      },
    },
    ...overrides,
  }
  return { env, sentJobs }
}

function mrPayload(over: Record<string, unknown> = {}) {
  return {
    object_kind: "merge_request",
    project: { id: 42, path_with_namespace: "grp/sub/proj" },
    object_attributes: {
      iid: 7,
      action: "open",
      source_branch: "feature/x",
      target_branch: "main",
      title: "Add feature",
      description: "does a thing",
      last_commit: { id: "c".repeat(40) },
      diff_refs: { base_sha: "b".repeat(40), head_sha: "c".repeat(40) },
      ...over,
    },
  }
}

async function post(
  worker: { fetch: (req: Request, env: never, ctx: never) => Promise<Response> },
  env: unknown,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = JSON.stringify(payload)
  const req = new Request("https://api.sigilix.ai/gitlab/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Merge Request Hook",
      // GitLab echoes the WEBHOOK secret (not the API token) in this header.
      "x-gitlab-token": SECRET,
      "x-gitlab-event-uuid": "delivery-1",
      ...headers,
    },
    body,
  })
  const waited: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => {} }
  const res = await worker.fetch(req, env as never, ctx as never)
  await Promise.all(waited)
  return res
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("POST /gitlab/webhook", () => {
  it("a signed MR `open` hook enqueues a gitlab-mr-review job (202)", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload())

    expect(res.status).toBe(202)
    expect(sentJobs).toHaveLength(1)
    expect(sentJobs[0]).toMatchObject({
      type: "gitlab-mr-review",
      projectPath: "grp/sub/proj",
      projectId: 42,
      mrIid: 7,
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      sourceBranch: "feature/x",
      targetBranch: "main",
      deliveryId: "delivery-1",
    })
    // The GitHub pr-review path is untouched: no pr-review job.
    expect(sentJobs.some((j) => j.type === "pr-review")).toBe(false)
  })

  it("rejects a bad token with 401 and enqueues nothing", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload(), { "x-gitlab-token": "wrong" })
    expect(res.status).toBe(401)
    expect(sentJobs).toHaveLength(0)
  })

  it("returns 503 when GitLab is not configured (no secret/token)", async () => {
    const { env, sentJobs } = makeEnv({ SIGILIX_GITLAB_WEBHOOK_SECRET: undefined, SIGILIX_GITLAB_TOKEN: undefined })
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload())
    expect(res.status).toBe(503)
    expect(sentJobs).toHaveLength(0)
  })

  it("acks non-MR events (200) without enqueueing", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, { object_kind: "push" }, { "x-gitlab-event": "Push Hook" })
    expect(res.status).toBe(200)
    expect(sentJobs).toHaveLength(0)
  })

  it("skips a `merge` action (200) — no re-review on merge", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload({ action: "merge" }))
    expect(res.status).toBe(200)
    expect(sentJobs).toHaveLength(0)
  })

  it("skips a draft MR (WIP title) with 200", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload({ title: "Draft: WIP feature", work_in_progress: true }))
    expect(res.status).toBe(200)
    expect(sentJobs).toHaveLength(0)
  })

  it("a code `update` (oldrev present) enqueues a review", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload({ action: "update", oldrev: "a".repeat(40) }))
    expect(res.status).toBe(202)
    expect(sentJobs).toHaveLength(1)
    expect(sentJobs[0]).toMatchObject({ type: "gitlab-mr-review", mrIid: 7 })
  })

  it("skips a metadata-only `update` (no oldrev) with 200 — GitHub `synchronize` parity", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload({ action: "update" }))
    expect(res.status).toBe(200)
    expect(sentJobs).toHaveLength(0)
  })

  it("a `reopen` action posts overview only — no review enqueue (GitHub parity)", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default
    const res = await post(worker, env, mrPayload({ action: "reopen" }))
    // decision.overview true, decision.review false -> 202 ack, no gitlab-mr-review job
    expect(res.status).toBe(202)
    expect(sentJobs).toHaveLength(0)
  })
})
