// SIG-407 PR-2 — mention-path symbol expander tests.
//
// `expandHitsToSymbols` resolves retrieval hits to enclosing symbols via the
// (PR-1) DO method `enclosingSymbolsForHitsFor` — STUBBED here with canned
// `GraphHitExpansion` — then runs the REAL `buildGraphContextExpansion` over a
// real (canned) `fetchFileContent`, and renders a mention-specific block. We
// stub only the DO boundary; the body-slice + cross-file fetch machinery runs
// for real so the test covers the actual integration (incl. the def-prefetch
// fix that keeps definitions from starving behind the caller fetch budget).

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GraphHitExpansion, GraphDefinitionRow, GraphCallerRow } from "@/src/do/repo-graph"

// Stub the DO client boundary. The expander calls enclosingSymbolsForHitsFor.
const { mockEnclosing } = vi.hoisted(() => ({
  mockEnclosing: vi.fn(),
}))
vi.mock("@/src/lib/repo-graph-client", () => ({
  enclosingSymbolsForHitsFor: (...args: unknown[]) => mockEnclosing(...args),
}))

import {
  expandHitsToSymbols,
  renderMentionSymbolBlock,
  supersededHitKeys,
  hitKey,
  definitionPrefetchPaths,
  MAX_EXPANDED_SYMBOLS,
  MAX_CALLER_BODIES,
} from "@/src/lib/symbol-expansion"
import type { GraphBodySnippet } from "@/src/lib/graph-context-expansion"
import { MAX_CROSS_FILE_FETCHES } from "@/src/lib/graph-context-expansion"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { Env } from "@/src/shared/types/env"

const ENV = {} as Env

// ─── Fixtures ───────────────────────────────────────────────────────

function hitExp(over: Partial<GraphHitExpansion> = {}): GraphHitExpansion {
  return {
    graphAvailable: true,
    headSha: "abc1234deadbeef",
    definitionRows: [],
    callerRows: [],
    importRows: [],
    ...over,
  }
}

function defRow(over: Partial<GraphDefinitionRow> = {}): GraphDefinitionRow {
  return {
    symbolId: "src/billing.ts function applyRefund 10 0",
    path: "src/billing.ts",
    name: "applyRefund",
    kind: "function",
    startLine: 10,
    endLine: 24,
    ...over,
  }
}

function callerRow(over: Partial<GraphCallerRow> = {}): GraphCallerRow {
  return {
    sourcePath: "src/checkout.ts",
    calleeName: "applyRefund",
    callKind: "imported_binding",
    startLine: 40,
    startCol: 2,
    callerSymbolId: "src/checkout.ts function handleCheckout 30 0",
    callerStartLine: 30,
    callerEndLine: 50,
    ...over,
  }
}

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    path: "src/billing.ts",
    lineStart: 14,
    lineEnd: 18,
    content: "  // a 5-line slice inside applyRefund",
    score: 0.9,
    ...over,
  }
}

function snippet(over: Partial<GraphBodySnippet> = {}): GraphBodySnippet {
  return {
    path: "src/billing.ts",
    startLine: 10,
    endLine: 24,
    subject: "function applyRefund",
    source: "filesByPath",
    text: "10 | function applyRefund() {}",
    ...over,
  }
}

// Source files large enough that the symbol spans have room.
const SRC_BILLING = Array.from({ length: 40 }, (_, i) => `// billing line ${i + 1}`).join("\n")
const SRC_CHECKOUT = Array.from({ length: 60 }, (_, i) => `// checkout line ${i + 1}`).join("\n")

function fetcherFor(files: Record<string, string>): {
  fn: (path: string) => Promise<string | null>
  calls: string[]
} {
  const calls: string[] = []
  const fn = async (path: string): Promise<string | null> => {
    calls.push(path)
    return files[path] ?? null
  }
  return { fn, calls }
}

beforeEach(() => {
  mockEnclosing.mockReset()
})

// ─── Pure unit: hitKey ──────────────────────────────────────────────

