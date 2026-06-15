// SIG-418 Phase 2 (Design B′) — the pure whole-PR summary tests: a compact,
// deterministic, BOUNDED block (changed files + graph blast caller/dependent hints)
// injected into every batched specialist's context so it keeps whole-PR awareness.

import { describe, expect, it } from "vitest"
import { buildMultiBatchPrSummary } from "@/src/lib/ensemble/domain/multibatch-pr-summary"

describe("buildMultiBatchPrSummary", () => {
  it("returns '' when there is nothing to summarize", () => {
    expect(buildMultiBatchPrSummary({ changedFiles: [], callerPaths: [], dependentPaths: [] })).toBe("")
  })

  it("renders the changed-file list + caller/dependent hints with counts", () => {
    const out = buildMultiBatchPrSummary({
      changedFiles: ["a.ts", "b.ts"],
      callerPaths: ["caller.ts"],
      dependentPaths: ["dep1.ts", "dep2.ts"],
    })
    expect(out).toContain("[WHOLE-PR CONTEXT")
    expect(out).toContain("Changed files (2): a.ts, b.ts")
    expect(out).toContain("Callers of changed code (1): caller.ts")
    expect(out).toContain("Files importing/depending on changed code (2): dep1.ts, dep2.ts")
  })

  it("omits empty sections (no caller/dependent lines when those are empty)", () => {
    const out = buildMultiBatchPrSummary({ changedFiles: ["a.ts"], callerPaths: [], dependentPaths: [] })
    expect(out).toContain("Changed files (1): a.ts")
    expect(out).not.toContain("Callers of changed code")
    expect(out).not.toContain("importing/depending")
  })

  it("caps each list at 40 entries and notes the overflow (bounded on wide PRs)", () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.ts`)
    const out = buildMultiBatchPrSummary({ changedFiles: many, callerPaths: [], dependentPaths: [] })
    expect(out).toContain("Changed files (50):")
    expect(out).toContain("f0.ts")
    expect(out).toContain("f39.ts")
    expect(out).not.toContain("f40.ts")
    expect(out).toContain("(+10 more)")
  })

  it("is deterministic (same input → byte-identical output)", () => {
    const input = { changedFiles: ["a.ts", "b.ts"], callerPaths: ["c.ts"], dependentPaths: ["d.ts"] }
    expect(buildMultiBatchPrSummary(input)).toBe(buildMultiBatchPrSummary(input))
  })
})
