import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  readRepositoryContext,
  replaceRepositoryContext,
  type ReplaceRepositoryContextArgs,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { stageRepoActiveIndexSlice } from "@/src/lib/repo-active-index"

const SECRET = "repository-context-lifecycle-secret"
const INSTALLATION_ID = 42
const NOW = "2026-07-13T23:00:00.000Z"
const MIGRATION_SQL = [
  readFileSync(new URL("../migrations/0024_create_repository_context.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0025_create_repo_active_index_stage.sql", import.meta.url), "utf8"),
].join("\n")

function snapshotArgs(
  scopeId: string,
  overrides: Partial<ReplaceRepositoryContextArgs> = {},
): ReplaceRepositoryContextArgs {
  return {
    provider: "github",
    scopeId,
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
      { externalId: "202", fullName: "acme/worker", context: "Background jobs", position: 1 },
    ],
    relationships: [
      {
        fromExternalId: "101",
        toExternalId: "202",
        label: "publishes jobs",
        normalizedLabel: "publishes jobs",
        position: 0,
      },
    ],
    conventions: "Use conventional commits.",
    nowIso: NOW,
    updatedBy: "github:111",
    ...overrides,
  }
}

function makeEnv(
  db: D1Database | undefined,
  options: { deleteRepoGraph?: () => Promise<void> } = {},
): Record<string, unknown> {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
    OPENCLAW_STATE: {
      get: async (_key: string) => null,
      put: async (_key: string, _value: string) => {},
      delete: async (_key: string) => {},
      list: async () => ({ keys: [], list_complete: true }),
    },
    REPO_GRAPH_DO: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ deleteRepoGraph: options.deleteRepoGraph ?? (async () => {}) }),
    },
  }
}

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

async function postUninstall(
  worker: { fetch: (request: Request, env: never, ctx: never) => Promise<Response> },
  env: Record<string, unknown>,
  options: { deliveryId?: string; includeLogin?: boolean } = {},
): Promise<Response> {
  const payload = {
    action: "deleted",
    installation: {
      id: INSTALLATION_ID,
      ...(options.includeLogin === false ? {} : { account: { login: "acme" } }),
    },
    repositories: [],
  }
  const body = JSON.stringify(payload)
  return worker.fetch(
    new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": options.deliveryId ?? "delivery-uninstall-1",
        "x-hub-signature-256": await signBody(body),
      },
      body,
    }),
    env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

async function postRepositoriesRemoved(
  worker: { fetch: (request: Request, env: never, ctx: never) => Promise<Response> },
  env: Record<string, unknown>,
  repositoriesRemoved: Array<{ id?: number; full_name?: string }>,
  deliveryId = "delivery-repositories-removed-1",
): Promise<Response> {
  const body = JSON.stringify({
    action: "removed",
    installation: { id: INSTALLATION_ID, account: { login: "acme" } },
    repositories_removed: repositoriesRemoved,
  })
  return worker.fetch(
    new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation_repositories",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": await signBody(body),
      },
      body,
    }),
    env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

describe("GitHub uninstall repository-context lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("tombstones only the uninstalled GitHub installation through the signed worker webhook", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(db, snapshotArgs("42"))).status).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          snapshotArgs("99", {
            repositories: [{ externalId: "303", fullName: "other/web", context: "control", position: 0 }],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          snapshotArgs("42", {
            provider: "gitlab",
            repositories: [
              { externalId: "project-101", fullName: "other/gitlab", context: "provider control", position: 0 },
            ],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")
    const worker = (await import("@/src/index")).default

    const response = await postUninstall(worker, makeEnv(db))

    expect(response.status).toBe(202)
    const removed = await readRepositoryContext(db, "github", "42")
    expect(removed).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        repositories: [],
        relationships: [],
        conventions: "",
        deletedAt: expect.any(String),
      },
    })
    const control = await readRepositoryContext(db, "github", "99")
    expect(control).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        repositories: [{ externalId: "303", fullName: "other/web", context: "control", position: 0 }],
        deletedAt: null,
      },
    })
    await expect(readRepositoryContext(db, "gitlab", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        repositories: [
          { externalId: "project-101", fullName: "other/gitlab", context: "provider control", position: 0 },
        ],
        deletedAt: null,
      },
    })
  })

  it("treats a redelivery as an idempotent no-op without revision or audit churn", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(db, snapshotArgs("42"))).status).toBe("updated")
    const worker = (await import("@/src/index")).default
    const env = makeEnv(db)

    expect((await postUninstall(worker, env, { deliveryId: "delivery-redelivery" })).status).toBe(202)
    expect((await postUninstall(worker, env, { deliveryId: "delivery-redelivery" })).status).toBe(202)

    const read = await readRepositoryContext(db, "github", "42")
    expect(read).toMatchObject({ status: "ok", snapshot: { revision: 2, deletedAt: expect.any(String) } })
    await expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM repository_context_audit WHERE provider = ? AND scope_id = ?")
        .bind("github", "42")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 })
  })

  it("tombstones by installation id even when account.login is missing", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(db, snapshotArgs("42"))).status).toBe("updated")
    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: 101,
      installationId: INSTALLATION_ID,
      runId: "a".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "shadow",
      idsByPath: { "src/index.ts": ["b".repeat(48)] },
    })
    const worker = (await import("@/src/index")).default

    const response = await postUninstall(worker, makeEnv(db), { includeLogin: false })

    expect(response.status).toBe(200)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2, deletedAt: expect.any(String) },
    })
    await expect(db.prepare("SELECT COUNT(*) AS count FROM repo_active_index_run").first("count")).resolves.toBe(0)
  })

  it("keeps a missing-login uninstall retryable when installation-scoped staging cleanup fails", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(db, snapshotArgs("42"))).status).toBe("updated")
    const failingDb = {
      prepare(sql: string) {
        if (sql === "DELETE FROM repo_active_index_run WHERE installation_id = ?") {
          const failed = {
            bind: () => failed,
            run: async () => {
              throw new Error("D1 delete unavailable")
            },
          }
          return failed
        }
        return db.prepare(sql)
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      withSession: db.withSession.bind(db),
    } as unknown as D1Database
    const worker = (await import("@/src/index")).default

    const response = await postUninstall(worker, makeEnv(failingDb), { includeLogin: false })

    expect(response.status).toBe(503)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: { deletedAt: expect.any(String) },
    })
  })

  it("creates an absent revision-one tombstone that fences a stale revision-zero writer", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    const worker = (await import("@/src/index")).default

    expect((await postUninstall(worker, makeEnv(db))).status).toBe(202)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        repositories: [],
        relationships: [],
        conventions: "",
        deletedAt: expect.any(String),
      },
    })
    await expect(replaceRepositoryContext(db, snapshotArgs("42"))).resolves.toEqual({
      status: "conflict",
      currentRevision: 1,
    })
  })

  it.each([
    ["a missing platform D1 binding", undefined],
    ["an unmigrated platform D1 binding", makeD1()],
  ])("returns 503 for %s so GitHub can retry cleanup", async (_label, db) => {
    const worker = (await import("@/src/index")).default

    const response = await postUninstall(worker, makeEnv(db))

    expect(response.status).toBe(503)
  })
})

