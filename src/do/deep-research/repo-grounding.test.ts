import { describe, it, expect } from "vitest"
import { isCodebaseQuestion, ownersForInstallation, resolveRepoTarget } from "./repo-grounding"
import type { Env } from "@/src/shared/types/env"

// A minimal KV fake exposing just the `list` the manifest scan uses.
function fakeKv(manifestNamespaces: string[]): KVNamespace {
  const keys = manifestNamespaces.map((ns) => ({ name: `repo-index-manifest:${ns}` }))
  return {
    list: async () => ({ keys, list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

function envWith(over: Partial<Env>): Env {
  return over as Env
}

describe("isCodebaseQuestion", () => {
  it("matches questions with an ownership cue about the caller's own repository", () => {
    for (const q of [
      "where does the memory indexing live in our repo?",
      "how is auth handled in this codebase?",
      "in our code, where is the rate limiter?",
      "explain the review orchestrator module in our project",
      "where is the webhook handler defined in the repo?",
    ]) {
      expect(isCodebaseQuestion(q)).toBe(true)
    }
  })

  it("does NOT match general/external questions (no ownership cue → web research)", () => {
    for (const q of [
      "what is the latest stable version of Node.js?",
      "compare Postgres and MySQL for time-series data",
      "how do JWTs work?",
      // Codex P2: general design questions must NOT be misrouted into repo grounding.
      "which service should we use for queues?",
      "where should rate limiting be implemented?",
      "which file format is best for config?",
      "",
    ]) {
      expect(isCodebaseQuestion(q)).toBe(false)
    }
  })
})

describe("ownersForInstallation", () => {
  it("returns owners (from bare + owner/repo keys) whose id matches", () => {
    const map = JSON.stringify({ acme: 111, "acme/widgets": 111, other: 222, "foo/bar": "111" })
    expect(ownersForInstallation(map, 111).sort()).toEqual(["acme", "foo"])
    expect(ownersForInstallation(map, 222)).toEqual(["other"])
  })

  it("soft-fails to [] on bad/absent JSON or a non-positive id", () => {
    expect(ownersForInstallation(undefined, 111)).toEqual([])
    expect(ownersForInstallation("not json", 111)).toEqual([])
    expect(ownersForInstallation(JSON.stringify({ acme: 111 }), 0)).toEqual([])
  })
})

describe("resolveRepoTarget", () => {
  it("accepts an explicit owner/repo a SESSION caller owns (login = owner)", async () => {
    const res = await resolveRepoTarget(envWith({}), {
      explicitOwner: "Acme",
      explicitRepo: "widgets",
      sessionLogin: "acme",
    })
    expect(res).toEqual({ target: { owner: "Acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("accepts an explicit owner/repo a TENANT key owns (installation match)", async () => {
    const res = await resolveRepoTarget(
      envWith({ OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "acme/widgets": 111 }) }),
      { explicitOwner: "acme", explicitRepo: "widgets", installationId: 111 },
    )
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("REJECTS an explicit repo the caller does not own (cross-tenant guard) and falls back", async () => {
    // A session user for `acme` tries to ground against `victim/secret` — must be
    // ignored, falling back to their OWN indexed repo instead.
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, {
      explicitOwner: "victim",
      explicitRepo: "secret",
      sessionLogin: "acme",
    })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("REJECTS an explicit repo with no identity at all (returns no target)", async () => {
    const res = await resolveRepoTarget(envWith({}), { explicitOwner: "victim", explicitRepo: "secret" })
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })

  it("falls back to a session caller's first indexed repo (owner = login)", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, { sessionLogin: "acme" })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("falls back to a tenant caller's indexed repo via the installation map", async () => {
    const env = envWith({
      OPENCLAW_STATE: fakeKv(["acme/widgets"]),
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ acme: 111 }),
    })
    const res = await resolveRepoTarget(env, { installationId: 111 })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("returns no target + hasIndexedRepo:false when the caller has no indexed repo", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv([]) })
    const res = await resolveRepoTarget(env, { sessionLogin: "acme" })
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })

  it("returns no target when there is no identity hint at all", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, {})
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })
})
