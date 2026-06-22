// SIG-494 — gatherAgentContext: composes retrieveChunks + expandHitsToSymbols into one
// packed grounded-context for an agent turn. The retrieval + graph primitives are mocked
// (their own suites cover them); this verifies the COMPOSITION: blind baseline on empty
// query / no match, symbol-block-supersedes-raw dedup, no-graph fallback, telemetry.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./retrieval", () => ({
  retrieveChunks: vi.fn(),
  formatChunksForPrompt: vi.fn(),
}))
vi.mock("./symbol-expansion", () => ({
  expandHitsToSymbols: vi.fn(),
  // hitKey is pure — keep the real impl so supersededHitKeys matching works.
  hitKey: (h: { path: string; lineStart: number; lineEnd: number }) => `${h.path}:${h.lineStart}-${h.lineEnd}`,
}))

import { gatherAgentContext, indexNamespaceFor } from "./agent-context"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { expandHitsToSymbols } from "./symbol-expansion"
import type { Env } from "@/src/shared/types/env"

const mockRetrieve = vi.mocked(retrieveChunks)
const mockFormat = vi.mocked(formatChunksForPrompt)
const mockExpand = vi.mocked(expandHitsToSymbols)

const env = {} as unknown as Env
const fetchFileContent = async (): Promise<string | null> => null
const chunk = (path: string, lineStart: number, lineEnd: number) =>
  ({ path, lineStart, lineEnd, content: "code", score: 1 }) as never
const expansion = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    block: null,
    headSha: null,
    supersededHitKeys: [],
    telemetry: {
      graphAvailable: false,
      symbolsExpanded: 0,
      callersRendered: 0,
      fetchedFiles: 0,
      fetchBytes: 0,
      superseded: 0,
    },
    ...over,
  }) as never

const base = { owner: "O", repo: "R", env, fetchFileContent }

beforeEach(() => vi.clearAllMocks())

describe("indexNamespaceFor", () => {
  it("lowercases owner/repo (SIG-132 namespace)", () => {
    expect(indexNamespaceFor("MyOrg", "MyRepo")).toBe("myorg/myrepo")
  })
})

describe("gatherAgentContext", () => {
  it("blind baseline: empty query → null context, no retrieval call", async () => {
    const res = await gatherAgentContext({ ...base, query: "   " })
    expect(res.context).toBeNull()
    expect(res.telemetry.namespace).toBe("o/r")
    expect(res.telemetry.chunkCount).toBe(0)
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it("blind baseline: no index match → null context, no graph expansion", async () => {
    mockRetrieve.mockResolvedValue([])
    const res = await gatherAgentContext({ ...base, query: "where is auth" })
    expect(res.context).toBeNull()
    expect(res.telemetry.chunkCount).toBe(0)
    expect(mockExpand).not.toHaveBeenCalled()
  })

  it("symbol block supersedes the raw chunk it contains (no duplicated bytes)", async () => {
    const c1 = chunk("a.ts", 1, 5)
    const c2 = chunk("b.ts", 10, 20)
    mockRetrieve.mockResolvedValue([c1, c2])
    mockExpand.mockResolvedValue(
      expansion({
        block: "SYMBOLS",
        supersededHitKeys: ["a.ts:1-5"],
        telemetry: {
          graphAvailable: true,
          symbolsExpanded: 2,
          callersRendered: 1,
          fetchedFiles: 1,
          fetchBytes: 100,
          superseded: 1,
        },
      }),
    )
    mockFormat.mockReturnValue("RAW(b.ts)")
    const res = await gatherAgentContext({ ...base, query: "fix the loader" })
    // only the NON-superseded chunk (c2) is formatted as raw
    expect(mockFormat).toHaveBeenCalledWith([c2])
    expect(res.context).toBe("SYMBOLS\n\nRAW(b.ts)")
    expect(res.telemetry).toMatchObject({ chunkCount: 2, graphAvailable: true, symbolsExpanded: 2, superseded: 1 })
    expect(res.telemetry.contextChars).toBe("SYMBOLS\n\nRAW(b.ts)".length)
  })

  it("no graph available → raw chunks only", async () => {
    mockRetrieve.mockResolvedValue([chunk("a.ts", 1, 5)])
    mockExpand.mockResolvedValue(expansion({ block: null }))
    mockFormat.mockReturnValue("RAW(a.ts)")
    const res = await gatherAgentContext({ ...base, query: "q" })
    expect(res.context).toBe("RAW(a.ts)")
    expect(res.telemetry.graphAvailable).toBe(false)
  })

  it("chunks but nothing renders (block null + empty raw) → null context", async () => {
    mockRetrieve.mockResolvedValue([chunk("a.ts", 1, 5)])
    mockExpand.mockResolvedValue(expansion({ block: null }))
    mockFormat.mockReturnValue(null)
    const res = await gatherAgentContext({ ...base, query: "q" })
    expect(res.context).toBeNull()
    expect(res.telemetry.chunkCount).toBe(1)
  })

  it("trims the lowest-ranked raw chunks to fit the context budget (do-no-harm bound)", async () => {
    mockRetrieve.mockResolvedValue([chunk("a.ts", 1, 5), chunk("b.ts", 6, 9), chunk("c.ts", 10, 14)])
    mockExpand.mockResolvedValue(expansion({ block: null }))
    // each kept chunk contributes ~100 chars to the formatted block
    mockFormat.mockImplementation((arr) => (arr.length > 0 ? "R".repeat(arr.length * 100) : null))
    const res = await gatherAgentContext({ ...base, query: "q", maxContextChars: 250 })
    expect(res.telemetry.rawChunksKept).toBe(2) // 3×100=300 > 250 → drop to 2 (200 ≤ 250)
    expect(res.context?.length).toBe(200)
    expect(res.telemetry.budget).toBe(250)
  })

  it("trims raw chunks AROUND the symbol block (co-trim against the budget)", async () => {
    mockRetrieve.mockResolvedValue([chunk("a.ts", 1, 5), chunk("b.ts", 6, 9), chunk("c.ts", 10, 14)])
    mockExpand.mockResolvedValue(expansion({ block: "X".repeat(150) })) // symbolLen = 150 + 2(sep) = 152
    mockFormat.mockImplementation((arr) => (arr.length > 0 ? "R".repeat(arr.length * 100) : null))
    const res = await gatherAgentContext({ ...base, query: "q", maxContextChars: 300 })
    // 152 + 3×100 > 300 → drop to 1 chunk: 152 + 100 = 252 ≤ 300
    expect(res.telemetry.rawChunksKept).toBe(1)
    expect(res.context?.length).toBe(252) // 150 + 2 + 100
  })
})
