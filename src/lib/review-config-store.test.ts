// sig-dashboard-review-config: KV store round-trip, schema validation, and
// tenant-isolation coverage.

import { describe, it, expect } from "vitest"
import {
  writeDashboardReviewConfig,
  readDashboardReviewConfig,
  resolveDashboardConfigLayers,
  orgConfigKey,
  repoConfigKey,
  repoScopeId,
} from "@/src/lib/review-config-store"
import type { Env } from "@/src/shared/types/env"

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

function env(kv: KVNamespace): Pick<Env, "OPENCLAW_STATE"> {
  return { OPENCLAW_STATE: kv } as unknown as Pick<Env, "OPENCLAW_STATE">
}

describe("review-config-store", () => {
  it("round-trips a valid config (org scope)", async () => {
    const { kv } = makeKV()
    const e = env(kv)
    const raw = JSON.stringify({ guidance: "always enforce error handling", profile: "chill" })
    const write = await writeDashboardReviewConfig(e, 42, raw)
    expect(write.ok).toBe(true)

    const read = await readDashboardReviewConfig(e, 42)
    expect(read).not.toBeNull()
    expect(read?.guidance).toBe("always enforce error handling")
    expect(read?.profile).toBe("chill")
  })

  it("persists the CANONICAL known-fields-only serialization (drops unknown keys)", async () => {
    const { kv, store } = makeKV()
    const e = env(kv)
    const raw = JSON.stringify({ guidance: "x", bogusUnknownField: { a: 1 }, profile: "assertive" })
    await writeDashboardReviewConfig(e, 7, raw)
    const stored = store.get(orgConfigKey(7))!
    expect(stored).not.toContain("bogusUnknownField")
    expect(JSON.parse(stored)).toMatchObject({ guidance: "x", profile: "assertive" })
  })

  it("rejects malformed JSON with a reason and stores nothing", async () => {
    const { kv, store } = makeKV()
    const e = env(kv)
    const write = await writeDashboardReviewConfig(e, 1, "{ not valid json ")
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.reason).toMatch(/JSON parse failed/i)
    expect(store.size).toBe(0)
  })

  it("rejects a top-level array (structurally invalid config)", async () => {
    const { kv } = makeKV()
    const write = await writeDashboardReviewConfig(env(kv), 1, JSON.stringify(["nope"]))
    expect(write.ok).toBe(false)
  })

  it("round-trips a repo-scoped config under a distinct key from the org scope", async () => {
    const { kv, store } = makeKV()
    const e = env(kv)
    const repoId = repoScopeId("Acme", "Repo")
    await writeDashboardReviewConfig(e, 9, JSON.stringify({ guidance: "org-level" }))
    await writeDashboardReviewConfig(e, 9, JSON.stringify({ guidance: "repo-level" }), repoId)

    expect(store.has(orgConfigKey(9))).toBe(true)
    expect(store.has(repoConfigKey(9, repoId))).toBe(true)
    expect((await readDashboardReviewConfig(e, 9))?.guidance).toBe("org-level")
    expect((await readDashboardReviewConfig(e, 9, repoId))?.guidance).toBe("repo-level")
    // repoScopeId lowercases owner/repo.
    expect(repoId).toBe("acme/repo")
  })

  it("returns null for an absent config (fail-soft → built-in defaults)", async () => {
    const { kv } = makeKV()
    expect(await readDashboardReviewConfig(env(kv), 404)).toBeNull()
  })

  it("TENANT ISOLATION: one installation's write never leaks into another's read", async () => {
    const { kv } = makeKV()
    const e = env(kv)
    await writeDashboardReviewConfig(e, 100, JSON.stringify({ guidance: "tenant-100-secret" }))
    // A different installation reads its own (empty) scope — never tenant 100's.
    expect(await readDashboardReviewConfig(e, 200)).toBeNull()
    expect((await readDashboardReviewConfig(e, 100))?.guidance).toBe("tenant-100-secret")
  })

  it("resolveDashboardConfigLayers returns empty layers when installationId is absent/invalid", async () => {
    const { kv } = makeKV()
    const e = env(kv)
    expect(await resolveDashboardConfigLayers(e, undefined, "o", "r")).toEqual({ org: null, repo: null })
    expect(await resolveDashboardConfigLayers(e, 0, "o", "r")).toEqual({ org: null, repo: null })
    expect(await resolveDashboardConfigLayers(e, -1, "o", "r")).toEqual({ org: null, repo: null })
  })

  it("resolveDashboardConfigLayers reads both org + repo layers for a PR", async () => {
    const { kv } = makeKV()
    const e = env(kv)
    await writeDashboardReviewConfig(e, 55, JSON.stringify({ guidance: "org" }))
    await writeDashboardReviewConfig(e, 55, JSON.stringify({ guidance: "repo" }), repoScopeId("o", "r"))
    const layers = await resolveDashboardConfigLayers(e, 55, "O", "R")
    expect(layers.org?.guidance).toBe("org")
    expect(layers.repo?.guidance).toBe("repo")
  })
})
