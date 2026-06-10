import { describe, expect, it } from "vitest"
import {
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  graphRetrievalEnabled,
  graphRetrievalMode,
  formatGraphContext,
  formatGraphBlastContext,
  graphOverlapStats,
  GRAPH_RPC_TIMEOUT_MS,
  BLAST_RADIUS_RESOLUTION_READY,
} from "@/src/lib/triage-pr-review-ensemble"

describe("graphRetrievalEnabled", () => {
  const makeEnv = (v: string | undefined) =>
    ({ OPENCLAW_GRAPH_RETRIEVAL: v } as unknown as import("@/src/index").Env)

  it("returns true for 'shadow'", () => {
    expect(graphRetrievalEnabled(makeEnv("shadow"))).toBe(true)
  })

  it("returns true for 'post'", () => {
    expect(graphRetrievalEnabled(makeEnv("post"))).toBe(true)
  })

  it("returns true for case-insensitive variants ('Shadow', 'POST')", () => {
    expect(graphRetrievalEnabled(makeEnv("Shadow"))).toBe(true)
    expect(graphRetrievalEnabled(makeEnv("POST"))).toBe(true)
  })

  it("returns false for 'off'", () => {
    expect(graphRetrievalEnabled(makeEnv("off"))).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(graphRetrievalEnabled(makeEnv(""))).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(graphRetrievalEnabled(makeEnv(undefined))).toBe(false)
  })

  it("returns false for an unrecognized value", () => {
    expect(graphRetrievalEnabled(makeEnv("on"))).toBe(false)
  })
})

describe("graphRetrievalMode", () => {
  const makeEnv = (v: string | undefined) =>
    ({ OPENCLAW_GRAPH_RETRIEVAL: v } as unknown as import("@/src/index").Env)

  it("returns 'shadow' for 'shadow'", () => {
    expect(graphRetrievalMode(makeEnv("shadow"))).toBe("shadow")
  })

  // SIG-143 landed: blast-radius name resolution (blastRadiusByNames) exists,
  // so BLAST_RADIUS_RESOLUTION_READY is true and a raw 'post' is honored as
  // 'post' (no longer coerced to 'shadow').
  it("returns 'post' for 'post' (SIG-143 landed: BLAST_RADIUS_RESOLUTION_READY is true)", () => {
    expect(BLAST_RADIUS_RESOLUTION_READY).toBe(true)
    expect(graphRetrievalMode(makeEnv("post"))).toBe("post")
  })

  it("returns 'off' for 'off'", () => {
    expect(graphRetrievalMode(makeEnv("off"))).toBe("off")
  })

  it("returns 'off' for undefined", () => {
    expect(graphRetrievalMode(makeEnv(undefined))).toBe("off")
  })

  it("returns 'off' for empty string", () => {
    expect(graphRetrievalMode(makeEnv(""))).toBe("off")
  })

  it("is case-insensitive: 'SHADOW' -> 'shadow', 'Post' -> 'post'", () => {
    expect(graphRetrievalMode(makeEnv("SHADOW"))).toBe("shadow")
    expect(graphRetrievalMode(makeEnv("Post"))).toBe("post")
  })
})

describe("formatGraphContext", () => {
  it("formats nodes as 'path (hopN, edgeKind)' lines joined by newline", () => {
    const nodes = [
      { path: "src/lib/foo.ts", hop: 1, edgeKind: "import" },
      { path: "src/lib/bar.ts", hop: 2, edgeKind: "same_file" },
    ]
    expect(formatGraphContext(nodes)).toBe(
      "src/lib/foo.ts (hop1, import)\nsrc/lib/bar.ts (hop2, same_file)",
    )
  })

  it("returns empty string for empty array", () => {
    expect(formatGraphContext([])).toBe("")
  })

  it("returns a single line with no trailing newline for one node", () => {
    const result = formatGraphContext([{ path: "src/x.ts", hop: 1, edgeKind: "export" }])
    expect(result).toBe("src/x.ts (hop1, export)")
    expect(result.endsWith("\n")).toBe(false)
  })
})

