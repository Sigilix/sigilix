import { describe, expect, it } from "vitest"
import {
  listIndexedRepos,
  listTeamRepoMappings,
  parseTeamGithubRepo,
  resolveInstallation,
} from "@/src/shared/adapters/github/github-installation"

describe("resolveInstallation", () => {
  it("prefers exact owner/repo over owner-only fallback", () => {
    const map = JSON.stringify({
      "Arc-and-Anchor/rema-portal": "12345",
      "Arc-and-Anchor": "9999",
    })
    expect(resolveInstallation("Arc-and-Anchor", "rema-portal", map)).toEqual({
      ok: true,
      installationId: 12345,
    })
  })

  it("falls back to owner-only when no exact match", () => {
    const map = JSON.stringify({ "Arc-and-Anchor": "9999" })
    expect(resolveInstallation("Arc-and-Anchor", "other-repo", map)).toEqual({
      ok: true,
      installationId: 9999,
    })
  })

  it("returns no_installation on bad JSON (soft-fail)", () => {
    expect(resolveInstallation("o", "r", "{not json")).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("returns no_installation on empty/missing env", () => {
    expect(resolveInstallation("o", "r", undefined)).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", "")).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("accepts numeric IDs", () => {
    const map = JSON.stringify({ "o/r": 555 })
    expect(resolveInstallation("o", "r", map)).toEqual({ ok: true, installationId: 555 })
  })

  it("rejects non-numeric / zero IDs", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "abc" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "0" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects digit-prefixed strings like '123abc' (parseInt would silently truncate)", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "123abc" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects fractional numbers like 1.5 (would route auth to wrong installation)", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": 1.5 }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects negative / Infinity / NaN numbers", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": -1 }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    // Note: JSON.stringify(NaN) and JSON.stringify(Infinity) both produce "null",
    // so we test those by hand-crafting the JSON.
    expect(resolveInstallation("o", "r", '{"o/r": null}')).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })

  it("rejects whitespace-padded numeric strings", () => {
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": " 123" }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
    expect(resolveInstallation("o", "r", JSON.stringify({ "o/r": "123 " }))).toEqual({
      ok: false,
      reason: "no_installation",
    })
  })
})

describe("listTeamRepoMappings", () => {
  it("emits one entry per team", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      RFD: { owner: "Arc-and-Anchor", repo: "rubberfit-desktop" },
    })
    expect(listTeamRepoMappings(json)).toEqual([
      { teamKey: "ARC", owner: "Arc-and-Anchor", repo: "rema-portal" },
      { teamKey: "RFD", owner: "Arc-and-Anchor", repo: "rubberfit-desktop" },
    ])
  })

  it("returns empty for missing/empty env", () => {
    expect(listTeamRepoMappings(undefined)).toEqual([])
    expect(listTeamRepoMappings("")).toEqual([])
  })

  it("returns empty for malformed JSON", () => {
    expect(listTeamRepoMappings("{not json")).toEqual([])
  })

  it("skips entries that don't have both owner and repo", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      BAD: { owner: "only-owner" },
    })
    expect(listTeamRepoMappings(json)).toEqual([
      { teamKey: "ARC", owner: "Arc-and-Anchor", repo: "rema-portal" },
    ])
  })
})

describe("parseTeamGithubRepo", () => {
  it("returns the mapping for the requested team", () => {
    const json = JSON.stringify({
      ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
    })
    expect(parseTeamGithubRepo(json, "ARC")).toEqual({
      owner: "Arc-and-Anchor",
      repo: "rema-portal",
    })
  })

  it("returns null when team not present", () => {
    const json = JSON.stringify({ ARC: { owner: "x", repo: "y" } })
    expect(parseTeamGithubRepo(json, "OTHER")).toBeNull()
  })

  it("returns null when teamKey is null", () => {
    const json = JSON.stringify({ ARC: { owner: "x", repo: "y" } })
    expect(parseTeamGithubRepo(json, null)).toBeNull()
  })

  it("returns null on missing/empty/malformed env", () => {
    expect(parseTeamGithubRepo(undefined, "ARC")).toBeNull()
    expect(parseTeamGithubRepo("", "ARC")).toBeNull()
    expect(parseTeamGithubRepo("{not json", "ARC")).toBeNull()
  })
})

