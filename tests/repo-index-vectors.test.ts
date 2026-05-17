// ARC-238 — tests for the repo-index-vectors KV module.
//
// Covers serdes, run-aware merge semantics, flatten/dedupe, and the
// invalid-shape branches that the consumer relies on for safe writes.

import { describe, expect, it } from "vitest"
import {
  computeMerge,
  deleteRepoIndexVectors,
  flattenIds,
  readRepoIndexVectors,
  repoIndexVectorsKey,
  writeRepoIndexVectors,
  type RepoIndexVectorsV1,
} from "../src/lib/repo-index-vectors"
import type { Env } from "../src/index"

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

const SAMPLE_VECTORS: RepoIndexVectorsV1 = {
  v: 1,
  repo: "sigilix",
  owner: "Arc-and-Anchor",
  runId: "0123456789abcdef",
  byPath: {
    "src/a.ts": ["aaa", "bbb"],
    "src/b.ts": ["ccc"],
  },
}

describe("repoIndexVectorsKey", () => {
  it("lowercases the repo", () => {
    expect(repoIndexVectorsKey("Sigilix")).toBe("repo-index-vectors:sigilix")
    expect(repoIndexVectorsKey("SIGILIX")).toBe("repo-index-vectors:sigilix")
  })
})

describe("read/write round-trip", () => {
  it("round-trips a valid record", async () => {
    const { kv } = makeKvStub()
    const ok = await writeRepoIndexVectors(makeEnv(kv), SAMPLE_VECTORS)
    expect(ok).toBe(true)
    const result = await readRepoIndexVectors(makeEnv(kv), "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.vectors).toEqual(SAMPLE_VECTORS)
    }
  })

  it("returns missing when no record exists", async () => {
    const { kv } = makeKvStub()
    const result = await readRepoIndexVectors(makeEnv(kv), "nothing")
    expect(result.kind).toBe("missing")
  })

  it("returns invalid/json-parse for non-JSON", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-vectors:sigilix", "{not json")
    const result = await readRepoIndexVectors(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("json-parse")
  })

  it("returns invalid/wrong-version for v0 records", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-vectors:sigilix", JSON.stringify({ ...SAMPLE_VECTORS, v: 2 }))
    const result = await readRepoIndexVectors(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("wrong-version")
  })

  it("returns invalid/shape on missing owner", async () => {
    const { kv, store } = makeKvStub()
    const bad = { ...SAMPLE_VECTORS } as Partial<RepoIndexVectorsV1>
    delete bad.owner
    store.set("repo-index-vectors:sigilix", JSON.stringify(bad))
    const result = await readRepoIndexVectors(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("shape")
  })

  it("returns invalid/shape on non-array byPath value", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-vectors:sigilix", JSON.stringify({
      ...SAMPLE_VECTORS,
      byPath: { "src/a.ts": "not-an-array" },
    }))
    const result = await readRepoIndexVectors(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("shape")
  })

  it("deleteRepoIndexVectors removes the record under the lowercased key", async () => {
    const { kv, store } = makeKvStub()
    await writeRepoIndexVectors(makeEnv(kv), SAMPLE_VECTORS)
    expect(store.has("repo-index-vectors:sigilix")).toBe(true)
    await deleteRepoIndexVectors(makeEnv(kv), "Sigilix")
    expect(store.has("repo-index-vectors:sigilix")).toBe(false)
  })
})

