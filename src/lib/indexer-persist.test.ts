// Tests for the repo-role wiring in the index-repo persistence path:
//   - `computeRepoRoleForIndex` self-gates (flag + default-branch) and NEVER
//     throws (a package.json fetch failure degrades to path-only signals).
//   - `persistManifest` stamps the role onto the manifest, additively, without
//     changing the existing write behavior.

import { describe, expect, it, vi } from "vitest"
import { computeRepoRoleForIndex, enqueueNextShard, persistManifest } from "@/src/lib/indexer-persist"
import { readRepoIndexManifest } from "@/src/lib/repo-index-manifest"
import type { TreeEntry } from "@/src/lib/indexer-internals"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(over: Partial<Env>): Env {
  return over as unknown as Env
}

function treeEntries(paths: readonly string[]): TreeEntry[] {
  return paths.map((path) => ({ path, type: "blob" }))
}

/** A GitHubClient stub exposing only the file reader this path uses. */
function fakeClient(getFileContent: GitHubClient["getFileContent"]): GitHubClient {
  return { getFileContent } as unknown as GitHubClient
}

const EXPRESS_PKG = JSON.stringify({ dependencies: { express: "^4" } })

const ACTIVE_INDEX = {
  version: 1 as const,
  githubRepoId: 808247824,
  builtMode: "shadow" as const,
  byPath: { "src/server.ts": ["a".repeat(48)] },
}

describe("enqueueNextShard — pinned active-index state", () => {
  it("forwards the pinned mode and bookmark onto the root continuation message", async () => {
    const send = vi.fn(async (_message: JobMessage) => undefined)
    await enqueueNextShard(makeEnv({ OPENCLAW_JOBS: { send } as unknown as Env["OPENCLAW_JOBS"] }), {
      owner: "Sigilix",
      repo: "sigilix",
      githubRepoId: 808247824,
      installationId: 42,
      reason: "push",
      activeIndexMode: "shadow",
      activeIndexBookmark: "bookmark-1",
      lo: 1000,
      hi: 2000,
      headSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      defaultBranch: "main",
      totalFiles: 2500,
      filesDone: 1000,
      chunksDone: 1200,
      runId: "0123456789abcdef",
    })

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      activeIndexMode: "shadow",
      activeIndexBookmark: "bookmark-1",
      shard: { runId: "0123456789abcdef" },
    })
  })

  it("keeps the bookmark absent on legacy/off continuations", async () => {
    const send = vi.fn(async (_message: JobMessage) => undefined)
    await enqueueNextShard(makeEnv({ OPENCLAW_JOBS: { send } as unknown as Env["OPENCLAW_JOBS"] }), {
      owner: "Sigilix",
      repo: "sigilix",
      githubRepoId: undefined,
      installationId: 42,
      reason: "manual",
      activeIndexMode: "off",
      lo: 1,
      hi: 2,
      headSha: "a",
      treeSha: "b",
      defaultBranch: "main",
      totalFiles: 2,
      filesDone: 1,
      chunksDone: 1,
      runId: "run-1",
    })

    const message = send.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(message.activeIndexMode).toBe("off")
    expect(message).not.toHaveProperty("activeIndexBookmark")
  })
})

describe("computeRepoRoleForIndex", () => {
  it("returns undefined and does not fetch when the flag is off", async () => {
    const getFileContent = vi.fn(async () => null)
    const role = await computeRepoRoleForIndex({
      env: makeEnv({}),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "api",
      ref: "abc",
      treeEntries: treeEntries(["src/server.ts"]),
      isDefaultBranch: true,
    })
    expect(role).toBeUndefined()
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("returns undefined for a non-default branch even with the flag on", async () => {
    const getFileContent = vi.fn(async () => null)
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "api",
      ref: "abc",
      treeEntries: treeEntries(["src/server.ts"]),
      isDefaultBranch: false,
    })
    expect(role).toBeUndefined()
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("classifies from package.json + tree when enabled on the default branch", async () => {
    const getFileContent = vi.fn(async () => EXPRESS_PKG)
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "api",
      ref: "abc",
      treeEntries: treeEntries(["package.json", "src/server.ts"]),
      isDefaultBranch: true,
    })
    expect(role).toBe("backend")
    expect(getFileContent).toHaveBeenCalledWith("acme", "api", "package.json", "abc")
  })

  it("degrades to path-only signals (never throws) when the package.json fetch fails", async () => {
    const getFileContent = vi.fn(async () => {
      throw new Error("boom")
    })
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "infra",
      ref: "abc",
      // package.json blob present → the fetch is attempted (and throws here).
      treeEntries: treeEntries(["package.json", "main.tf", "variables.tf", "k8s/deploy.yaml"]),
      isDefaultBranch: true,
    })
    // The fetch threw, but the tree paths still classify.
    expect(getFileContent).toHaveBeenCalled()
    expect(role).toBe("infra")
  })

  it("skips the package.json fetch entirely for a repo with no package.json (non-JS)", async () => {
    const getFileContent = vi.fn(async () => null)
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "svc",
      ref: "abc",
      treeEntries: treeEntries(["manage.py", "app/models.py", "requirements.txt"]),
      isDefaultBranch: true,
    })
    expect(getFileContent).not.toHaveBeenCalled()
    expect(role).toBe("backend")
  })

  it("ignores directory (tree) entries so they do not dilute the file-ratio", async () => {
    // GitHub's recursive tree includes `type: "tree"` directory entries; they
    // have no extension and would drag the FE file-share below the threshold.
    const getFileContent = vi.fn(async () => null)
    const entries: TreeEntry[] = [
      { path: "src", type: "tree" },
      { path: "components", type: "tree" },
      { path: "public", type: "tree" },
      { path: "assets", type: "tree" },
      { path: "src/App.tsx", type: "blob" },
      { path: "src/Button.tsx", type: "blob" },
      { path: "src/styles.css", type: "blob" },
    ]
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "web",
      ref: "abc",
      treeEntries: entries,
      isDefaultBranch: true,
    })
    // No root package.json blob → no fetch; blob-only ratio → frontend.
    expect(getFileContent).not.toHaveBeenCalled()
    expect(role).toBe("frontend")
  })

  it("returns unknown (never throws) when signals are insufficient", async () => {
    const getFileContent = vi.fn(async () => null)
    const role = await computeRepoRoleForIndex({
      env: makeEnv({ OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      client: fakeClient(getFileContent),
      owner: "acme",
      repo: "docs",
      ref: "abc",
      treeEntries: treeEntries(["README.md", "LICENSE"]),
      isDefaultBranch: true,
    })
    expect(role).toBe("unknown")
  })
})

