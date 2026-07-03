import { describe, expect, it } from "vitest"
import {
  buildBranchChunks,
  buildBranchRetrievalEvent,
  mergeBranchAware,
  prepareBranchSet,
  retrieveBranchChunks,
  shouldRunBranchAwareRetrieval,
  type BranchVector,
} from "@/src/lib/branch-retrieval"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import { embedText } from "@/src/shared/adapters/model"

function rc(path: string, a: number, b: number, score: number, content = "x"): RetrievedChunk {
  return { path, lineStart: a, lineEnd: b, content, score }
}

describe("mergeBranchAware", () => {
  it("drops ALL main chunks for a path that branch also has (head wins)", () => {
    const main = [rc("a.ts", 1, 30, 0.9, "STALE"), rc("a.ts", 20, 50, 0.8, "STALE2"), rc("b.ts", 1, 30, 0.7)]
    const branch = [rc("a.ts", 1, 30, 0.5, "HEAD")]
    const out = mergeBranchAware(main, branch, new Set(["a.ts"]))
    const aPaths = out.filter((c) => c.path === "a.ts")
    expect(aPaths).toHaveLength(1)
    expect(aPaths[0]!.content).toBe("HEAD")
    expect(out.some((c) => c.path === "b.ts")).toBe(true)
  })

  it("appends branch-only paths and re-ranks by score desc", () => {
    const main = [rc("b.ts", 1, 30, 0.4)]
    const branch = [rc("new.ts", 1, 30, 0.95, "NEW")]
    const out = mergeBranchAware(main, branch, new Set(["new.ts"]))
    expect(out.map((c) => c.path)).toEqual(["new.ts", "b.ts"])
  })

  it("handles empty sides", () => {
    expect(mergeBranchAware([], [], new Set())).toEqual([])
    expect(mergeBranchAware([rc("a.ts", 1, 2, 0.1)], [], new Set())).toHaveLength(1)
  })

  it("drops a changed-path main chunk even when no branch chunk surfaced (tombstone)", () => {
    const main = [rc("c.ts", 1, 30, 0.9, "STALE"), rc("keep.ts", 1, 30, 0.5)]
    const out = mergeBranchAware(main, [], new Set(["c.ts"]))
    expect(out.some((x) => x.path === "c.ts")).toBe(false)
    expect(out.some((x) => x.path === "keep.ts")).toBe(true)
  })

  it("never tombstones a cross-repo sibling chunk on a changed-path collision", () => {
    // A sibling repo's `src/index.ts` shares a path with the PR's changed
    // `src/index.ts`, but it is UNRELATED code — the `repo` tag exempts it from
    // the changed-path tombstone so valid cross-repo context is never dropped.
    const sibling: RetrievedChunk = { ...rc("src/index.ts", 1, 30, 0.4, "SIBLING"), repo: "acme/gadgets" }
    const main = [rc("src/index.ts", 1, 30, 0.9, "STALE_PRIMARY"), sibling]
    const out = mergeBranchAware(main, [], new Set(["src/index.ts"]))
    // Primary chunk on the changed path is tombstoned; the sibling survives.
    expect(out.some((c) => c.content === "STALE_PRIMARY")).toBe(false)
    expect(out.some((c) => c.repo === "acme/gadgets" && c.content === "SIBLING")).toBe(true)
  })
})

