import { describe, expect, it } from "vitest"
import {
  buildBranchChunks,
  mergeBranchAware,
  prepareBranchSet,
  retrieveBranchChunks,
  shouldRunBranchAwareRetrieval,
  type BranchVector,
} from "../src/lib/branch-retrieval"
import type { RetrievedChunk } from "../src/lib/retrieval"

function rc(path: string, a: number, b: number, score: number, content = "x"): RetrievedChunk {
  return { path, lineStart: a, lineEnd: b, content, score }
}

describe("mergeBranchAware", () => {
  it("drops ALL main chunks for a path that branch also has (head wins)", () => {
    const main = [rc("a.ts", 1, 30, 0.9, "STALE"), rc("a.ts", 20, 50, 0.8, "STALE2"), rc("b.ts", 1, 30, 0.7)]
    const branch = [rc("a.ts", 1, 30, 0.5, "HEAD")]
    const out = mergeBranchAware(main, branch)
    const aPaths = out.filter((c) => c.path === "a.ts")
    expect(aPaths).toHaveLength(1)
    expect(aPaths[0].content).toBe("HEAD")
    expect(out.some((c) => c.path === "b.ts")).toBe(true)
  })

  it("appends branch-only paths and re-ranks by score desc", () => {
    const main = [rc("b.ts", 1, 30, 0.4)]
    const branch = [rc("new.ts", 1, 30, 0.95, "NEW")]
    const out = mergeBranchAware(main, branch)
    expect(out.map((c) => c.path)).toEqual(["new.ts", "b.ts"])
  })

  it("handles empty sides", () => {
    expect(mergeBranchAware([], [])).toEqual([])
    expect(mergeBranchAware([rc("a.ts", 1, 2, 0.1)], [])).toHaveLength(1)
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
    expect(out[0].score).toBeCloseTo(1, 5)
    expect(out[1].score).toBeCloseTo(Math.SQRT1_2, 5)
    expect(out[0].content).toBe("NEAR")
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
    expect(set[0].vector).toHaveLength(768)
    expect(set[0].chunk.path).toBe("a.ts")
  })

  it("returns [] (never throws) when embedding fails", async () => {
    const ai = { run: async () => { throw new Error("AI down") } }
    await expect(prepareBranchSet(ai, files)).resolves.toEqual([])
  })

  it("returns [] for empty files without calling AI", async () => {
    let called = false
    const ai = { run: async () => { called = true; return { data: [] } } }
    expect(await prepareBranchSet(ai, new Map())).toEqual([])
    expect(called).toBe(false)
  })
})
