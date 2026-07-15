// Linear-backed cross-repo resolvers — the shared seam every surface reuses to
// fan retrieval across a team's EXPLICITLY configured repo set. Proves the
// configured set is honored WITHOUT the OPENCLAW_CROSS_REPO_CONTEXT auto-
// discovery flag, that the review resolver UNIONS configured + auto-discovery,
// and that a repo bound to no team falls back to auto-discovery only.

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { connectLinearOrganization, updateLinearConfig } from "@/src/features/linear-integration"
import {
  resolveBindingRepoScope,
  resolveConfiguredCrossRepoNamespaces,
  resolveLinearTeamRepoScope,
  resolveReviewCrossRepoNamespaces,
} from "@/src/lib/cross-repo-context"
import { resolveLinearTeamBinding } from "@/src/features/linear-integration"

const BASE_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const LINEAR_SQL = readFileSync(new URL("../../migrations/0016_create_linear_integration.sql", import.meta.url), "utf8")
const TEAM_REPO_SQL = readFileSync(
  new URL("../../migrations/0018_create_linear_team_repo.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-10T00:00:00.000Z"

/** KV stub whose `.list()` returns `repo-index-manifest:<ns>` keys (mixed owners). */
function makeState(namespaces: string[]): KVNamespace {
  return {
    list: vi.fn(async () => ({
      keys: namespaces.map((ns) => ({ name: `repo-index-manifest:${ns}` })),
      list_complete: true,
    })),
  } as unknown as KVNamespace
}

/** Seed installation 42 with three repos and a team bound to `boundRepoIds`. */
async function seed(boundRepoIds: number[], useAllRepos = false): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(LINEAR_SQL)
  await db.exec(TEAM_REPO_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  for (const [id, name] of [
    [101, "acme/api"],
    [102, "acme/web"],
    [103, "acme/infra"],
  ] as const) {
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, 42, ?, ?)")
      .bind(id, name, NOW)
      .run()
  }
  await connectLinearOrganization(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      organizationId: "org-a",
      organizationName: "Acme",
      appUserId: "app-a",
      source: "oauth",
      grantedScopes: ["read", "write"],
      canAccessAllPublicTeams: false,
      installedByUserId: "u",
      installedByLogin: "admin",
      teams: [{ id: "team-a", key: "TEAM-A", name: "Team A", githubRepoId: 101, githubRepoFullName: "acme/api" }],
      nowIso: NOW,
    },
  )
  const repos = boundRepoIds.map((id) => ({
    githubRepoId: id,
    githubRepoFullName: id === 101 ? "acme/api" : id === 102 ? "acme/web" : "acme/infra",
  }))
  const result = await updateLinearConfig(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      input: {
        revision: 1,
        contextMode: "auto",
        scope: { mode: "auto", teamIds: [] },
        prValidation: false,
        createIssue: "manual",
        planning: true,
        writeback: { comments: true, status: false, labels: true },
      },
      bindings: [{ teamId: "team-a", repos: useAllRepos ? [] : repos, useAllRepos }],
      updatedBy: "admin",
      nowIso: NOW,
    },
  )
  expect(result.ok).toBe(true)
  return db
}

describe("resolveConfiguredCrossRepoNamespaces", () => {
  it("returns the team's configured siblings (excluding the PR repo) — NOT gated by the auto flag", async () => {
    const db = await seed([101, 102])
    // Flag intentionally absent: explicit config is the admin's opt-in.
    const out = await resolveConfiguredCrossRepoNamespaces({ SIGILIX_PLATFORM_DB: db }, 42, "acme", "api")
    expect(out).toEqual(["acme/web"])
  })

  it("returns [] for a repo bound to no team", async () => {
    const db = await seed([101, 102]) // team bound to api+web, NOT infra
    expect(await resolveConfiguredCrossRepoNamespaces({ SIGILIX_PLATFORM_DB: db }, 42, "acme", "infra")).toEqual([])
  })

  it("resolves configured siblings when the reviewed PR is in the secondary repo", async () => {
    const db = await seed([101, 102])

    expect(await resolveConfiguredCrossRepoNamespaces({ SIGILIX_PLATFORM_DB: db }, 42, "acme", "web")).toEqual([
      "acme/api",
    ])
  })

  it("expands an all-repositories binding from any installation member", async () => {
    const db = await seed([], true)

    expect(await resolveConfiguredCrossRepoNamespaces({ SIGILIX_PLATFORM_DB: db }, 42, "acme", "infra")).toEqual([
      "acme/api",
      "acme/web",
    ])
  })

  it("returns [] when D1 is unbound", async () => {
    expect(await resolveConfiguredCrossRepoNamespaces({}, 42, "acme", "api")).toEqual([])
  })
})