describe("persistManifest — repo-role stamping (additive)", () => {
  const baseArgs = {
    owner: "Sigilix",
    repo: "sigilix",
    githubRepoId: undefined,
    stateRepo: "sigilix",
    namespace: "sigilix/sigilix",
    branch: null,
    defaultBranch: "main",
    headSha: "a".repeat(40),
    runId: "0123456789abcdef",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    chunkerVersion: 2,
  }

  it("classifies + stamps the role from roleClassify when the flag is on (default branch)", async () => {
    const { kv, store } = makeKvStub()
    await persistManifest({
      ...baseArgs,
      env: makeEnv({ OPENCLAW_STATE: kv, OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      roleClassify: {
        client: fakeClient(vi.fn(async () => EXPRESS_PKG)),
        treeEntries: treeEntries(["package.json", "src/server.ts"]),
      },
    })
    const result = await readRepoIndexManifest(makeEnv({ OPENCLAW_STATE: kv }), "Sigilix", "sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.manifest.repoRole).toBe("backend")
    expect(store.size).toBeGreaterThan(0)
  })

  it("omits the role when the flag is off (zero behavior change)", async () => {
    const { kv } = makeKvStub()
    const getFileContent = vi.fn(async () => EXPRESS_PKG)
    await persistManifest({
      ...baseArgs,
      env: makeEnv({ OPENCLAW_STATE: kv }),
      roleClassify: { client: fakeClient(getFileContent), treeEntries: treeEntries(["package.json"]) },
    })
    const result = await readRepoIndexManifest(makeEnv({ OPENCLAW_STATE: kv }), "Sigilix", "sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.manifest.repoRole).toBeUndefined()
    expect(getFileContent).not.toHaveBeenCalled()
  })

  it("carries a precomputed role forward (incremental path) without re-fetching", async () => {
    const { kv } = makeKvStub()
    await persistManifest({
      ...baseArgs,
      env: makeEnv({ OPENCLAW_STATE: kv, OPENCLAW_REPO_ROLE_CLASSIFY: "on" }),
      repoRole: "frontend",
    })
    const result = await readRepoIndexManifest(makeEnv({ OPENCLAW_STATE: kv }), "Sigilix", "sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.manifest.repoRole).toBe("frontend")
  })

  it("stamps a valid active index only on the matching default-branch manifest", async () => {
    const { kv } = makeKvStub()
    await persistManifest({
      ...baseArgs,
      env: makeEnv({ OPENCLAW_STATE: kv }),
      githubRepoId: ACTIVE_INDEX.githubRepoId,
      activeIndex: ACTIVE_INDEX,
    })

    const result = await readRepoIndexManifest(makeEnv({ OPENCLAW_STATE: kv }), "Sigilix", "sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.manifest.activeIndex).toEqual(ACTIVE_INDEX)
  })

  it.each([
    ["branch scope", { githubRepoId: 808247824, branch: "feature/x", activeIndex: ACTIVE_INDEX }],
    ["missing live id", { githubRepoId: undefined, branch: null, activeIndex: ACTIVE_INDEX }],
    ["mismatched live id", { githubRepoId: 808247825, branch: null, activeIndex: ACTIVE_INDEX }],
    [
      "malformed snapshot",
      {
        githubRepoId: 808247824,
        branch: null,
        activeIndex: { ...ACTIVE_INDEX, byPath: { "src/server.ts": [""] } },
      },
    ],
  ])("rejects %s before writing either manifest key", async (_label, overrides) => {
    const { kv, store } = makeKvStub()
    await expect(
      persistManifest({
        ...baseArgs,
        ...overrides,
        env: makeEnv({ OPENCLAW_STATE: kv }),
      }),
    ).rejects.toThrow(/active index/i)
    expect(store.size).toBe(0)
  })
})