describe("computeMerge — run-aware semantics", () => {
  const base = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    runId: "run-A",
    currentManifestRunId: "run-A" as string | null,
  }

  it("CREATE — no existing record", () => {
    const outcome = computeMerge({
      ...base,
      existing: { kind: "missing" },
      idsByPathSlice: { "src/a.ts": ["a1", "a2"] },
    })
    expect(outcome.action).toBe("created")
    if (outcome.action === "created") {
      expect(outcome.vectors.byPath).toEqual({ "src/a.ts": ["a1", "a2"] })
      expect(outcome.vectors.repo).toBe("sigilix")
      expect(outcome.vectors.owner).toBe("Arc-and-Anchor")
      expect(outcome.vectors.runId).toBe("run-A")
    }
  })

  it("EXTEND — same runId, set-union by path", () => {
    const outcome = computeMerge({
      ...base,
      existing: {
        kind: "ok",
        vectors: {
          v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "run-A",
          byPath: { "src/a.ts": ["a1"], "src/b.ts": ["b1"] },
        },
      },
      idsByPathSlice: { "src/a.ts": ["a2"], "src/c.ts": ["c1"] },
    })
    expect(outcome.action).toBe("extended")
    if (outcome.action === "extended") {
      expect(outcome.vectors.byPath["src/a.ts"]).toEqual(["a1", "a2"])
      expect(outcome.vectors.byPath["src/b.ts"]).toEqual(["b1"])
      expect(outcome.vectors.byPath["src/c.ts"]).toEqual(["c1"])
    }
  })

  it("EXTEND deduplicates if a chunkId reappears in the slice", () => {
    const outcome = computeMerge({
      ...base,
      existing: {
        kind: "ok",
        vectors: {
          v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "run-A",
          byPath: { "src/a.ts": ["a1"] },
        },
      },
      idsByPathSlice: { "src/a.ts": ["a1", "a2"] },
    })
    expect(outcome.action).toBe("extended")
    if (outcome.action === "extended") {
      expect(outcome.vectors.byPath["src/a.ts"]).toEqual(["a1", "a2"])
    }
  })

  it("SUPERSEDE — different runId, but THIS run is the current manifest", () => {
    const outcome = computeMerge({
      ...base,
      existing: {
        kind: "ok",
        vectors: {
          v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "run-B-stale",
          byPath: { "src/old.ts": ["x"] },
        },
      },
      currentManifestRunId: "run-A",
      idsByPathSlice: { "src/a.ts": ["a1"] },
    })
    expect(outcome.action).toBe("superseded")
    if (outcome.action === "superseded") {
      // Stale run's data discarded.
      expect(outcome.vectors.byPath).toEqual({ "src/a.ts": ["a1"] })
    }
  })

  it("STALE-SKIP — different runId AND we are not the current manifest run", () => {
    const outcome = computeMerge({
      ...base,
      runId: "stale-run",
      existing: {
        kind: "ok",
        vectors: {
          v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "current-run",
          byPath: { "src/a.ts": ["a1"] },
        },
      },
      currentManifestRunId: "current-run",
      idsByPathSlice: { "src/a.ts": ["a-stale"] },
    })
    expect(outcome.action).toBe("stale-skip")
    if (outcome.action === "stale-skip") {
      expect(outcome.existingRunId).toBe("current-run")
    }
  })

  it("STALE-SKIP — no manifest yet, foreign run in storage", () => {
    const outcome = computeMerge({
      ...base,
      runId: "this-run",
      existing: {
        kind: "ok",
        vectors: {
          v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "other-run",
          byPath: { "src/a.ts": ["a1"] },
        },
      },
      currentManifestRunId: null,
      idsByPathSlice: { "src/b.ts": ["b1"] },
    })
    expect(outcome.action).toBe("stale-skip")
  })

  it("INVALID-OVERWRITE — corrupted record gets a fresh write", () => {
    const outcome = computeMerge({
      ...base,
      existing: { kind: "invalid", reason: "shape" },
      idsByPathSlice: { "src/a.ts": ["a1"] },
    })
    expect(outcome.action).toBe("invalid-overwrite")
    if (outcome.action === "invalid-overwrite") {
      expect(outcome.vectors.byPath).toEqual({ "src/a.ts": ["a1"] })
    }
  })

  it("ignores empty path arrays in the incoming slice", () => {
    const outcome = computeMerge({
      ...base,
      existing: { kind: "missing" },
      idsByPathSlice: { "src/a.ts": ["a1"], "src/empty.ts": [] },
    })
    expect(outcome.action).toBe("created")
    if (outcome.action === "created") {
      expect(outcome.vectors.byPath).toEqual({ "src/a.ts": ["a1"] })
    }
  })
})

describe("flattenIds", () => {
  it("returns a deduped flat list", () => {
    const ids = flattenIds({
      v: 1, owner: "o", repo: "r", runId: "rn",
      byPath: {
        "a": ["x", "y", "shared"],
        "b": ["shared", "z"],
      },
    })
    expect(new Set(ids)).toEqual(new Set(["x", "y", "shared", "z"]))
    expect(ids.length).toBe(4)
  })

  it("returns [] for an empty byPath", () => {
    const ids = flattenIds({
      v: 1, owner: "o", repo: "r", runId: "rn", byPath: {},
    })
    expect(ids).toEqual([])
  })
})
