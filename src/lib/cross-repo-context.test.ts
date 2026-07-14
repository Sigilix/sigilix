// Cross-repo automatic-context resolver — the tenant-isolation seam. D1 is
// the exact-installation authority; owner-scoped KV manifests only prove that
// a retrieval namespace exists. Every automatic sibling must pass both.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockListInstallationRepos } = vi.hoisted(() => ({
  mockListInstallationRepos: vi.fn(),
}))

vi.mock("@/src/features/tenancy", () => ({
  listRepoFullNamesForInstallation: (...args: unknown[]) => mockListInstallationRepos(...args),
}))

import {
  crossRepoContextEnabled,
  MAX_CROSS_REPO_SIBLINGS,
  resolveCrossRepoNamespaces,
} from "@/src/lib/cross-repo-context"

interface StateStub {
  list: ReturnType<typeof vi.fn>
}

/** KV stub whose `.list()` returns mixed owner-scoped manifest keys. */
function makeState(namespaces: string[]): StateStub {
  const list = vi.fn(async () => ({
    keys: namespaces.map((namespace) => ({ name: `repo-index-manifest:${namespace}` })),
    list_complete: true,
  }))
  return { list }
}

function enabledEnv(state: StateStub) {
  return {
    SIGILIX_PLATFORM_DB: {} as D1Database,
    OPENCLAW_STATE: state as unknown as KVNamespace,
    OPENCLAW_CROSS_REPO_CONTEXT: "on",
  }
}

function allowInstallationRepos(...fullNames: string[]): void {
  mockListInstallationRepos.mockResolvedValue(fullNames)
}

beforeEach(() => {
  mockListInstallationRepos.mockReset()
  allowInstallationRepos()
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe("resolveCrossRepoNamespaces — exact-installation isolation", () => {
  it("returns [] when the flag is OFF and never touches either store", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets"])
    const out = await resolveCrossRepoNamespaces(
      {
        SIGILIX_PLATFORM_DB: {} as D1Database,
        OPENCLAW_STATE: state as unknown as KVNamespace,
      },
      42,
      "acme",
      "widgets",
    )
    expect(out).toEqual([])
    expect(state.list).not.toHaveBeenCalled()
    expect(mockListInstallationRepos).not.toHaveBeenCalled()
  })

  it("returns [] when either authority store is unbound", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets"])
    await expect(
      resolveCrossRepoNamespaces(
        { SIGILIX_PLATFORM_DB: {} as D1Database, OPENCLAW_CROSS_REPO_CONTEXT: "on" },
        42,
        "acme",
        "widgets",
      ),
    ).resolves.toEqual([])
    await expect(
      resolveCrossRepoNamespaces(
        {
          OPENCLAW_STATE: state as unknown as KVNamespace,
          OPENCLAW_CROSS_REPO_CONTEXT: "on",
        },
        42,
        "acme",
        "widgets",
      ),
    ).resolves.toEqual([])
    expect(state.list).not.toHaveBeenCalled()
    expect(mockListInstallationRepos).not.toHaveBeenCalled()
  })

  it("rejects invalid installation ids before touching either store", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets"])
    for (const installationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(resolveCrossRepoNamespaces(enabledEnv(state), installationId, "acme", "widgets")).resolves.toEqual(
        [],
      )
    }
    expect(state.list).not.toHaveBeenCalled()
    expect(mockListInstallationRepos).not.toHaveBeenCalled()
  })

  it("returns exact-installation siblings and excludes the reviewed repo", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets", "acme/tooling"])
    allowInstallationRepos("Acme/Widgets", "acme/gadgets", "ACME/tooling")

    const out = await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")

    expect(out).toEqual(["acme/gadgets", "acme/tooling"])
    expect(out).not.toContain("acme/widgets")
  })

  it("excludes a same-owner manifest assigned to another installation", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets", "acme/private"])
    allowInstallationRepos("acme/widgets", "acme/gadgets")

    const out = await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")

    expect(out).toEqual(["acme/gadgets"])
    expect(out).not.toContain("acme/private")
  })

  it("fails automatic expansion closed when the base repo is not in the installation", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets"])
    allowInstallationRepos("acme/gadgets")

    expect(await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")).toEqual([])
  })

  it("keeps the owner guard as a second line of defense", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets", "evilcorp/secrets", "other/private"])
    allowInstallationRepos("acme/widgets", "acme/gadgets", "evilcorp/secrets")

    const out = await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")

    expect(out).toEqual(["acme/gadgets"])
    expect(out).not.toContain("evilcorp/secrets")
  })

  it("sorts then caps only the exact-installation intersection", async () => {
    const many = Array.from(
      { length: MAX_CROSS_REPO_SIBLINGS + 5 },
      (_, index) => `acme/repo${String(index).padStart(2, "0")}`,
    )
    const state = makeState(["acme/widgets", "acme/not-authorized", ...many])
    allowInstallationRepos("acme/widgets", ...many)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")

    expect(out).toEqual(many.slice(0, MAX_CROSS_REPO_SIBLINGS))
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      event: "review-cross-repo-automatic-scope",
      candidates: many.length + 1,
      eligible: many.length,
      dropped: 1,
      capped: 5,
    })
  })

  it("soft-fails to [] when the KV manifest list fails", async () => {
    const state = {
      list: vi.fn(async () => {
        throw new Error("kv down")
      }),
    }
    allowInstallationRepos("acme/widgets", "acme/gadgets")

    expect(await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")).toEqual([])
  })

  it("logs only aggregate counts for the automatic installation filter", async () => {
    const state = makeState(["acme/widgets", "acme/gadgets", "acme/tooling", "acme/private"])
    allowInstallationRepos("acme/widgets", "acme/gadgets", "acme/tooling")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await resolveCrossRepoNamespaces(enabledEnv(state), 42, "acme", "widgets")

    const event = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>
    expect(event).toEqual({
      event: "review-cross-repo-automatic-scope",
      candidates: 3,
      eligible: 2,
      dropped: 1,
      capped: 0,
    })
    expect(event).not.toHaveProperty("owner")
    expect(event).not.toHaveProperty("repo")
    expect(event).not.toHaveProperty("installationId")
  })
})
