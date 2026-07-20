import { beforeEach, describe, expect, it, vi } from "vitest"

// SIG-423: spy on the per-file graph write so we can assert the `writeGraph`
// gate. processSlice imports writeFileGraph directly from this module.
const { mockWriteFileGraph } = vi.hoisted(() => ({
  mockWriteFileGraph: vi.fn(async (..._args: unknown[]) => undefined),
}))
vi.mock("@/src/lib/repo-graph-client", () => ({
  writeFileGraph: (...args: unknown[]) => mockWriteFileGraph(...args),
}))

import { processSlice } from "@/src/lib/indexer-slice"
import type { Env } from "@/src/shared/types/env"

function graphEnv(): { env: Env; upsert: ReturnType<typeof vi.fn> } {
  const upsert = vi.fn(async (_records: Array<{ metadata: Record<string, unknown> }>) => undefined)
  const kv = new Map<string, string>()
  const env = {
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map(() => Array(768).fill(0.1)),
      }),
    },
    OPENCLAW_CODE_INDEX: { upsert },
    OPENCLAW_STATE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value)
      },
    },
    // Graph WRITER on so the per-file write branch is reached (SIG-423).
    OPENCLAW_GRAPH_INDEX: "on",
  } as unknown as Env
  return { env, upsert }
}

const client = {
  getFileContent: async () => "export function foo() {\n  return 1\n}\n",
} as never

describe("processSlice", () => {
  beforeEach(() => {
    mockWriteFileGraph.mockClear()
  })

  it("writes indexed commit and run metadata into Vectorize records", async () => {
    const { env, upsert } = graphEnv()

    await processSlice({
      client,
      env,
      owner: "Sigilix",
      repo: "sigilix",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      headSha: "abc123456789",
      runId: "run-abc",
      files: [{ path: "src/foo.ts", size: 42 }],
      astChunking: false,
    })

    const records = upsert.mock.calls.flatMap((call) => call[0] as Array<{ metadata: Record<string, unknown> }>)
    expect(records).toHaveLength(1)
    expect(records[0]!.metadata).toMatchObject({
      headSha: "abc123456789",
      runId: "run-abc",
      citationChunkVersion: 1,
      fragmentIndex: -1,
    })
  })

  it("writes each hard-split fragment's citation identity metadata", async () => {
    const { env, upsert } = graphEnv()
    const hardSplitClient = {
      getFileContent: async () => "=".repeat(2_800),
    } as never

    await processSlice({
      client: hardSplitClient,
      env,
      owner: "Sigilix",
      repo: "sigilix",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      headSha: "abc123456789",
      runId: "run-abc",
      files: [{ path: "src/generated.ts", size: 2_800 }],
      astChunking: false,
      writeGraph: false,
    })

    const records = upsert.mock.calls.flatMap((call) => call[0] as Array<{ metadata: Record<string, unknown> }>)
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.metadata)).toEqual([
      expect.objectContaining({ citationChunkVersion: 1, fragmentIndex: 0 }),
      expect.objectContaining({ citationChunkVersion: 1, fragmentIndex: 1 }),
    ])
  })

  // SIG-423: the full-tree path (writeGraph defaults to true) still writes graph
  // rows — guards against a regression that silently drops the committed graph.
  it("writes per-file graph rows by default (full-tree path)", async () => {
    const { env } = graphEnv()

    await processSlice({
      client,
      env,
      owner: "Sigilix",
      repo: "sigilix",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      headSha: "abc123456789",
      runId: "run-abc",
      files: [{ path: "src/foo.ts", size: 42 }],
      astChunking: false,
    })

    expect(mockWriteFileGraph).toHaveBeenCalledTimes(1)
    expect(mockWriteFileGraph).toHaveBeenCalledWith(
      env,
      "Sigilix",
      "sigilix",
      expect.objectContaining({ runId: "run-abc", path: "src/foo.ts" }),
    )
  })

  // SIG-423: the incremental push path passes writeGraph:false because its graph
  // rows are written under an uncommitted runId that no read path touches — pure
  // SQLite waste. The embed/upsert pipeline must be UNAFFECTED.
  it("skips per-file graph rows when writeGraph is false (incremental path)", async () => {
    const { env, upsert } = graphEnv()

    await processSlice({
      client,
      env,
      owner: "Sigilix",
      repo: "sigilix",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      headSha: "abc123456789",
      runId: "run-abc",
      files: [{ path: "src/foo.ts", size: 42 }],
      astChunking: false,
      writeGraph: false,
    })

    expect(mockWriteFileGraph).not.toHaveBeenCalled()
    // Embedding + upsert still happen — the graph skip is additive-only.
    const records = upsert.mock.calls.flatMap((call) => call[0] as Array<{ metadata: Record<string, unknown> }>)
    expect(records).toHaveLength(1)
  })

  // SIG-604: skip-unchanged content-id reuse.
  const sliceArgs = (env: Env, extra: Record<string, unknown> = {}) => ({
    client,
    env,
    owner: "Sigilix",
    repo: "sigilix",
    stateRepo: "sigilix",
    namespace: "sigilix/sigilix",
    headSha: "abc123456789",
    runId: "run-abc",
    files: [{ path: "src/foo.ts", size: 42 }],
    astChunking: false,
    ...extra,
  })

  it("SIG-604: no reuseIdsByPath → embeds every file (pre-604 behavior)", async () => {
    const { env, upsert } = graphEnv()
    const result = await processSlice(sliceArgs(env))
    expect(result.reusedFileCount).toBe(0)
    expect(upsert).toHaveBeenCalled()
  })

  it("SIG-604: reuses (skips embed) a file whose current chunk ids match the prior ids", async () => {
    // First pass with no reuse → capture the file's real chunk ids.
    const first = await processSlice(sliceArgs(graphEnv().env))
    const priorIds = first.idsByPath["src/foo.ts"]!
    expect(priorIds.length).toBeGreaterThan(0)
    mockWriteFileGraph.mockClear() // ignore the id-capturing pass's graph write

    // Second pass supplying those exact ids → the embed/upsert is skipped.
    const { env, upsert } = graphEnv()
    const result = await processSlice(sliceArgs(env, { reuseIdsByPath: { "src/foo.ts": priorIds } }))

    expect(result.reusedFileCount).toBe(1)
    expect(result.processedFileCount).toBe(1)
    expect(upsert).not.toHaveBeenCalled() // no embed
    expect(result.idsByPath["src/foo.ts"]).toEqual(priorIds) // ids preserved
    // The graph write is UNCONDITIONAL — a reused file still writes graph rows so
    // the committed graph stays complete.
    expect(mockWriteFileGraph).toHaveBeenCalledTimes(1)
  })

  it("SIG-604: does NOT reuse when the prior ids differ (changed content) → re-embeds", async () => {
    const { env, upsert } = graphEnv()
    const result = await processSlice(
      sliceArgs(env, { reuseIdsByPath: { "src/foo.ts": ["stale-id-that-wont-match"] } }),
    )
    expect(result.reusedFileCount).toBe(0)
    expect(upsert).toHaveBeenCalled() // embedded, not reused
  })

  it("SIG-604: reuse is per-path — an unmapped path still embeds", async () => {
    const { env, upsert } = graphEnv()
    const result = await processSlice(sliceArgs(env, { reuseIdsByPath: { "some/other.ts": ["whatever"] } }))
    expect(result.reusedFileCount).toBe(0)
    expect(upsert).toHaveBeenCalled()
  })
})
