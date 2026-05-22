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
  appendVectorCoverage,
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
  it("keys by the lowercased <owner>/<repo> namespace", () => {
    expect(repoIndexVectorsKey("Arc-and-Anchor", "Sigilix")).toBe(
      "repo-index-vectors:arc-and-anchor/sigilix",
    )
    expect(repoIndexVectorsKey("ACME", "API")).toBe("repo-index-vectors:acme/api")
  })
})

describe("read/write round-trip", () => {
  it("round-trips a valid record", async () => {
    const { kv } = makeKvStub()
    const ok = await writeRepoIndexVectors(makeEnv(kv), SAMPLE_VECTORS)
    expect(ok).toBe(true)
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.vectors).toEqual(SAMPLE_VECTORS)
    }
  })

  it("returns missing when no record exists", async () => {
    const { kv } = makeKvStub()
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "nothing")
    expect(result.kind).toBe("missing")
  })

  it("returns invalid/json-parse for non-JSON", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-vectors:arc-and-anchor/sigilix", "{not json")
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("json-parse")
  })

  it("returns invalid/wrong-version for v0 records", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "repo-index-vectors:arc-and-anchor/sigilix",
      JSON.stringify({ ...SAMPLE_VECTORS, v: 2 }),
    )
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("wrong-version")
  })

  it("returns invalid/shape on missing owner", async () => {
    const { kv, store } = makeKvStub()
    const bad = { ...SAMPLE_VECTORS } as Partial<RepoIndexVectorsV1>
    delete bad.owner
    store.set("repo-index-vectors:arc-and-anchor/sigilix", JSON.stringify(bad))
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("shape")
  })

  it("returns invalid/shape on non-array byPath value", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-vectors:arc-and-anchor/sigilix", JSON.stringify({
      ...SAMPLE_VECTORS,
      byPath: { "src/a.ts": "not-an-array" },
    }))
    const result = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") expect(result.reason).toBe("shape")
  })

  it("deleteRepoIndexVectors removes the record under the <owner>/<repo> key", async () => {
    const { kv, store } = makeKvStub()
    await writeRepoIndexVectors(makeEnv(kv), SAMPLE_VECTORS)
    expect(store.has("repo-index-vectors:arc-and-anchor/sigilix")).toBe(true)
    await deleteRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "Sigilix")
    expect(store.has("repo-index-vectors:arc-and-anchor/sigilix")).toBe(false)
  })
})

describe("computeMerge — run-aware semantics", () => {
  const base = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    runId: "run-A",
    activeRunId: "run-A" as string | null,
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
      activeRunId: "run-A",
      idsByPathSlice: { "src/a.ts": ["a1"] },
    })
    expect(outcome.action).toBe("superseded")
    if (outcome.action === "superseded") {
      // SIG-137: the superseded run's ids are PRESERVED (union), not discarded —
      // the id-list is a delete-coverage ledger, so the stale run's already-
      // upserted vectors stay deletable by the GDPR uninstall path.
      expect(outcome.vectors.byPath).toEqual({ "src/old.ts": ["x"], "src/a.ts": ["a1"] })
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
      activeRunId: "current-run",
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
      activeRunId: null,
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

  it("supersedes when the active-run lease names the incoming run (SIG-136 re-index)", () => {
    const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "old", byPath: { "a.ts": ["id1"] } } } as const
    const out = computeMerge({ existing, owner: "o", repo: "r", runId: "new", idsByPathSlice: { "a.ts": ["id2"] }, activeRunId: "new" })
    expect(out.action).toBe("superseded")
  })
  it("stale-skips when a DIFFERENT run holds the lease (redelivery / superseded)", () => {
    const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "old", byPath: { "a.ts": ["id1"] } } } as const
    const out = computeMerge({ existing, owner: "o", repo: "r", runId: "old", idsByPathSlice: { "a.ts": ["id1"] }, activeRunId: "newer" })
    expect(out.action).toBe("stale-skip")
  })
  it("lease mismatch stale-skips even when existing is MISSING (gates create)", () => {
    const out = computeMerge({ existing: { kind: "missing" }, owner: "o", repo: "r", runId: "run-1", idsByPathSlice: { "a.ts": ["id1"] }, activeRunId: "run-2" })
    expect(out.action).toBe("stale-skip")
  })
  it("creates when existing missing and the lease is ours", () => {
    const out = computeMerge({ existing: { kind: "missing" }, owner: "o", repo: "r", runId: "run-1", idsByPathSlice: { "a.ts": ["id1"] }, activeRunId: "run-1" })
    expect(out.action).toBe("created")
  })
  it("extends a continuation shard of the same run", () => {
    const existing = { kind: "ok", vectors: { v: 1, owner: "o", repo: "r", runId: "run-1", byPath: { "a.ts": ["id1"] } } } as const
    const out = computeMerge({ existing, owner: "o", repo: "r", runId: "run-1", idsByPathSlice: { "b.ts": ["id2"] }, activeRunId: "run-1" })
    expect(out.action).toBe("extended")
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

// ── SIG-137: appendVectorCoverage (pre-upsert, lease-agnostic delete ledger) ──

describe("appendVectorCoverage", () => {
  it("creates the record with the given runId when none exists", async () => {
    const { kv } = makeKvStub()
    await appendVectorCoverage(makeEnv(kv), "Arc-and-Anchor", "Sigilix", "run-1", { "src/a.ts": ["a1", "a2"] })
    const r = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "Sigilix")
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") {
      expect(r.vectors.runId).toBe("run-1")
      expect(r.vectors.byPath).toEqual({ "src/a.ts": ["a1", "a2"] })
    }
  })

  it("unions into an existing record and PRESERVES its runId (coverage doesn't claim ownership)", async () => {
    const { kv } = makeKvStub()
    await writeRepoIndexVectors(makeEnv(kv), {
      v: 1, owner: "Arc-and-Anchor", repo: "sigilix", runId: "run-A",
      byPath: { "src/a.ts": ["a1"] },
    })
    // A different (e.g. superseded) run appends coverage — must not drop run-A's
    // ids and must not steal ownership of the runId field.
    await appendVectorCoverage(makeEnv(kv), "Arc-and-Anchor", "Sigilix", "run-B", { "src/a.ts": ["a2"], "src/b.ts": ["b1"] })
    const r = await readRepoIndexVectors(makeEnv(kv), "Arc-and-Anchor", "Sigilix")
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") {
      expect(r.vectors.runId).toBe("run-A") // preserved
      expect(new Set(r.vectors.byPath["src/a.ts"])).toEqual(new Set(["a1", "a2"]))
      expect(r.vectors.byPath["src/b.ts"]).toEqual(["b1"])
    }
  })

  it("is a no-op for an empty slice (no write)", async () => {
    const { kv, store } = makeKvStub()
    await appendVectorCoverage(makeEnv(kv), "Arc-and-Anchor", "Sigilix", "run-1", {})
    expect(store.size).toBe(0)
  })

  it("throws when the KV write fails (so the caller aborts before upserting)", async () => {
    const failingKv = {
      async get(): Promise<string | null> { return null },
      async put(): Promise<void> { throw new Error("kv down") },
      async delete(): Promise<void> {},
    } as unknown as Env["OPENCLAW_STATE"]
    await expect(
      appendVectorCoverage(makeEnv(failingKv), "o", "r", "run-1", { "src/a.ts": ["a1"] }),
    ).rejects.toThrow(/coverage write failed/)
  })
})