describe("hitKey", () => {
  it("formats path:start-end", () => {
    expect(hitKey({ path: "src/a.ts", lineStart: 3, lineEnd: 9 })).toBe("src/a.ts:3-9")
  })
})

// ─── Pure unit: definitionPrefetchPaths ─────────────────────────────

describe("definitionPrefetchPaths", () => {
  it("returns distinct paths in row order", () => {
    const paths = definitionPrefetchPaths([
      { path: "src/a.ts" },
      { path: "src/b.ts" },
      { path: "src/a.ts" }, // dup
    ])
    expect(paths).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("caps at MAX_EXPANDED_SYMBOLS distinct paths", () => {
    const rows = Array.from({ length: MAX_EXPANDED_SYMBOLS + 5 }, (_, i) => ({ path: `src/f${i}.ts` }))
    const paths = definitionPrefetchPaths(rows)
    expect(paths).toHaveLength(MAX_EXPANDED_SYMBOLS)
    expect(paths[0]).toBe("src/f0.ts")
  })
})

// ─── Pure unit: renderMentionSymbolBlock ────────────────────────────

describe("renderMentionSymbolBlock", () => {
  it("renders the mention header + def snippet, returns the full symbol body", () => {
    const block = renderMentionSymbolBlock(
      [snippet({ text: "10 | function applyRefund() {\n11 |   return 1\n12 | }" })],
      [],
    )
    expect(block).not.toBeNull()
    expect(block).toContain("[SYMBOL CONTEXT — expanded from your question's matches]")
    expect(block).toContain("src/billing.ts:10-24 — function applyRefund")
    // the WHOLE symbol body (small-to-big), not a slice
    expect(block).toContain("function applyRefund() {")
    expect(block).toContain("return 1")
  })

  it("renders a [CALLERS] section when callers are present", () => {
    const block = renderMentionSymbolBlock(
      [snippet()],
      [
        snippet({
          path: "src/checkout.ts",
          startLine: 30,
          endLine: 50,
          subject: "call applyRefund (imported_binding)",
        }),
      ],
    )
    expect(block).toContain("[CALLERS]")
    expect(block).toContain("src/checkout.ts:30-50 — call applyRefund (imported_binding)")
  })

  it("caps def bodies at MAX_EXPANDED_SYMBOLS and callers at MAX_CALLER_BODIES", () => {
    const defs = Array.from({ length: MAX_EXPANDED_SYMBOLS + 3 }, (_, i) =>
      snippet({ path: `src/d${i}.ts`, subject: `function d${i}`, text: `1 | d${i}` }),
    )
    const callers = Array.from({ length: MAX_CALLER_BODIES + 3 }, (_, i) =>
      snippet({ path: `src/c${i}.ts`, subject: `call c${i}`, text: `1 | c${i}` }),
    )
    const block = renderMentionSymbolBlock(defs, callers) ?? ""
    // present within cap
    expect(block).toContain("function d0")
    expect(block).toContain(`function d${MAX_EXPANDED_SYMBOLS - 1}`)
    expect(block).toContain("call c0")
    expect(block).toContain(`call c${MAX_CALLER_BODIES - 1}`)
    // beyond cap dropped
    expect(block).not.toContain(`function d${MAX_EXPANDED_SYMBOLS}`)
    expect(block).not.toContain(`call c${MAX_CALLER_BODIES}`)
  })

  it("returns null when there are no def or caller bodies", () => {
    expect(renderMentionSymbolBlock([], [])).toBeNull()
  })

  it("never emits review-only phrasing", () => {
    const block = renderMentionSymbolBlock([snippet()], [snippet({ subject: "call x" })]) ?? ""
    expect(block).not.toContain("not in this diff")
    expect(block).not.toContain("do not flag findings")
    expect(block).not.toContain("CROSS-FILE")
  })
})

// ─── Pure unit: supersededHitKeys ───────────────────────────────────

describe("supersededHitKeys", () => {
  it("marks a hit contained by a rendered def body on the same path", () => {
    const keys = supersededHitKeys(
      [{ path: "src/billing.ts", lineStart: 14, lineEnd: 18 }],
      [snippet({ startLine: 10, endLine: 24 })],
    )
    expect(keys).toEqual(["src/billing.ts:14-18"])
  })

  it("does NOT mark a hit on a different path", () => {
    const keys = supersededHitKeys(
      [{ path: "src/other.ts", lineStart: 14, lineEnd: 18 }],
      [snippet({ path: "src/billing.ts", startLine: 10, endLine: 24 })],
    )
    expect(keys).toEqual([])
  })

  it("does NOT mark a hit only partially overlapping the def body", () => {
    const keys = supersededHitKeys(
      // hit extends past the def's endLine (24)
      [{ path: "src/billing.ts", lineStart: 20, lineEnd: 30 }],
      [snippet({ startLine: 10, endLine: 24 })],
    )
    expect(keys).toEqual([])
  })

  it("dedupes repeated hit keys", () => {
    const keys = supersededHitKeys(
      [
        { path: "src/billing.ts", lineStart: 14, lineEnd: 18 },
        { path: "src/billing.ts", lineStart: 14, lineEnd: 18 },
      ],
      [snippet({ startLine: 10, endLine: 24 })],
    )
    expect(keys).toEqual(["src/billing.ts:14-18"])
  })

  it("returns [] for empty inputs", () => {
    expect(supersededHitKeys([], [snippet()])).toEqual([])
    expect(supersededHitKeys([{ path: "x", lineStart: 1, lineEnd: 2 }], [])).toEqual([])
  })
})

// ─── Integration: expandHitsToSymbols (real buildGraphContextExpansion) ───

describe("expandHitsToSymbols", () => {
  it("empty hits → EMPTY, no DO call", async () => {
    const { fn } = fetcherFor({})
    const result = await expandHitsToSymbols({ env: ENV, owner: "o", repo: "r", hits: [], fetchFileContent: fn })
    expect(result.block).toBeNull()
    expect(result.headSha).toBeNull()
    expect(result.telemetry.graphAvailable).toBe(false)
    expect(mockEnclosing).not.toHaveBeenCalled()
  })

  it("graphAvailable=false → EMPTY (surfaces headSha=null)", async () => {
    mockEnclosing.mockResolvedValue(hitExp({ graphAvailable: false, headSha: null, definitionRows: [defRow()] }))
    const { fn, calls } = fetcherFor({ "src/billing.ts": SRC_BILLING })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.block).toBeNull()
    expect(result.headSha).toBeNull()
    expect(result.telemetry.graphAvailable).toBe(false)
    // no prefetch when graph unavailable
    expect(calls).toEqual([])
  })

  it("block contains the FULL symbol body (small-to-big), not the hit slice", async () => {
    mockEnclosing.mockResolvedValue(hitExp({ definitionRows: [defRow({ startLine: 5, endLine: 30 })] }))
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk({ lineStart: 14, lineEnd: 18 })],
      fetchFileContent: fn,
    })
    expect(result.block).not.toBeNull()
    expect(result.block).toContain("[SYMBOL CONTEXT — expanded from your question's matches]")
    expect(result.block).toContain("src/billing.ts:5-30 — function applyRefund")
    // the whole 5..30 span is rendered (numbered), e.g. lines well outside 14..18
    expect(result.block).toContain("billing line 5")
    expect(result.block).toContain("billing line 30")
    expect(result.telemetry.symbolsExpanded).toBe(1)
    expect(result.telemetry.graphAvailable).toBe(true)
  })

  it("PREFETCHES definition files so they DON'T starve behind a saturated caller budget", async () => {
    // The regression that the def-prefetch fixes (spec §3): buildGraphContextExpansion
    // queues CALLER cross-file fetches FIRST and definition paths LAST, capped at
    // MAX_CROSS_FILE_FETCHES. Here we SATURATE that budget with MAX_CROSS_FILE_FETCHES+1
    // distinct caller files, all in a DIFFERENT file than the definition. Without the
    // def-prefetch the definition file would be queued past the cap and never fetched →
    // no def body. The def renders ONLY because we pre-fetch it into filesByPath, so
    // this test goes RED if the prefetch is removed.
    const callerFiles: Record<string, string> = {}
    const callerRows: GraphCallerRow[] = []
    for (let i = 0; i < MAX_CROSS_FILE_FETCHES + 1; i++) {
      const path = `src/caller${i}.ts`
      callerFiles[path] = SRC_CHECKOUT
      callerRows.push(
        callerRow({ sourcePath: path, calleeName: "computeRefund", callerStartLine: 30, callerEndLine: 50 }),
      )
    }
    mockEnclosing.mockResolvedValue(
      hitExp({
        definitionRows: [
          defRow({
            symbolId: "src/refunds.ts function computeRefund 5 0",
            path: "src/refunds.ts",
            startLine: 5,
            endLine: 15,
            name: "computeRefund",
          }),
        ],
        callerRows,
      }),
    )
    const { fn, calls } = fetcherFor({
      ...callerFiles,
      "src/refunds.ts": Array.from({ length: 20 }, (_, i) => `// refunds line ${i + 1}`).join("\n"),
    })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk({ path: "src/refunds.ts", lineStart: 7, lineEnd: 9 })],
      fetchFileContent: fn,
    })
    // The def file was fetched (via the prefetch) and its body rendered, even though
    // the caller budget alone (MAX_CROSS_FILE_FETCHES+1 files) would have crowded it out.
    expect(calls).toContain("src/refunds.ts")
    expect(result.block).toContain("function computeRefund")
    expect(result.telemetry.symbolsExpanded).toBe(1)
  })

  it("counts the definition pre-fetch in fetchedFiles/fetchBytes telemetry", async () => {
    // The def files land in filesByPath (so buildGraphContextExpansion reports them as
    // filesByPath-sourced, NOT in enriched.fetch). The expander must fold the prefetch
    // back into the surfaced IO telemetry or it undercounts the dominant fetch source.
    const refundsSrc = Array.from({ length: 20 }, (_, i) => `// refunds line ${i + 1}`).join("\n")
    mockEnclosing.mockResolvedValue(
      hitExp({
        definitionRows: [
          defRow({ path: "src/billing.ts", startLine: 5, endLine: 20, name: "applyRefund" }),
          defRow({
            symbolId: "src/refunds.ts function computeRefund 5 0",
            path: "src/refunds.ts",
            startLine: 5,
            endLine: 15,
            name: "computeRefund",
          }),
        ],
      }),
    )
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING, "src/refunds.ts": refundsSrc })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk({ path: "src/billing.ts", lineStart: 7, lineEnd: 9 })],
      fetchFileContent: fn,
    })
    // both definition files counted (cross-file fetch contributes 0 here)
    expect(result.telemetry.fetchedFiles).toBe(2)
    const expectedBytes = new TextEncoder().encode(SRC_BILLING).length + new TextEncoder().encode(refundsSrc).length
    expect(result.telemetry.fetchBytes).toBe(expectedBytes)
  })

  it("does NOT fetch importer files (import-dependents are never rendered in the mention block)", async () => {
    mockEnclosing.mockResolvedValue(
      hitExp({
        definitionRows: [defRow({ startLine: 5, endLine: 20 })],
        importRows: [{ sourcePath: "src/importer.ts", importedName: "applyRefund", startLine: 3 }],
      }),
    )
    const { fn, calls } = fetcherFor({ "src/billing.ts": SRC_BILLING, "src/importer.ts": SRC_CHECKOUT })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    // importer file never fetched (importRows dropped before the build)
    expect(calls).not.toContain("src/importer.ts")
    expect(result.block).not.toContain("src/importer.ts")
  })

  it("caps def rows BEFORE the byte cap so discarded defs can't crowd out callers", async () => {
    // MAX_EXPANDED_SYMBOLS+4 distinct def files, each a LARGE body, plus a caller in
    // a separate file. The build's byte cap renders definitions first and drops the
    // caller tail when the budget is tight — so if we passed ALL def rows the
    // never-rendered surplus defs would eat the budget and the caller would vanish.
    // Capping def rows to MAX_EXPANDED_SYMBOLS up front (with a generous maxBytes)
    // leaves room for the caller. We assert the caller renders.
    const bigBody = Array.from({ length: 30 }, (_, i) => `// big body line ${i + 1}`).join("\n")
    const defFiles: Record<string, string> = {}
    const definitionRows = []
    for (let i = 0; i < MAX_EXPANDED_SYMBOLS + 4; i++) {
      const path = `src/def${i}.ts`
      defFiles[path] = bigBody
      definitionRows.push(
        defRow({ symbolId: `${path} function f${i} 1 0`, path, name: `f${i}`, startLine: 1, endLine: 30 }),
      )
    }
    mockEnclosing.mockResolvedValue(
      hitExp({
        definitionRows,
        callerRows: [callerRow({ sourcePath: "src/checkout.ts", callerStartLine: 30, callerEndLine: 50 })],
      }),
    )
    const { fn, calls } = fetcherFor({ ...defFiles, "src/checkout.ts": SRC_CHECKOUT })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk({ path: "src/def0.ts", lineStart: 2, lineEnd: 4 })],
      fetchFileContent: fn,
      maxBytes: 50_000,
    })
    // only MAX_EXPANDED_SYMBOLS def files fetched (surplus rows dropped, not fetched)
    expect(result.telemetry.symbolsExpanded).toBe(MAX_EXPANDED_SYMBOLS)
    expect(calls).not.toContain(`src/def${MAX_EXPANDED_SYMBOLS}.ts`)
    // the caller survives because the discarded defs never consumed budget
    expect(result.telemetry.callersRendered).toBe(1)
    expect(result.block).toContain("[CALLERS]")
  })

  it("short-circuits to EMPTY (no fetch) when the signal is already aborted, preserving headSha", async () => {
    mockEnclosing.mockResolvedValue(
      hitExp({ headSha: "abortsha1", definitionRows: [defRow({ startLine: 5, endLine: 20 })] }),
    )
    const { fn, calls } = fetcherFor({ "src/billing.ts": SRC_BILLING })
    const controller = new AbortController()
    controller.abort()
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
      signal: controller.signal,
    })
    expect(result.block).toBeNull()
    // graph WAS available → surface it (and the sha) even though we did no work
    expect(result.headSha).toBe("abortsha1")
    expect(result.telemetry.graphAvailable).toBe(true)
    expect(calls).toEqual([])
  })

  it("preserves headSha/graphAvailable on a downstream fetch failure", async () => {
    // DO succeeds with a real sha; every fetch then fails. The per-call .catch makes
    // the def unsourceable (null block), but the now-known sha + graphAvailable must
    // still be surfaced for PR-3's drift policy — NOT reset to EMPTY's null/false.
    mockEnclosing.mockResolvedValue(
      hitExp({ headSha: "survivesha", definitionRows: [defRow({ startLine: 5, endLine: 20 })] }),
    )
    const fn = async (_path: string): Promise<string | null> => {
      throw new Error("boom 500")
    }
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.block).toBeNull()
    expect(result.headSha).toBe("survivesha")
    expect(result.telemetry.graphAvailable).toBe(true)
  })

  it("renders callers from a cross-file fetch and surfaces headSha", async () => {
    mockEnclosing.mockResolvedValue(
      hitExp({
        headSha: "deadbeefcafe",
        definitionRows: [defRow({ startLine: 5, endLine: 20 })],
        callerRows: [callerRow({ sourcePath: "src/checkout.ts", callerStartLine: 30, callerEndLine: 50 })],
      }),
    )
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING, "src/checkout.ts": SRC_CHECKOUT })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.headSha).toBe("deadbeefcafe")
    expect(result.block).toContain("[CALLERS]")
    expect(result.block).toContain("src/checkout.ts:30-50 — call applyRefund (imported_binding)")
    expect(result.telemetry.callersRendered).toBe(1)
  })

  it("caps callers rendered at MAX_CALLER_BODIES", async () => {
    const callers = Array.from({ length: MAX_CALLER_BODIES + 4 }, (_, i) =>
      callerRow({
        // all in the SAME file so the single cross-file fetch covers them and the
        // cap is about render count, not fetch budget
        sourcePath: "src/checkout.ts",
        startLine: 30 + i,
        callerStartLine: 30 + i,
        callerEndLine: 32 + i,
      }),
    )
    mockEnclosing.mockResolvedValue(
      hitExp({ definitionRows: [defRow({ startLine: 5, endLine: 20 })], callerRows: callers }),
    )
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING, "src/checkout.ts": SRC_CHECKOUT })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.telemetry.callersRendered).toBe(MAX_CALLER_BODIES)
  })

  it("supersededHitKeys is correct (contained vs not) through the real pipeline", async () => {
    mockEnclosing.mockResolvedValue(hitExp({ definitionRows: [defRow({ startLine: 10, endLine: 24 })] }))
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [
        chunk({ path: "src/billing.ts", lineStart: 14, lineEnd: 18 }), // contained → superseded
        chunk({ path: "src/billing.ts", lineStart: 30, lineEnd: 35 }), // outside → not
        chunk({ path: "src/other.ts", lineStart: 14, lineEnd: 18 }), // other file → not
      ],
      fetchFileContent: fn,
    })
    expect(result.supersededHitKeys).toEqual(["src/billing.ts:14-18"])
    expect(result.telemetry.superseded).toBe(1)
  })

  it("returns null block when no def/caller bodies survive (graph available but no symbol)", async () => {
    // graphAvailable true but the DO resolved no rows (no hit landed in a symbol)
    mockEnclosing.mockResolvedValue(hitExp({ headSha: "abc999", definitionRows: [], callerRows: [], importRows: [] }))
    const { fn } = fetcherFor({})
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.block).toBeNull()
    expect(result.headSha).toBe("abc999")
    expect(result.telemetry.graphAvailable).toBe(true)
    expect(result.telemetry.symbolsExpanded).toBe(0)
  })

  it("soft-fails a fetch error: no throw, def with failed fetch is omitted", async () => {
    mockEnclosing.mockResolvedValue(hitExp({ definitionRows: [defRow({ startLine: 5, endLine: 20 })] }))
    const fn = async (_path: string): Promise<string | null> => {
      throw new Error("boom 500")
    }
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    // did not throw; the def could not be sourced → no body → null block
    expect(result.block).toBeNull()
    expect(result.telemetry.symbolsExpanded).toBe(0)
  })

  it("never throws when the DO call rejects → EMPTY", async () => {
    mockEnclosing.mockRejectedValue(new Error("DO unavailable"))
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    expect(result.block).toBeNull()
    expect(result.headSha).toBeNull()
    expect(result.telemetry.graphAvailable).toBe(false)
  })

  it("the rendered block never contains review-only phrasing (real pipeline)", async () => {
    mockEnclosing.mockResolvedValue(
      hitExp({
        definitionRows: [defRow({ startLine: 5, endLine: 20 })],
        callerRows: [callerRow({ sourcePath: "src/checkout.ts", callerStartLine: 30, callerEndLine: 50 })],
      }),
    )
    const { fn } = fetcherFor({ "src/billing.ts": SRC_BILLING, "src/checkout.ts": SRC_CHECKOUT })
    const result = await expandHitsToSymbols({
      env: ENV,
      owner: "o",
      repo: "r",
      hits: [chunk()],
      fetchFileContent: fn,
    })
    const block = result.block ?? ""
    expect(block).not.toContain("not in this diff")
    expect(block).not.toContain("do not flag findings")
    expect(block).not.toContain("[GRAPH CONTEXT — CROSS-FILE]")
  })
})