describe("listIndexedRepos — KV-backed (ARC-239)", () => {
  // The function now lists `repo-index-manifest:*` keys from KV
  // rather than reading the deleted `OPENCLAW_INDEXED_REPOS` env var.
  // KV is the live source of truth (ARC-235 writes; ARC-238 deletes).
  type Page = { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
  function makeKvStub(keys: string[]): { OPENCLAW_STATE: KVNamespace } {
    return {
      OPENCLAW_STATE: {
        list: async (opts: { prefix?: string; cursor?: string }): Promise<Page> => {
          const prefix = opts.prefix ?? ""
          const filtered = keys.filter((k) => k.startsWith(prefix))
          return { keys: filtered.map((name) => ({ name })), list_complete: true }
        },
      } as unknown as KVNamespace,
    }
  }

  it("returns namespaces derived from `repo-index-manifest:*` keys (SIG-132 <owner>/<repo>)", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/rubberfit",
      "repo-index-manifest:arc-and-anchor/arc-and-anchor-website",
      "repo-index-manifest:acme/openclaw-worker",
    ])
    const result = await listIndexedRepos(env)
    expect(result.sort()).toEqual([
      "acme/openclaw-worker",
      "arc-and-anchor/arc-and-anchor-website",
      "arc-and-anchor/rubberfit",
    ])
  })

  it("filters namespaces to the requested owner case-insensitively (SIG-134)", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/rubberfit",
      "repo-index-manifest:arc-and-anchor/sigilix",
      "repo-index-manifest:acme/api",
      "repo-index-manifest:other/sigilix",
    ])
    const result = await listIndexedRepos(env, { owner: "Arc-and-Anchor" })
    expect(result.sort()).toEqual([
      "arc-and-anchor/rubberfit",
      "arc-and-anchor/sigilix",
    ])
  })

  it("EXCLUDES an orphaned pre-SIG-132 bare-repo key (no owner = bare namespace)", async () => {
    // Old-shape keys (no slash) remain in KV until uninstall purges them.
    // SIG-132 (CodeRabbit Major): they must NOT surface in availableRepos —
    // advertising a bare namespace would let tool resolution fall back to a
    // collision-prone, cross-tenant-unsafe namespace. Only owner-qualified
    // (`<owner>/<repo>`) namespaces are surfaced.
    const env = makeKvStub([
      "repo-index-manifest:rubberfit", // legacy bare orphan → excluded
      "repo-index-manifest:arc-and-anchor/rubberfit", // new shape → kept
    ])
    expect(await listIndexedRepos(env)).toEqual(["arc-and-anchor/rubberfit"])
  })

  it("dedupes if the same key is somehow listed twice (defensive)", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/rubberfit",
      "repo-index-manifest:arc-and-anchor/rubberfit",
    ])
    expect(await listIndexedRepos(env)).toEqual(["arc-and-anchor/rubberfit"])
  })

  it("ignores empty + bare (owner-less) segments after the prefix", async () => {
    const env = makeKvStub([
      "repo-index-manifest:",
      "repo-index-manifest:rubberfit", // bare → excluded
      "repo-index-manifest:arc-and-anchor/rubberfit",
    ])
    expect(await listIndexedRepos(env)).toEqual(["arc-and-anchor/rubberfit"])
  })

  it("ignores branch-scoped manifest keys so Linear sees repos, not branches (SIG-35)", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/sigilix",
      "repo-index-manifest:arc-and-anchor/sigilix/__branch__/h646576",
      "repo-index-manifest:arc-and-anchor/sigilix/__branch__/h666561747572652f5349472d3335",
    ])
    expect(await listIndexedRepos(env, { owner: "Arc-and-Anchor" })).toEqual([
      "arc-and-anchor/sigilix",
    ])
  })

  it("can include branch-scoped namespaces for agent tools when explicitly requested (SIG-35)", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/sigilix",
      "repo-index-manifest:arc-and-anchor/sigilix/__branch__/h646576",
      "repo-index-manifest:acme/sigilix/__branch__/h646576",
    ])
    expect(await listIndexedRepos(env, {
      owner: "Arc-and-Anchor",
      includeBranches: true,
    })).toEqual([
      "arc-and-anchor/sigilix",
      "arc-and-anchor/sigilix/__branch__/h646576",
    ])
  })

  it("ignores keys outside the `repo-index-manifest:` prefix", async () => {
    const env = makeKvStub([
      "repo-index-manifest:arc-and-anchor/rubberfit",
      "pr-review-manifest:Arc-and-Anchor/sigilix#10",
      "pr-review:Arc-and-Anchor/rubberfit#5@abc",
    ])
    expect(await listIndexedRepos(env)).toEqual(["arc-and-anchor/rubberfit"])
  })

  it("returns empty array when KV is empty (fresh deploy, no installs yet)", async () => {
    const env = makeKvStub([])
    expect(await listIndexedRepos(env)).toEqual([])
  })

  it("paginates correctly across list_complete=false pages", async () => {
    const allKeys = Array.from({ length: 1500 }, (_, i) =>
      `repo-index-manifest:acme/repo-${String(i).padStart(4, "0")}`,
    )
    // Stub list that paginates 1000 at a time via cursor.
    const env = {
      OPENCLAW_STATE: {
        list: async (opts: { prefix?: string; cursor?: string }): Promise<Page> => {
          const prefix = opts.prefix ?? ""
          const all = allKeys.filter((k) => k.startsWith(prefix)).sort()
          const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
          const page = all.slice(start, start + 1000)
          const nextStart = start + page.length
          const list_complete = nextStart >= all.length
          const out: Page = {
            keys: page.map((name) => ({ name })),
            list_complete,
          }
          if (!list_complete) out.cursor = String(nextStart)
          return out
        },
      } as unknown as KVNamespace,
    }
    const result = await listIndexedRepos(env)
    expect(result.length).toBe(1500)
    expect(result[0]).toBe("acme/repo-0000")
    expect(result[1499]).toBe("acme/repo-1499")
  })
})