describe("resolveReviewCrossRepoNamespaces", () => {
  it("UNIONS the configured set with the flag-gated auto-discovery siblings (configured first)", async () => {
    const db = await seed([101, 102])
    const env = {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: makeState(["acme/api", "acme/infra", "globex/other"]),
      OPENCLAW_CROSS_REPO_CONTEXT: "on",
    }
    const out = await resolveReviewCrossRepoNamespaces(env, 42, "acme", "api")
    // configured (acme/web) FIRST, then auto-discovery (acme/infra); base + other-owner excluded.
    expect(out).toEqual(["acme/web", "acme/infra"])
  })

  it("still honors the configured set when the auto-discovery flag is OFF", async () => {
    const db = await seed([101, 102])
    const env = {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: makeState(["acme/api", "acme/infra"]),
      // flag OFF ⇒ auto-discovery contributes nothing
    }
    expect(await resolveReviewCrossRepoNamespaces(env, 42, "acme", "api")).toEqual(["acme/web"])
  })

  it("falls back to auto-discovery only when the PR repo is in no team binding", async () => {
    const db = await seed([101, 102]) // team NOT bound to infra
    const env = {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: makeState(["acme/infra", "acme/api"]),
      OPENCLAW_CROSS_REPO_CONTEXT: "on",
    }
    // configured=[] (infra unbound) → only auto-discovery siblings (acme/api, base excluded)
    expect(await resolveReviewCrossRepoNamespaces(env, 42, "acme", "infra")).toEqual(["acme/api"])
  })

  it("never includes a same-owner manifest registered to another installation", async () => {
    const db = await seed([101, 102])
    await db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (99, 'acme', 'Organization', ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (991, 99, ?, ?)")
      .bind("acme/private", NOW)
      .run()

    const out = await resolveReviewCrossRepoNamespaces(
      {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_STATE: makeState(["acme/api", "acme/web", "acme/private"]),
        OPENCLAW_CROSS_REPO_CONTEXT: "on",
      },
      42,
      "acme",
      "api",
    )

    expect(out).toEqual(["acme/web"])
    expect(out).not.toContain("acme/private")
  })

  it("keeps exact configured siblings when the automatic installation lookup fails", async () => {
    const db = await seed([101, 102])
    const autoReadBrokenDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver) as unknown
        return (query: string) => {
          if (query.startsWith("SELECT full_name FROM repo WHERE installation_id")) {
            throw new Error("automatic installation lookup unavailable")
          }
          return target.prepare(query)
        }
      },
    })

    const out = await resolveReviewCrossRepoNamespaces(
      {
        SIGILIX_PLATFORM_DB: autoReadBrokenDb,
        OPENCLAW_STATE: makeState(["acme/api", "acme/web", "acme/infra"]),
        OPENCLAW_CROSS_REPO_CONTEXT: "on",
      },
      42,
      "acme",
      "api",
    )

    expect(out).toEqual(["acme/web"])
  })

  it("rejects an unsafe installation id before either resolution path touches storage", async () => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be touched for an unsafe installation id")
    })
    const list = vi.fn(async () => ({
      keys: [{ name: "repo-index-manifest:acme/private" }],
      list_complete: true,
    }))

    expect(
      await resolveReviewCrossRepoNamespaces(
        {
          SIGILIX_PLATFORM_DB: { prepare } as unknown as D1Database,
          OPENCLAW_STATE: { list } as unknown as KVNamespace,
          OPENCLAW_CROSS_REPO_CONTEXT: "on",
        },
        Number.MAX_SAFE_INTEGER + 1,
        "acme",
        "api",
      ),
    ).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
})

describe("resolveLinearTeamRepoScope (Slack widen)", () => {
  it("returns the team's effective {owner,repo} set for an explicit multi-repo binding", async () => {
    const db = await seed([101, 102])
    const out = await resolveLinearTeamRepoScope({ SIGILIX_PLATFORM_DB: db }, 42, "team-a")
    expect(out).toEqual([
      { owner: "acme", repo: "api" },
      { owner: "acme", repo: "web" },
    ])
  })

  it("expands use-all to every installation repo", async () => {
    const db = await seed([], true)
    const out = await resolveLinearTeamRepoScope({ SIGILIX_PLATFORM_DB: db }, 42, "team-a")
    expect(out.map((r) => r.repo).sort()).toEqual(["api", "infra", "web"])
  })

  it("returns [] with no D1 binding", async () => {
    expect(await resolveLinearTeamRepoScope({}, 42, "team-a")).toEqual([])
  })
})

describe("resolveBindingRepoScope", () => {
  it("splits a binding into primary (original case) + capped lowercased siblings", async () => {
    const db = await seed([101, 102])
    const binding = await resolveLinearTeamBinding({ SIGILIX_PLATFORM_DB: db }, "org-a", "team-a")
    const scope = await resolveBindingRepoScope({ SIGILIX_PLATFORM_DB: db }, binding!, 42)
    expect(scope).not.toBeNull()
    expect(scope!.primary).toEqual({ owner: "acme", repo: "api" })
    expect(scope!.primaryNamespace).toBe("acme/api")
    expect(scope!.siblingNamespaces).toEqual(["acme/web"])
    expect(scope!.allNamespaces).toEqual(["acme/api", "acme/web"])
    expect(scope!.effectiveRepositories).toEqual([
      { repositoryId: 101, fullName: "acme/api" },
      { repositoryId: 102, fullName: "acme/web" },
    ])
    expect(scope!.truncated).toBe(0)
  })

  it("retains every exact installation repository for a use-all binding", async () => {
    const db = await seed([], true)
    const binding = await resolveLinearTeamBinding({ SIGILIX_PLATFORM_DB: db }, "org-a", "team-a")
    const scope = await resolveBindingRepoScope({ SIGILIX_PLATFORM_DB: db }, binding!, 42)

    expect(scope!.effectiveRepositories).toEqual([
      { repositoryId: 101, fullName: "acme/api" },
      { repositoryId: 103, fullName: "acme/infra" },
      { repositoryId: 102, fullName: "acme/web" },
    ])
  })

  it("returns null on an installation mismatch (fail closed)", async () => {
    const db = await seed([101])
    const binding = await resolveLinearTeamBinding({ SIGILIX_PLATFORM_DB: db }, "org-a", "team-a")
    expect(await resolveBindingRepoScope({ SIGILIX_PLATFORM_DB: db }, binding!, 999)).toBeNull()
  })
})
