// SIG-45 — lexical (BM25 / FTS5) retrieval backend unit tests.

import { describe, it, expect, beforeEach } from "vitest"
import { makeD1, FTS5_AVAILABLE } from "@/src/test-shims/d1-sqlite-shim"
import {
  hybridRetrievalEnabled,
  buildFtsQuery,
  reciprocalRankFusion,
  upsertLexicalChunks,
  queryLexical,
  deleteLexicalNamespace,
  _resetSchemaMemoForTests,
  type LexicalChunk,
  type RankedItem,
} from "@/src/lib/lexical-index"

beforeEach(() => {
  _resetSchemaMemoForTests()
})

function chunk(over: Partial<LexicalChunk> & { id: string; content: string }): LexicalChunk {
  return {
    namespace: "acme/widgets",
    path: "src/foo.ts",
    lineStart: 1,
    lineEnd: 10,
    ...over,
  }
}

describe("hybridRetrievalEnabled", () => {
  const db = makeD1()
  it("is on only when flag === 'on' AND a D1 binding exists", () => {
    expect(hybridRetrievalEnabled({ OPENCLAW_RETRIEVAL_HYBRID: "on", OPENCLAW_LEXICAL_INDEX: db })).toBe(true)
    expect(hybridRetrievalEnabled({ OPENCLAW_RETRIEVAL_HYBRID: "ON ", OPENCLAW_LEXICAL_INDEX: db })).toBe(true)
  })
  it("is off when the flag is unset/other or the binding is missing", () => {
    expect(hybridRetrievalEnabled({ OPENCLAW_LEXICAL_INDEX: db })).toBe(false)
    expect(hybridRetrievalEnabled({ OPENCLAW_RETRIEVAL_HYBRID: "shadow", OPENCLAW_LEXICAL_INDEX: db })).toBe(false)
    expect(hybridRetrievalEnabled({ OPENCLAW_RETRIEVAL_HYBRID: "on" })).toBe(false)
  })
})

describe("buildFtsQuery", () => {
  it("tokenizes and quotes terms, OR-joined", () => {
    expect(buildFtsQuery("retryWithBackoff helper")).toBe('"retrywithbackoff" OR "helper"')
  })
  it("neutralizes FTS5 operator characters", () => {
    // user-id, a stray quote, AND as a bareword — none should become operators
    expect(buildFtsQuery('user-id "AND drop')).toBe('"user" OR "id" OR "and" OR "drop"')
  })
  it("drops sub-2-char noise and dedupes", () => {
    expect(buildFtsQuery("a b foo foo")).toBe('"foo"')
  })
  it("returns null when nothing usable survives", () => {
    expect(buildFtsQuery("   ! ? -")).toBeNull()
    expect(buildFtsQuery("")).toBeNull()
  })
})

describe("reciprocalRankFusion", () => {
  it("ranks an item appearing in both lists above single-list items", () => {
    const vector: RankedItem<string>[] = [
      { key: "a", item: "a" },
      { key: "b", item: "b" },
    ]
    const lexical: RankedItem<string>[] = [
      { key: "c", item: "c" },
      { key: "a", item: "a" },
    ]
    const fused = reciprocalRankFusion([vector, lexical])
    expect(fused[0]!.item).toBe("a") // in both lists → highest summed RRF
    expect(fused.map((f) => f.item).sort()).toEqual(["a", "b", "c"])
  })
  it("dedupes by key (no duplicate output rows)", () => {
    const fused = reciprocalRankFusion([[{ key: "x", item: 1 }], [{ key: "x", item: 99 }]])
    expect(fused).toHaveLength(1)
    expect(fused[0]!.item).toBe(1) // first-seen payload wins
  })
  it("breaks score ties by first-seen order", () => {
    const fused = reciprocalRankFusion([
      [
        { key: "p", item: "p" },
        { key: "q", item: "q" },
      ],
    ])
    expect(fused.map((f) => f.item)).toEqual(["p", "q"])
  })
})

// Skipped on a node:sqlite build compiled WITHOUT FTS5 ("no such module: fts5");
// CI's Node ships FTS5 so it runs there. Keeps the suite green on a no-FTS5 local Node.
describe.skipIf(!FTS5_AVAILABLE)("lexical D1 round-trip (FTS5/BM25)", () => {
  it("writes chunks and retrieves them by BM25 relevance, scoped to namespace", async () => {
    const db = makeD1()
    const ok = await upsertLexicalChunks(db, [
      chunk({
        id: "1",
        path: "src/retry.ts",
        content: "export function retryWithBackoff(fn) { /* exponential */ }",
      }),
      chunk({ id: "2", path: "src/log.ts", content: "console.log('unrelated logging helper')" }),
      chunk({
        id: "3",
        namespace: "other/repo",
        path: "x.ts",
        content: "retryWithBackoff in another repo",
      }),
    ])
    expect(ok).toBe(true)

    const hits = await queryLexical(db, "acme/widgets", "retryWithBackoff", 10)
    expect(hits.map((h) => h.id)).toContain("1")
    // namespace scoping: the other-repo chunk id "3" must not appear
    expect(hits.map((h) => h.id)).not.toContain("3")
    // BM25: the retry chunk outranks the logging chunk for this query
    expect(hits[0]!.id).toBe("1")
    expect(hits[0]!.path).toBe("src/retry.ts")
    expect(hits[0]!.lineStart).toBe(1)
  })

  it("is idempotent across re-write of the same id (DELETE-then-INSERT)", async () => {
    const db = makeD1()
    await upsertLexicalChunks(db, [chunk({ id: "1", content: "first version alpha" })])
    await upsertLexicalChunks(db, [chunk({ id: "1", content: "second version beta" })])
    const all = await queryLexical(db, "acme/widgets", "version", 10)
    expect(all.filter((h) => h.id === "1")).toHaveLength(1)
    expect(all[0]!.content).toContain("second")
  })

  it("deletes a namespace without touching others", async () => {
    const db = makeD1()
    await upsertLexicalChunks(db, [
      chunk({ id: "1", content: "keepme widget code" }),
      chunk({ id: "2", namespace: "other/repo", content: "keepme other code" }),
    ])
    const removed = await deleteLexicalNamespace(db, "acme/widgets")
    expect(removed).toBe(1)
    expect(await queryLexical(db, "acme/widgets", "keepme", 10)).toHaveLength(0)
    expect((await queryLexical(db, "other/repo", "keepme", 10)).map((h) => h.id)).toEqual(["2"])
  })

  it("returns [] for an unmatchable query rather than throwing", async () => {
    const db = makeD1()
    await upsertLexicalChunks(db, [chunk({ id: "1", content: "alpha beta gamma" })])
    expect(await queryLexical(db, "acme/widgets", "zzznotpresent", 10)).toEqual([])
    expect(await queryLexical(db, "acme/widgets", "!", 10)).toEqual([])
  })
})