describe("formatGraphBlastContext", () => {
  it("formats callers before importers with role labels", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/caller.ts"],
      dependentPaths: ["src/dep.ts"],
      exclude: new Set<string>(),
      cap: 10,
    })
    expect(result).toBe("src/caller.ts (blast, caller)\nsrc/dep.ts (blast, importer)")
  })

  it("excludes paths already represented (seeds / graph nodes)", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/seen.ts", "src/new.ts"],
      dependentPaths: ["src/seen.ts"],
      exclude: new Set(["src/seen.ts"]),
      cap: 10,
    })
    expect(result).toBe("src/new.ts (blast, caller)")
  })

  it("dedups a path that is both a caller and a dependent", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/both.ts"],
      dependentPaths: ["src/both.ts"],
      exclude: new Set<string>(),
      cap: 10,
    })
    expect(result).toBe("src/both.ts (blast, caller)")
  })

  it("caps the number of emitted lines", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["a.ts", "b.ts", "c.ts"],
      dependentPaths: ["d.ts"],
      exclude: new Set<string>(),
      cap: 2,
    })
    expect(result.split("\n")).toHaveLength(2)
    expect(result).toBe("a.ts (blast, caller)\nb.ts (blast, caller)")
  })

  it("returns empty string when nothing new to add", () => {
    expect(formatGraphBlastContext({
      callerPaths: [],
      dependentPaths: [],
      exclude: new Set<string>(),
      cap: 4,
    })).toBe("")
  })
})

describe("graphOverlapStats", () => {
  it("computes jaccard and addedCount for overlapping sets", () => {
    // vector=[a,b], graph=[b,c]
    // intersection={b} (size 1), union={a,b,c} (size 3), jaccard=1/3
    // addedCount: paths in graph NOT in vector = [c] → 1
    const result = graphOverlapStats({ vectorPaths: ["a", "b"], graphPaths: ["b", "c"] })
    expect(result.jaccard).toBeCloseTo(1 / 3)
    expect(result.addedCount).toBe(1)
  })

  it("computes jaccard=0 and addedCount=N for disjoint sets", () => {
    // vector=[a], graph=[b,c] → intersection={}, union={a,b,c} (size 3)
    const result = graphOverlapStats({ vectorPaths: ["a"], graphPaths: ["b", "c"] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(2)
  })

  it("computes jaccard=1 and addedCount=0 for identical sets", () => {
    const result = graphOverlapStats({ vectorPaths: ["x", "y"], graphPaths: ["x", "y"] })
    expect(result.jaccard).toBe(1)
    expect(result.addedCount).toBe(0)
  })

  it("returns jaccard=0 and addedCount=0 for empty sets", () => {
    const result = graphOverlapStats({ vectorPaths: [], graphPaths: [] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(0)
  })

  it("computes correctly when vector is empty but graph has paths", () => {
    // union = graph paths, intersection = 0, jaccard = 0, addedCount = graph.length
    const result = graphOverlapStats({ vectorPaths: [], graphPaths: ["a", "b"] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(2)
  })

  it("computes correctly when graph is empty but vector has paths", () => {
    // union = vector paths, intersection = 0, jaccard = 0, addedCount = 0
    const result = graphOverlapStats({ vectorPaths: ["a", "b"], graphPaths: [] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(0)
  })

  it("deduplicates duplicate paths within each set for jaccard", () => {
    // vector=[a,a,b] → Set{a,b}, graph=[b,b,c] → Set{b,c}
    // intersection={b} (1), union={a,b,c} (3), jaccard=1/3
    const result = graphOverlapStats({ vectorPaths: ["a", "a", "b"], graphPaths: ["b", "b", "c"] })
    expect(result.jaccard).toBeCloseTo(1 / 3)
    expect(result.addedCount).toBe(1)
  })
})

// ─── SIG-138 Fix 1: GRAPH_RPC_TIMEOUT_MS budget constant ─────────────────────
//
// Validates that the graph RPC timeout constant is exported with a sensible
// default (tight enough to bound orchestrator wall time, generous enough for
// a healthy DO RPC).

describe("GRAPH_RPC_TIMEOUT_MS", () => {
  it("is exported and set to 2500 ms by default", () => {
    expect(GRAPH_RPC_TIMEOUT_MS).toBe(2_500)
  })

  it("is well below RETRIEVAL_PREFLIGHT_TIMEOUT_MS so a timed-out graph RPC cannot consume the full preflight budget", () => {
    expect(GRAPH_RPC_TIMEOUT_MS).toBeLessThan(RETRIEVAL_PREFLIGHT_TIMEOUT_MS)
  })
})

// SIG-216: post-emit scope normalization. LLM specialists sometimes
// emit `scope: "file"` for findings that have a concrete `(path, line)`
// AND that line falls within a reviewable diff hunk. The renderer
// routes any non-line scope into the Review Body section, losing the
// inline anchor (PR #173 regression). `validateForSubmission` flips
// the anchorable shape back to `scope: "line"` before any scope-
// dependent gate fires; PR-level, comment-scope, and non-anchorable
// file findings are left alone.
