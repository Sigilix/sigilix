// SIG-45 — hybrid retrieval integration: vector + lexical fused via RRF
// through the real retrieveChunks() entry point. Vector (Vectorize) and
// Workers AI are stubbed; the lexical leg uses the in-memory D1/FTS5 shim.

import { describe, it, expect, beforeEach } from "vitest"
import { retrieveChunks, fuseRetrieval, type RetrievedChunk, type RetrievalEnv } from "../src/lib/retrieval"
import { upsertLexicalChunks, _resetSchemaMemoForTests, type LexicalMatch } from "../src/lib/lexical-index"
import { makeD1 } from "./_shims/d1-sqlite-shim"

const EMBED_DIMS = 768

beforeEach(() => _resetSchemaMemoForTests())

function vectorMatch(id: string, path: string, content: string, score: number) {
  return {
    id,
    score,
    metadata: { repo: "acme/widgets", path, lineStart: 1, lineEnd: 10, content },
  }
}

/** Build a RetrievalEnv whose Vectorize stub returns a fixed match list. */
function makeEnv(opts: {
  vectorMatches: ReturnType<typeof vectorMatch>[]
  hybrid?: boolean
  lexicalDb?: ReturnType<typeof makeD1>
}): RetrievalEnv {
  return {
    AI: {
      run: async () => ({ data: [Array(EMBED_DIMS).fill(0.1)], shape: [1, EMBED_DIMS] }),
    },
    OPENCLAW_CODE_INDEX: {
      query: async () => ({ matches: opts.vectorMatches }),
    },
    OPENCLAW_LEXICAL_INDEX: opts.lexicalDb,
    OPENCLAW_RETRIEVAL_HYBRID: opts.hybrid ? "on" : undefined,
  } as unknown as RetrievalEnv
}

describe("retrieveChunks — vector-only (flag off)", () => {
  it("returns vector chunks untouched, no source tag mutation", async () => {
    const env = makeEnv({
      vectorMatches: [vectorMatch("v1", "src/a.ts", "alpha", 0.9)],
    })
    const out = await retrieveChunks({ text: "alpha query", teamKey: "acme/widgets", env })
    expect(out).toHaveLength(1)
    expect(out[0]!.source).toBe("vector")
    expect(out[0]!.rrfScore).toBeUndefined()
  })
})

describe("retrieveChunks — hybrid (flag on)", () => {
  it("fuses vector + lexical and marks a shared chunk 'hybrid'", async () => {
    const db = makeD1()
    // Lexical index has the SAME id as a vector hit (shared) plus a lexical-only hit.
    await upsertLexicalChunks(db, [
      { id: "shared", namespace: "acme/widgets", path: "src/shared.ts", lineStart: 1, lineEnd: 10, content: "retryWithBackoff exponential helper" },
      { id: "lexonly", namespace: "acme/widgets", path: "src/lex.ts", lineStart: 1, lineEnd: 5, content: "retryWithBackoff lexical only match" },
    ])
    const env = makeEnv({
      hybrid: true,
      lexicalDb: db,
      vectorMatches: [
        vectorMatch("shared", "src/shared.ts", "retryWithBackoff exponential helper", 0.8),
        vectorMatch("veconly", "src/vec.ts", "semantic only neighbour", 0.7),
      ],
    })
    const out = await retrieveChunks({ text: "retryWithBackoff", teamKey: "acme/widgets", env })
    const byId = new Map(out.map((c) => [c.id, c]))
    expect(byId.get("shared")!.source).toBe("hybrid")
    expect(byId.get("veconly")!.source).toBe("vector")
    expect(byId.get("lexonly")!.source).toBe("lexical")
    // The chunk in BOTH backends should rank first (highest summed RRF).
    expect(out[0]!.id).toBe("shared")
    expect(out[0]!.rrfScore).toBeGreaterThan(0)
  })

  it("degrades to lexical-only when the vector query throws", async () => {
    const db = makeD1()
    await upsertLexicalChunks(db, [
      { id: "lex1", namespace: "acme/widgets", path: "src/l.ts", lineStart: 1, lineEnd: 3, content: "needle in the lexical haystack" },
    ])
    const env = {
      AI: { run: async () => ({ data: [Array(EMBED_DIMS).fill(0.1)] }) },
      OPENCLAW_CODE_INDEX: { query: async () => { throw new Error("vectorize down") } },
      OPENCLAW_LEXICAL_INDEX: db,
      OPENCLAW_RETRIEVAL_HYBRID: "on",
    } as unknown as RetrievalEnv
    const out = await retrieveChunks({ text: "needle", teamKey: "acme/widgets", env })
    expect(out.map((c) => c.id)).toContain("lex1")
    expect(out[0]!.source).toBe("lexical")
  })
})

describe("fuseRetrieval (pure)", () => {
  it("dedupes by path:line when ids are absent", () => {
    const vector: RetrievedChunk[] = [
      { path: "src/x.ts", lineStart: 1, lineEnd: 9, content: "x", score: 0.5 },
    ]
    const lexical: LexicalMatch[] = [
      { id: "", path: "src/x.ts", lineStart: 1, lineEnd: 9, content: "x", score: -1 },
    ]
    const fused = fuseRetrieval(vector, lexical, "acme/widgets")
    expect(fused).toHaveLength(1)
    expect(fused[0]!.source).toBe("hybrid")
  })
})
