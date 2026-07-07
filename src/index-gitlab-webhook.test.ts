// sig-gitlab-connector: tests for the per-project webhook-secret resolution added
// to the GitLab ingress. A project onboarded through the portal connect flow gets
// its OWN secret in KV; the global env secret stays the fallback so the existing
// single-secret deploy is unaffected. A non-MR event is used so verification is
// isolated from the enqueue path.

import { describe, expect, it } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { handleGitLabWebhook } from "@/src/index-gitlab-webhook"

function makeKV(seed: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

/** A minimal GitLab webhook body carrying the project id used to pick the secret. */
function body(projectId: number): string {
  return JSON.stringify({ object_kind: "push", project: { id: projectId, path_with_namespace: "grp/api" } })
}

function req(token: string, event: string, projectId: number): Request {
  return new Request("https://x/gitlab/webhook", {
    method: "POST",
    headers: { "x-gitlab-token": token, "x-gitlab-event": event, "content-type": "application/json" },
    body: body(projectId),
  })
}

describe("handleGitLabWebhook — per-project secret resolution", () => {
  it("503 when neither a per-project nor a global secret is configured", async () => {
    const env = { OPENCLAW_STATE: makeKV() } as unknown as Env
    const res = await handleGitLabWebhook(req("anything", "Push Hook", 5), env, ctx)
    expect(res.status).toBe(503)
  })

  it("verifies against the PER-PROJECT secret (portal connect flow)", async () => {
    const env = {
      OPENCLAW_STATE: makeKV({ "gitlab-webhook-secret:5": "psecret" }),
    } as unknown as Env
    // Correct per-project secret -> passes verify -> 200 for a non-MR event.
    const ok = await handleGitLabWebhook(req("psecret", "Push Hook", 5), env, ctx)
    expect(ok.status).toBe(200)
    // Wrong token -> 401.
    const bad = await handleGitLabWebhook(req("nope", "Push Hook", 5), env, ctx)
    expect(bad.status).toBe(401)
  })

  it("per-project secret takes precedence over the global env secret", async () => {
    const env = {
      OPENCLAW_STATE: makeKV({ "gitlab-webhook-secret:5": "psecret" }),
      SIGILIX_GITLAB_WEBHOOK_SECRET: "globalsecret",
    } as unknown as Env
    // The GLOBAL secret must NOT authenticate a project that has its own secret.
    const usingGlobal = await handleGitLabWebhook(req("globalsecret", "Push Hook", 5), env, ctx)
    expect(usingGlobal.status).toBe(401)
    // The per-project secret does.
    const usingProject = await handleGitLabWebhook(req("psecret", "Push Hook", 5), env, ctx)
    expect(usingProject.status).toBe(200)
  })

  it("falls back to the global env secret for a project with no per-project secret", async () => {
    const env = {
      OPENCLAW_STATE: makeKV(),
      SIGILIX_GITLAB_WEBHOOK_SECRET: "globalsecret",
    } as unknown as Env
    const ok = await handleGitLabWebhook(req("globalsecret", "Push Hook", 9), env, ctx)
    expect(ok.status).toBe(200)
    const bad = await handleGitLabWebhook(req("wrong", "Push Hook", 9), env, ctx)
    expect(bad.status).toBe(401)
  })

  it("413 when the body exceeds the pre-auth size cap", async () => {
    const env = {
      OPENCLAW_STATE: makeKV(),
      SIGILIX_GITLAB_WEBHOOK_SECRET: "globalsecret",
    } as unknown as Env
    const huge = new Request("https://x/gitlab/webhook", {
      method: "POST",
      headers: { "x-gitlab-token": "globalsecret", "x-gitlab-event": "Push Hook" },
      body: "x".repeat(1_000_001),
    })
    const res = await handleGitLabWebhook(huge, env, ctx)
    expect(res.status).toBe(413)
  })
})
