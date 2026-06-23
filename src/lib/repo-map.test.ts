// SIG-527 — buildRepoMapBlock: fetches the dependency-ranked repo map and renders
// it NAVIGATION-ONLY, bounded to its own char budget. repoMapFor is mocked (the DO
// query has its own suite); this verifies the RENDER: navigation-only format,
// budget cap drops lowest-ranked lines, and the soft-fail-to-null contract.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./repo-graph-client", () => ({ repoMapFor: vi.fn() }))

import { buildRepoMapBlock } from "./repo-map"
import { repoMapFor } from "./repo-graph-client"
import type { RepoMapEntry } from "@/src/shared/domain/graph-context"
import type { Env } from "@/src/shared/types/env"

const mockRepoMap = vi.mocked(repoMapFor)

const env = {} as unknown as Env
const base = { env, owner: "O", repo: "R", biasPaths: [] as string[], limit: 40 }

const entry = (over: Partial<RepoMapEntry> = {}): RepoMapEntry => ({
  path: "src/a.ts",
  name: "fn",
  kind: "function",
  line: 10,
  exported: true,
  callerCount: 3,
  importerCount: 2,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("buildRepoMapBlock", () => {
  it("renders navigation-only lines under an explicit header (no bodies)", async () => {
    mockRepoMap.mockResolvedValue([
      entry({ path: "src/auth.ts", name: "verify", kind: "function", line: 42, callerCount: 7, importerCount: 4 }),
    ])
    const res = await buildRepoMapBlock(base)
    expect(res.block).not.toBeNull()
    expect(res.entries).toBe(1)
    expect(res.chars).toBe(res.block!.length)
    expect(res.block!.startsWith("# Repo map")).toBe(true)
    // explicit "navigation only / do not infer behavior" guardrail in the header
    expect(res.block).toContain("navigation only")
    expect(res.block).toContain("do not infer behavior")
    // one nav line: path:line  kind name  (↑callers, imp importers) — no body text
    expect(res.block).toContain("- src/auth.ts:42  function verify  (↑7 callers, imp 4 importers)")
  })

  it("passes biasPaths + limit through to repoMapFor", async () => {
    mockRepoMap.mockResolvedValue([entry()])
    await buildRepoMapBlock({ ...base, biasPaths: ["src/x.ts", "src/y.ts"], limit: 25 })
    expect(mockRepoMap).toHaveBeenCalledWith(env, "O", "R", { limit: 25, biasPaths: ["src/x.ts", "src/y.ts"] })
  })

  it("drops the lowest-ranked lines to fit maxMapChars", async () => {
    // 5 entries, each ~one line. A tight cap keeps only the first few (most-central).
    const entries = Array.from({ length: 5 }, (_, i) => entry({ path: `src/f${i}.ts`, name: `f${i}`, line: i + 1 }))
    mockRepoMap.mockResolvedValue(entries)
    const full = await buildRepoMapBlock(base)
    expect(full.entries).toBe(5)
    // cap to roughly header + 2 lines
    const lineLen = "- src/f0.ts:1  function f0  (↑3 callers, imp 2 importers)".length
    const tightCap = full.block!.indexOf("\n", full.block!.indexOf("\n") + 1) + 1 + lineLen * 2 + 2
    const trimmed = await buildRepoMapBlock({ ...base, maxMapChars: tightCap })
    expect(trimmed.entries).toBeLessThan(5)
    expect(trimmed.entries).toBeGreaterThan(0)
    expect(trimmed.chars).toBeLessThanOrEqual(tightCap)
    // kept lines are the highest-ranked (first) entries
    expect(trimmed.block).toContain("f0")
  })

  it("soft-fails to null on an empty map", async () => {
    mockRepoMap.mockResolvedValue([])
    const res = await buildRepoMapBlock(base)
    expect(res.block).toBeNull()
    expect(res.entries).toBe(0)
    expect(res.chars).toBe(0)
  })

  it("soft-fails to null when repoMapFor throws (never fails the turn)", async () => {
    mockRepoMap.mockRejectedValue(new Error("DO unreachable"))
    const res = await buildRepoMapBlock(base)
    expect(res.block).toBeNull()
    expect(res.entries).toBe(0)
  })

  it("soft-fails to null when the cap is too small for even one line", async () => {
    mockRepoMap.mockResolvedValue([entry()])
    const res = await buildRepoMapBlock({ ...base, maxMapChars: 5 })
    expect(res.block).toBeNull()
    expect(res.entries).toBe(0)
  })
})
