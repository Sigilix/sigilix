// Tests for the repo-role wiring in the index-repo persistence path:
//   - `computeRepoRoleForIndex` self-gates (flag + default-branch) and NEVER
//     throws (a package.json fetch failure degrades to path-only signals).
//   - `persistManifest` stamps the role onto the manifest, additively, without
//     changing the existing write behavior.

import { describe, expect, it, vi } from "vitest"
import { computeRepoRoleForIndex, persistManifest } from "@/src/lib/indexer-persist"
import { readRepoIndexManifest } from "@/src/lib/repo-index-manifest"
import type { TreeEntry } from "@/src/lib/indexer-internals"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

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
})
