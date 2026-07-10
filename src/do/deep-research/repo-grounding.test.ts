import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { isCodebaseQuestion, resolveRepoTarget } from "./repo-grounding"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_0001 = readFileSync(
  new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

// A minimal KV fake exposing the manifest scan + per-installation default reads.
function fakeKv(manifestNamespaces: string[], values: Record<string, string> = {}): KVNamespace {
  const keys = manifestNamespaces.map((ns) => ({ name: `repo-index-manifest:${ns}` }))
  const store = new Map(Object.entries(values))
  return {
    get: async (key: string) => store.get(key) ?? null,
    list: async (opts?: { prefix?: string }) => ({
      keys: keys.filter((key) => !opts?.prefix || key.name.startsWith(opts.prefix)),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace
}

async function repoDb(rows: Array<{ repoId: number; installationId: number; fullName: string }>): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_0001)
  for (const installationId of new Set(rows.map((row) => row.installationId))) {
    await db
      .prepare("INSERT INTO tenant (installation_id, created_at, updated_at) VALUES (?, 't', 't')")
      .bind(installationId)
      .run()
  }
  for (const row of rows) {
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, 't')")
      .bind(row.repoId, row.installationId, row.fullName)
      .run()
  }
  return db
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

  it("matches a narrow descriptive implementation-location question without an ownership phrase", () => {
    expect(
      isCodebaseQuestion("Where does the per-tier rate-limit cap get computed, and what are the multipliers?"),
    ).toBe(true)
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
      "Where does GDP get computed?",
      "How are tax multipliers computed?",
      "Where does OpenAI document its external rate limits?",
      "Where does OpenAI compute its external API rate-limit cap?",
      "Where does the rate limit get computed in the GitHub API?",
      "Where is the auth handler implemented in the Express framework?",
      "",
    ]) {
      expect(isCodebaseQuestion(q)).toBe(false)
    }
  })
})

describe("resolveRepoTarget", () => {
  it("accepts an explicit owner/repo in a SESSION caller's exact live scope", async () => {
    const res = await resolveRepoTarget(envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) }), {
      explicitOwner: "Acme",
      explicitRepo: "widgets",
      sessionRepos: [{ installationId: 111, owner: "Acme", repo: "widgets" }],
    })
    expect(res).toEqual({ target: { owner: "Acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("accepts an explicit owner/repo a TENANT key owns (installation match)", async () => {
    const db = await repoDb([{ repoId: 1, installationId: 111, fullName: "acme/widgets" }])
    const res = await resolveRepoTarget(
      envWith({ SIGILIX_PLATFORM_DB: db, OPENCLAW_STATE: fakeKv(["acme/widgets"]) }),
      {
        explicitOwner: "acme",
        explicitRepo: "widgets",
        installationId: 111,
      },
    )
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("REJECTS an explicit repo the caller does not own (cross-tenant guard) and falls back", async () => {
    // A session user scoped to `acme/widgets` tries `victim/secret` — ignore it
    // and fall back only to their exact authorized indexed repo.
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, {
      explicitOwner: "victim",
      explicitRepo: "secret",
      sessionRepos: [{ installationId: 111, owner: "acme", repo: "widgets" }],
    })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("REJECTS an explicit repo with no identity at all (returns no target)", async () => {
    const res = await resolveRepoTarget(envWith({}), { explicitOwner: "victim", explicitRepo: "secret" })
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })

  it("falls back to a session caller's only indexed repo in its exact live scope", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, {
      sessionRepos: [{ installationId: 111, owner: "acme", repo: "widgets" }],
    })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("falls back to a tenant caller's only indexed repo via D1", async () => {
    const db = await repoDb([{ repoId: 1, installationId: 111, fullName: "acme/widgets" }])
    const env = envWith({
      OPENCLAW_STATE: fakeKv(["acme/widgets"]),
      SIGILIX_PLATFORM_DB: db,
    })
    const res = await resolveRepoTarget(env, { installationId: 111 })
    expect(res).toEqual({ target: { owner: "acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("uses an explicit per-installation default within a SESSION caller's exact repo scope", async () => {
    const env = envWith({
      OPENCLAW_STATE: fakeKv(["sigilix/.github", "sigilix/sigilix"], {
        "deep-research-default-repo:134811639": "Sigilix/sigilix",
      }),
    })
    const res = await resolveRepoTarget(env, {
      sessionRepos: [
        { installationId: 134811639, owner: "Sigilix", repo: ".github" },
        { installationId: 134811639, owner: "Sigilix", repo: "sigilix" },
      ],
    })
    expect(res).toEqual({ target: { owner: "Sigilix", repo: "sigilix" }, hasIndexedRepo: true })
  })

  it("does not guess when a session has multiple indexed repos and no configured default", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/api", "acme/web"]) })
    const res = await resolveRepoTarget(env, {
      sessionRepos: [
        { installationId: 111, owner: "acme", repo: "api" },
        { installationId: 111, owner: "acme", repo: "web" },
      ],
    })
    expect(res).toEqual({ target: null, hasIndexedRepo: true })
  })

  it("rejects an explicit unindexed repo and falls back only to an indexed authorized repo", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/indexed"]) })
    const res = await resolveRepoTarget(env, {
      explicitOwner: "acme",
      explicitRepo: "unindexed",
      sessionRepos: [
        { installationId: 111, owner: "acme", repo: "indexed" },
        { installationId: 111, owner: "acme", repo: "unindexed" },
      ],
    })
    expect(res).toEqual({ target: { owner: "acme", repo: "indexed" }, hasIndexedRepo: true })
  })

  it("resolves a real tenant key through D1 without the static installation map", async () => {
    const db = await repoDb([
      { repoId: 1, installationId: 111, fullName: "Acme/.github" },
      { repoId: 2, installationId: 111, fullName: "Acme/widgets" },
    ])
    const env = envWith({
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: fakeKv(["acme/.github", "acme/widgets"], {
        "deep-research-default-repo:111": "Acme/widgets",
      }),
    })
    const res = await resolveRepoTarget(env, { installationId: 111 })
    expect(res).toEqual({ target: { owner: "Acme", repo: "widgets" }, hasIndexedRepo: true })
  })

  it("gives the legacy global-key sentinel no repo scope", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["victim/secret"]) })
    const res = await resolveRepoTarget(env, {
      explicitOwner: "victim",
      explicitRepo: "secret",
      installationId: -1,
    })
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })

  it("returns no target + hasIndexedRepo:false when the caller has no indexed repo", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv([]) })
    const res = await resolveRepoTarget(env, { sessionRepos: [] })
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })

  it("returns no target when there is no identity hint at all", async () => {
    const env = envWith({ OPENCLAW_STATE: fakeKv(["acme/widgets"]) })
    const res = await resolveRepoTarget(env, {})
    expect(res).toEqual({ target: null, hasIndexedRepo: false })
  })
})
