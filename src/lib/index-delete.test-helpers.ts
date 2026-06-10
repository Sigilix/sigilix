// Shared fixtures for the index-delete.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).

import {
  type RepoIndexManifestV1,
} from "@/src/lib/repo-index-manifest"
import {
  type RepoIndexVectorsV1,
} from "@/src/lib/repo-index-vectors"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { Env } from "@/src/shared/types/env"

export interface KvListPage {
  keys: Array<{ name: string }>
  list_complete: boolean
  cursor?: string
}

export function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  /** Optional override of list() behaviour for pagination tests. */
  setListImpl: (impl: (opts: { prefix?: string; limit?: number; cursor?: string }) => KvListPage) => void
} {
  const store = new Map<string, string>()
  let listImpl: ((opts: { prefix?: string; limit?: number; cursor?: string }) => KvListPage) | null = null
  const defaultList = (opts: { prefix?: string; limit?: number; cursor?: string }): KvListPage => {
    const prefix = opts.prefix ?? ""
    const all = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort()
    return { keys: all.map((name) => ({ name })), list_complete: true }
  }
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListPage> {
      return (listImpl ?? defaultList)(opts)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return {
    kv, store,
    setListImpl: (impl) => { listImpl = impl },
  }
}

export function makeEnv(opts: {
  kv?: Env["OPENCLAW_STATE"]
  deleteByIdsImpl?: (ids: string[]) => Promise<unknown>
  graphDeleteImpl?: (namespace: string) => Promise<void>
} = {}): { env: Env; deletedBatches: string[][]; graphDeletedNamespaces: string[] } {
  const kv = opts.kv ?? makeKvStub().kv
  const deletedBatches: string[][] = []
  const graphDeletedNamespaces: string[] = []

  // Minimal REPO_GRAPH_DO stub: tracks which DO instances had deleteRepoGraph()
  // called on them (identified by the namespace string passed to idFromName).
  const graphDeleteImpl = opts.graphDeleteImpl
  const repoGraphDO = {
    idFromName(name: string) {
      return { name, toString: () => name }
    },
    get(id: { name: string }) {
      return {
        async deleteRepoGraph(): Promise<void> {
          if (graphDeleteImpl) {
            await graphDeleteImpl(id.name)
          } else {
            graphDeletedNamespaces.push(id.name)
          }
        },
        // Stub remaining RPC methods — not called by the delete path.
        async upsertFileGraph(): Promise<void> { /* no-op */ },
        async commitGraphVersion(): Promise<void> { /* no-op */ },
      }
    },
  }

  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_CODE_INDEX: {
      deleteByIds: opts.deleteByIdsImpl ?? (async (ids: string[]) => {
        deletedBatches.push([...ids])
        return { ids, count: ids.length }
      }),
    },
    REPO_GRAPH_DO: repoGraphDO,
  } as unknown as Env
  return { env, deletedBatches, graphDeletedNamespaces }
}

export function manifest(over: Partial<RepoIndexManifestV1> = {}): RepoIndexManifestV1 {
  return {
    v: 1,
    repo: "sigilix",
    owner: "Sigilix",
    headSha: "a".repeat(40),
    runId: "0123456789abcdef",
    fileCount: 1, chunkCount: 1, shardCount: 1,
    indexedAt: "2026-05-17T00:00:00.000Z",
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: 1,
    windowLines: 30, overlapLines: 10,
    ...over,
  }
}

export function vectors(over: Partial<RepoIndexVectorsV1> = {}): RepoIndexVectorsV1 {
  return {
    v: 1,
    repo: "sigilix",
    owner: "Sigilix",
    runId: "0123456789abcdef",
    byPath: {
      "src/a.ts": ["id-a1", "id-a2"],
      "src/b.ts": ["id-b1"],
    },
    ...over,
  }
}