describe("buildBranchChunks", () => {
  it("chunks each changed file via the indexer chunker, tagging path", () => {
    const files = new Map<string, string>([
      ["src/new.ts", Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`).join("\n")],
    ])
    const chunks = buildBranchChunks(files)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.path === "src/new.ts")).toBe(true)
    expect(chunks.every((c) => typeof c.content === "string" && c.content.length > 0)).toBe(true)
  })

  it("caps total chunks at MAX_BRANCH_CHUNKS", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
    const files = new Map<string, string>([["src/huge.ts", big]])
    const chunks = buildBranchChunks(files)
    expect(chunks.length).toBeLessThanOrEqual(400)
  })

  it("returns [] for an empty map", () => {
    expect(buildBranchChunks(new Map())).toEqual([])
  })
})

function bv(path: string, a: number, b: number, vector: number[], content = "x"): BranchVector {
  return { chunk: { path, lineStart: a, lineEnd: b, content }, vector }
}

describe("retrieveBranchChunks", () => {
  it("ranks by cosine similarity to the query vector, returns RetrievedChunk[]", () => {
    const q = [1, 0, 0]
    const set: BranchVector[] = [
      bv("far.ts", 1, 2, [0, 1, 0], "FAR"),
      bv("near.ts", 1, 2, [2, 0, 0], "NEAR"),
      bv("mid.ts", 1, 2, [1, 1, 0], "MID"),
    ]
    const out = retrieveBranchChunks(q, set, 3)
    expect(out.map((c) => c.path)).toEqual(["near.ts", "mid.ts", "far.ts"])
    expect(out[0]!.score).toBeCloseTo(1, 5)
    expect(out[1]!.score).toBeCloseTo(Math.SQRT1_2, 5)
    expect(out[0]!.content).toBe("NEAR")
  })

  it("respects topK", () => {
    const q = [1, 0]
    const set: BranchVector[] = [bv("a.ts", 1, 1, [1, 0]), bv("b.ts", 1, 1, [0.9, 0.1]), bv("c.ts", 1, 1, [0.1, 0.9])]
    expect(retrieveBranchChunks(q, set, 2)).toHaveLength(2)
  })

  it("returns [] for empty set or zero-norm query", () => {
    expect(retrieveBranchChunks([1, 0], [], 5)).toEqual([])
    expect(retrieveBranchChunks([0, 0], [bv("a.ts", 1, 1, [1, 0])], 5)).toEqual([])
  })

  it("skips vectors that produce a non-finite score", () => {
    const q = [1, 0]
    const set = [
      bv("ok.ts", 1, 1, [1, 0], "OK"),
      bv("bad.ts", 1, 1, [Infinity, 0], "BAD"),
      bv("nan.ts", 1, 1, [NaN, 0], "NAN"),
    ]
    const out = retrieveBranchChunks(q, set, 5)
    expect(out.map((c) => c.path)).toEqual(["ok.ts"])
  })

  it("skips vectors whose dimension differs from the query", () => {
    const q = [1, 0, 0]
    const set = [bv("ok.ts", 1, 1, [1, 0, 0], "OK"), bv("bad.ts", 1, 1, [1, 0], "BAD")]
    const out = retrieveBranchChunks(q, set, 5)
    expect(out.map((c) => c.path)).toEqual(["ok.ts"])
  })
})

describe("shouldRunBranchAwareRetrieval", () => {
  const files = new Map([["a.ts", "const x = 1"]])
  it("on only when flag is 'on' and there is changed content", () => {
    expect(shouldRunBranchAwareRetrieval("on", files)).toBe(true)
    expect(shouldRunBranchAwareRetrieval("ON", files)).toBe(true)
    expect(shouldRunBranchAwareRetrieval("off", files)).toBe(false)
    expect(shouldRunBranchAwareRetrieval(undefined, files)).toBe(false)
    expect(shouldRunBranchAwareRetrieval("on", new Map())).toBe(false)
  })
})

describe("prepareBranchSet", () => {
  const files = new Map([["a.ts", "const x = 1\nconst y = 2"]])
  it("embeds chunks and returns BranchVector[] aligned to chunks", async () => {
    const ai = {
      run: async (_m: string, input: { text: string | string[] }) => {
        const texts = Array.isArray(input.text) ? input.text : [input.text]
        return { data: texts.map(() => Array.from({ length: 768 }, () => 0.01)) }
      },
    }
    const set = await prepareBranchSet(ai, files)
    expect(set.length).toBeGreaterThan(0)
    expect(set[0]!.vector).toHaveLength(768)
    expect(set[0]!.chunk.path).toBe("a.ts")
  })

  it("returns [] (never throws) when embedding fails", async () => {
    const ai = {
      run: async () => {
        throw new Error("AI down")
      },
    }
    await expect(prepareBranchSet(ai, files)).resolves.toEqual([])
  })

  it("returns [] for empty files without calling AI", async () => {
    let called = false
    const ai = {
      run: async () => {
        called = true
        return { data: [] }
      },
    }
    expect(await prepareBranchSet(ai, new Map())).toEqual([])
    expect(called).toBe(false)
  })
})

describe("SIG-129 acceptance: new exported symbol is retrievable + overrides stale main", () => {
  // Deterministic 768-dim bag-of-words embedder: hash each token to a slot.
  // Same vector space for chunk content and the query, so cosine similarity
  // is highest for the chunk that shares the most tokens with the query.
  const fakeAi = {
    run: async (_m: string, input: { text: string | string[] }) => {
      const texts = Array.isArray(input.text) ? input.text : [input.text]
      const embed = (t: string): number[] => {
        const v = new Array<number>(768).fill(0)
        for (const tok of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)) {
          let h = 0
          for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
          v[h % 768] = (v[h % 768] ?? 0) + 1
        }
        return v
      }
      return { data: texts.map(embed) }
    },
  }

  it("retrieves the branch-only symbol and the merge drops the stale main chunk", async () => {
    const files = new Map<string, string>([
      ["src/util.ts", "export function computeWasteFactor(width: number) {\n  return width * 0.0144\n}\n"],
    ])
    const branchVectors = await prepareBranchSet(fakeAi, files)
    expect(branchVectors.length).toBeGreaterThan(0)

    const qVec = await embedText(fakeAi, "where is computeWasteFactor defined")
    const branchChunks = retrieveBranchChunks(qVec, branchVectors, 6)
    expect(branchChunks[0]!.path).toBe("src/util.ts")
    expect(branchChunks[0]!.content).toContain("computeWasteFactor")

    // Stale main copy of the same path must be displaced by head content.
    const staleMain = [
      {
        path: "src/util.ts",
        lineStart: 1,
        lineEnd: 3,
        content: "// OLD — symbol absent",
        score: 0.99,
      },
    ]
    const merged = mergeBranchAware(staleMain, branchChunks, new Set(["src/util.ts"]))
    const utilChunks = merged.filter((c) => c.path === "src/util.ts")
    expect(utilChunks.every((c) => !c.content.includes("OLD"))).toBe(true)
    expect(utilChunks.some((c) => c.content.includes("computeWasteFactor"))).toBe(true)
  })
})

describe("buildBranchRetrievalEvent (SIG-86 telemetry shape)", () => {
  it("emits the pinned snake_case shape with a 7-char headSha", () => {
    const ev = buildBranchRetrievalEvent({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 123,
      headSha: "abcdef1234567890",
      branchChunkCount: 12,
      embedElapsedMs: 340,
      headOverride: { preflight: 2, perf: 1, symbol: 3 },
    })
    expect(ev).toEqual({
      event: "pr-review-branch-retrieval",
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 123,
      headSha: "abcdef1",
      branch_chunk_count: 12,
      embed_elapsed_ms: 340,
      head_override_preflight: 2,
      head_override_perf: 1,
      head_override_symbol: 3,
    })
  })
})
