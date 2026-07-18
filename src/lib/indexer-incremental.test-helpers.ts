// Shared fixtures for the indexer-incremental.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the vitest
// `include` glob is `src/**/*.test.ts`). The per-file `vi.hoisted` / `vi.mock`
// blocks stay in each suite (hoisting is per-module); only the mock-free env /
// KV / job fixtures live here. SIG-422 split this out so the compare-recovery
// suite can reuse the harness without exceeding the file-size budget.

import { vi } from "vitest"

import type { RepoActiveIndexBuiltMode, RepoActiveIndexSnapshotV1 } from "@/src/lib/repo-active-index"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

export const TEST_GITHUB_REPO_ID = 808_247_824

export function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
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

/** The AI / Vectorize mocks the env wiring needs — each suite passes its own hoisted spies. */
export interface IndexerEnvMocks {
  aiRun: (model: string, input: unknown) => unknown
  vectorizeUpsert: (...args: unknown[]) => unknown
  vectorizeDeleteByIds: (...args: unknown[]) => unknown
}

export function makeEnv(
  mocks: IndexerEnvMocks,
  opts: { getImpl?: (key: string, store: Map<string, string>) => Promise<string | null> } = {},
): {
  env: Env
  kv: Map<string, string>
  sent: JobMessage[]
} {
  const { kv, store } = makeKvStub()
  const sent: JobMessage[] = []
  const state =
    opts.getImpl === undefined
      ? kv
      : ({
          ...kv,
          get: (key: string) => opts.getImpl?.(key, store) ?? kv.get(key),
        } as unknown as Env["OPENCLAW_STATE"])
  const env = {
    OPENCLAW_STATE: state,
    OPENCLAW_JOBS: {
      send: vi.fn(async (message: JobMessage) => {
        sent.push(message)
      }),
    },
    OPENCLAW_INDEXER_ENABLED: "on",
    AI: { run: (model: string, input: unknown) => mocks.aiRun(model, input) },
    OPENCLAW_CODE_INDEX: {
      upsert: mocks.vectorizeUpsert,
      deleteByIds: mocks.vectorizeDeleteByIds,
    },
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, kv: store, sent }
}

export function seedIndexedRepo(kv: Map<string, string>, manifestOver: Partial<RepoIndexManifestV1> = {}): void {
  const manifest: RepoIndexManifestV1 = {
    v: 1,
    repo: "sigilix",
    owner: "Sigilix",
    actualRepo: "sigilix",
    defaultBranch: "main",
    namespace: "sigilix/sigilix",
    headSha: "a".repeat(40),
    runId: "old-run",
    fileCount: 3,
    chunkCount: 3,
    shardCount: 1,
    indexedAt: "2026-06-13T00:00:00.000Z",
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: 2,
    citationChunkVersion: CITATION_CHUNK_VERSION,
    windowLines: 30,
    overlapLines: 10,
    // SIG-422: callers can override e.g. `headSha` to seed a manifest that is
    // already AHEAD of an out-of-order push (the no-regression test).
    ...manifestOver,
  }
  const vectors: RepoIndexVectorsV1 = {
    v: 1,
    owner: "Sigilix",
    repo: "sigilix",
    runId: "old-run",
    byPath: {
      "src/changed.ts": ["old-changed-id"],
      "src/deleted.ts": ["old-deleted-id"],
      "src/unchanged.ts": ["old-unchanged-id"],
    },
  }
  kv.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest))
  kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))
}

export function seedActiveIndexedRepo(
  kv: Map<string, string>,
  builtMode: RepoActiveIndexBuiltMode,
  activeOver: Partial<RepoActiveIndexSnapshotV1> = {},
): void {
  const activeIndex: RepoActiveIndexSnapshotV1 = {
    version: 1,
    githubRepoId: TEST_GITHUB_REPO_ID,
    builtMode,
    byPath: {
      "src/changed.ts": ["1".repeat(48)],
      "src/deleted.ts": ["2".repeat(48)],
      "src/unchanged.ts": ["3".repeat(48)],
    },
    ...activeOver,
  }
  seedIndexedRepo(kv, {
    githubRepoId: TEST_GITHUB_REPO_ID,
    activeIndex,
  })
}

export function pushJobWithChangedPaths(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "push",
    before: "a".repeat(40),
    changedPaths: {
      upsert: ["src/changed.ts"],
      remove: ["src/deleted.ts"],
    },
  } as unknown as Extract<JobMessage, { type: "index-repo" }>
}

// SIG-422: a default-branch merged-pr re-index job — no `before`, no
// `changedPaths`. The producer enqueues this on every PR merge; before
// SIG-422 it forced a full repo re-embed.
export function mergedPrJob(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "merged-pr",
    branch: "main",
  } as unknown as Extract<JobMessage, { type: "index-repo" }>
}

// SIG-422: a chain-intact pinned push — carries `before` (matches the seeded
// manifest head "a"…), `after` (the pushed tip "e"…), and `changedPaths`. The
// consumer pins the index head to `after` and trusts the changedPaths delta
// without a Compare call, so the manifest advances to "e"… and the next push's
// `before` will match it (the chain stays tight).
export function pushJobPinned(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "push",
    before: "a".repeat(40),
    after: "e".repeat(40),
    changedPaths: {
      upsert: ["src/changed.ts"],
      remove: ["src/deleted.ts"],
    },
  } as unknown as Extract<JobMessage, { type: "index-repo" }>
}

// SIG-422: a default-branch pull-request re-index job — no `before`, no
// `changedPaths` (same shape as merged-pr). Used to prove compare-recovery
// telemetry labels its trigger `pull-request`, not `merged-pr`.
export function pullRequestJob(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "pull-request",
    branch: "main",
  } as unknown as Extract<JobMessage, { type: "index-repo" }>
}
