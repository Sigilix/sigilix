// Cross-repo context resolver — the tenant-isolation seam. These tests exist
// to PROVE the sibling list can only ever contain same-installation repos: the
// resolver reads the owner-scoped indexed-repo manifest set and NEVER anything
// else. Isolation is the whole point of the feature, so it is tested first.

import { describe, it, expect, vi } from "vitest"
import {
  crossRepoContextEnabled,
  resolveCrossRepoNamespaces,
  MAX_CROSS_REPO_SIBLINGS,
} from "@/src/lib/cross-repo-context"

/** A KV stub whose `.list()` returns `repo-index-manifest:<ns>` keys for the
 *  given namespaces (mixed owners on purpose — the resolver must filter). */
function makeState(namespaces: string[]): { list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => ({
    keys: namespaces.map((ns) => ({ name: `repo-index-manifest:${ns}` })),
    list_complete: true,
  }))
  return { list }
}

describe("crossRepoContextEnabled", () => {
  it("defaults OFF for unset / non-'on' values", () => {
    expect(crossRepoContextEnabled({})).toBe(false)
    expect(crossRepoContextEnabled({ OPENCLAW_CROSS_REPO_CONTEXT: "" })).toBe(false)
    expect(crossRepoContextEnabled({ OPENCLAW_CROSS_REPO_CONTEXT: "off" })).toBe(false)
    expect(crossRepoContextEnabled({ OPENCLAW_CROSS_REPO_CONTEXT: "true" })).toBe(false)
  })

  it("is ON only for 'on' (case/space-insensitive)", () => {
    expect(crossRepoContextEnabled({ OPENCLAW_CROSS_REPO_CONTEXT: "on" })).toBe(true)
    expect(crossRepoContextEnabled({ OPENCLAW_CROSS_REPO_CONTEXT: "  ON " })).toBe(true)
  })
})

describe("resolveCrossRepoNamespaces — isolation", () => {
  it("returns [] when the flag is OFF and never touches KV", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets"])
    const out = await resolveCrossRepoNamespaces({ OPENCLAW_STATE: state as unknown as KVNamespace }, "acme", "widgets")
    expect(out).toEqual([])
    expect(state.list).not.toHaveBeenCalled()
  })

  it("returns [] when KV is unbound", async () => {
    const out = await resolveCrossRepoNamespaces({ OPENCLAW_CROSS_REPO_CONTEXT: "on" }, "acme", "widgets")
    expect(out).toEqual([])
  })

  it("returns same-owner siblings, excluding the PR repo's own namespace", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets", "acme/tooling"])
    const out = await resolveCrossRepoNamespaces(
      { OPENCLAW_STATE: state as unknown as KVNamespace, OPENCLAW_CROSS_REPO_CONTEXT: "on" },
      "acme",
      "widgets",
    )
    expect(out).toEqual(["acme/gadgets", "acme/tooling"])
    expect(out).not.toContain("acme/widgets")
  })

  it("NEVER crosses the tenant boundary — other owners are filtered out", async () => {
    // KV happens to hold manifests for a DIFFERENT owner too (e.g. a shared
    // state store). The owner filter in listIndexedRepos drops them, and the
    // resolver's own startsWith guard is a second line of defense.
    const state = makeState(["acme/widgets", "acme/gadgets", "evilcorp/secrets", "other/private"])
    const out = await resolveCrossRepoNamespaces(
      { OPENCLAW_STATE: state as unknown as KVNamespace, OPENCLAW_CROSS_REPO_CONTEXT: "on" },
      "acme",
      "widgets",
    )
    expect(out).toEqual(["acme/gadgets"])
    for (const ns of out) expect(ns.startsWith("acme/")).toBe(true)
    expect(out).not.toContain("evilcorp/secrets")
    expect(out).not.toContain("other/private")
  })

  it("caps the sibling fan-out at MAX_CROSS_REPO_SIBLINGS", async () => {
    const many = Array.from({ length: MAX_CROSS_REPO_SIBLINGS + 5 }, (_, i) => `acme/repo${String(i).padStart(2, "0")}`)
    const state = makeState(["acme/widgets", ...many])
    const out = await resolveCrossRepoNamespaces(
      { OPENCLAW_STATE: state as unknown as KVNamespace, OPENCLAW_CROSS_REPO_CONTEXT: "on" },
      "acme",
      "widgets",
    )
    expect(out).toHaveLength(MAX_CROSS_REPO_SIBLINGS)
  })

  it("soft-fails to [] when the KV list throws", async () => {
    const state = {
      list: vi.fn(async () => {
        throw new Error("kv down")
      }),
    }
    const out = await resolveCrossRepoNamespaces(
      { OPENCLAW_STATE: state as unknown as KVNamespace, OPENCLAW_CROSS_REPO_CONTEXT: "on" },
      "acme",
      "widgets",
    )
    expect(out).toEqual([])
  })
})