describe("GitHub repository removal repository-context lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("removes only exact repository ids and incident relationships through the signed worker webhook", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect(
      (
        await replaceRepositoryContext(
          db,
          snapshotArgs("42", {
            repositories: [
              { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
              { externalId: "202", fullName: "acme/worker", context: "Background jobs", position: 1 },
              { externalId: "303", fullName: "acme/web", context: "Web application", position: 2 },
            ],
            relationships: [
              {
                fromExternalId: "101",
                toExternalId: "202",
                label: "publishes jobs",
                normalizedLabel: "publishes jobs",
                position: 0,
              },
              {
                fromExternalId: "101",
                toExternalId: "303",
                label: "serves web",
                normalizedLabel: "serves web",
                position: 1,
              },
            ],
          }),
        )
      ).status,
    ).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          snapshotArgs("99", {
            repositories: [{ externalId: "202", fullName: "other/worker", context: "control", position: 0 }],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          snapshotArgs("42", {
            provider: "gitlab",
            repositories: [{ externalId: "202", fullName: "other/gitlab", context: "provider control", position: 0 }],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")
    const worker = (await import("@/src/index")).default
    const env = makeEnv(db)

    expect((await postRepositoriesRemoved(worker, env, [{ id: 202, full_name: "acme/worker" }])).status).toBe(202)

    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        repositories: [
          { externalId: "101", fullName: "acme/api" },
          { externalId: "303", fullName: "acme/web" },
        ],
        relationships: [{ fromExternalId: "101", toExternalId: "303", label: "serves web" }],
        conventions: "Use conventional commits.",
        deletedAt: null,
      },
    })
    await expect(readRepositoryContext(db, "github", "99")).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, repositories: [{ externalId: "202", fullName: "other/worker" }] },
    })
    await expect(readRepositoryContext(db, "gitlab", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, repositories: [{ externalId: "202", fullName: "other/gitlab" }] },
    })

    expect((await postRepositoriesRemoved(worker, env, [{ id: 202, full_name: "acme/worker" }])).status).toBe(202)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    })
    await expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM repository_context_audit WHERE provider = ? AND scope_id = ?")
        .bind("github", "42")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 })
  })

  it("creates a revision fence that rejects an in-flight stale revision-zero writer", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    const worker = (await import("@/src/index")).default

    expect((await postRepositoriesRemoved(worker, makeEnv(db), [{ id: 202, full_name: "acme/worker" }])).status).toBe(
      202,
    )
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        repositories: [],
        relationships: [],
        conventions: "",
        deletedAt: null,
      },
    })
    await expect(replaceRepositoryContext(db, snapshotArgs("42"))).resolves.toEqual({
      status: "conflict",
      currentRevision: 1,
    })
  })

  it("returns 503 for a malformed entry after reconciling every valid exact id", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(db, snapshotArgs("42"))).status).toBe("updated")
    const worker = (await import("@/src/index")).default

    const response = await postRepositoriesRemoved(worker, makeEnv(db), [
      { id: 202, full_name: "acme/worker" },
      { full_name: "acme/missing-id" },
    ])

    expect(response.status).toBe(503)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        repositories: [{ externalId: "101", fullName: "acme/api" }],
        relationships: [],
      },
    })
  })

  it.each([
    ["a missing platform D1 binding", undefined],
    ["an unmigrated platform D1 binding", makeD1()],
  ])("returns 503 for %s after the independent legacy cleanup still runs", async (_label, db) => {
    const worker = (await import("@/src/index")).default
    const deleteRepoGraph = vi.fn(async () => {})

    const response = await postRepositoriesRemoved(worker, makeEnv(db, { deleteRepoGraph }), [
      { id: 202, full_name: "acme/worker" },
    ])

    expect(response.status).toBe(503)
    expect(deleteRepoGraph).toHaveBeenCalledTimes(1)
  })
})
