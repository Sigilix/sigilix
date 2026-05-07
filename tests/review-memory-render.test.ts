// ARC-189 — Render tests (Task 6).

import { describe, expect, it } from "vitest"
import { renderReviewMemoryForPrompt } from "../src/lib/review-memory/render"
import type { ReviewMemoryFinding } from "../src/lib/review-memory/types"

function f(over: Partial<ReviewMemoryFinding> = {}): ReviewMemoryFinding {
  return {
    scope: "category",
    category: "logic",
    signalCount: 3,
    lastSignalTs: "2026-04-12T00:00:00Z",
    suggestedAction: "soften",
    ...over,
  }
}

const SAMPLE_PATH_SHA12 = "d4e5f6a7b8c9"

describe("renderReviewMemoryForPrompt", () => {
  it("returns empty string for empty input (omit-empty contract)", () => {
    expect(renderReviewMemoryForPrompt([])).toBe("")
  })

  it("emits a non-empty block on a single finding", () => {
    const out = renderReviewMemoryForPrompt([f({ category: "performance", signalCount: 4 })])
    expect(out).toContain("[REVIEW MEMORY")
    expect(out).toContain("category=performance")
    expect(out).toContain("signals=4")
    expect(out).toContain("→ soften")
  })

  it("renders pathSha12 for path-scoped findings, NOT raw paths", () => {
    const out = renderReviewMemoryForPrompt([
      f({
        scope: "path-category",
        category: "tests",
        pathSha12: SAMPLE_PATH_SHA12,
        signalCount: 5,
      }),
    ])
    expect(out).toContain(`scope=path:${SAMPLE_PATH_SHA12}`)
    // Privacy contract: never any segment containing a forward slash
    // that looks like a repo-relative path. Match "scope=path:" → no
    // following character that looks pathlike (a-z + digits +
    // underscore + dash + dot only).
    expect(out).not.toMatch(/scope=path:[^,\s]*\//)
  })

  it("category-scoped renders without scope=path:", () => {
    const out = renderReviewMemoryForPrompt([f({ category: "security", signalCount: 3 })])
    expect(out).toContain("scope=repo")
    expect(out).not.toContain("scope=path:")
  })

  it("provenance.softened instruction appears in header", () => {
    const out = renderReviewMemoryForPrompt([f()])
    expect(out).toContain("provenance.softened[]")
  })

  it("deterministic: same input → same output", () => {
    const memories = [
      f({ category: "performance", signalCount: 4 }),
      f({
        scope: "path-category",
        category: "tests",
        pathSha12: SAMPLE_PATH_SHA12,
        signalCount: 5,
      }),
    ]
    expect(renderReviewMemoryForPrompt(memories)).toBe(renderReviewMemoryForPrompt(memories))
  })

  it("token-cap (≤200): 5 typical records stay under cap", () => {
    const memories: ReviewMemoryFinding[] = [
      f({ category: "performance", signalCount: 3 }),
      f({ category: "logic", signalCount: 4 }),
      f({ category: "tests", signalCount: 5 }),
      f({ category: "security", signalCount: 3, lastSignalTs: "2026-04-30T00:00:00Z" }),
      f({
        scope: "path-category",
        category: "tests",
        pathSha12: SAMPLE_PATH_SHA12,
        signalCount: 5,
      }),
    ]
    const out = renderReviewMemoryForPrompt(memories)
    // 4-chars-per-token coarse approximation matches the rest of
    // the codebase's token estimation
    const approxTokens = Math.ceil(out.length / 4)
    expect(approxTokens).toBeLessThanOrEqual(200)
  })

  it("per-record budget: a record that would render >25 tokens is truncated with ellipsis", () => {
    // Construct a finding with a synthetically long pathSha12 to push
    // the record over the per-record budget. (sha12 is normally 12
    // chars, but the renderer treats whatever's passed in as a
    // string for budget-truncation purposes.)
    const longHash = "a".repeat(80)  // >> sha12; forces budget overflow
    const out = renderReviewMemoryForPrompt([
      f({ scope: "path-category", category: "tests", pathSha12: longHash }),
    ])
    expect(out).toMatch(/…\b|…/)
  })

  it("global token cap: >5 records gracefully drop the overflow rather than mid-truncate", () => {
    // 10 distinct categories isn't possible (only 4) but we can
    // simulate with repeats — the render layer doesn't dedupe by
    // category since the lookup layer already capped to 5. Force
    // overflow by passing 8 records.
    const memories: ReviewMemoryFinding[] = Array.from({ length: 8 }, (_, i) =>
      f({ category: "logic", signalCount: 3 + i }),
    )
    const out = renderReviewMemoryForPrompt(memories)
    const approxTokens = Math.ceil(out.length / 4)
    expect(approxTokens).toBeLessThanOrEqual(200)
    // Header must still be present
    expect(out).toContain("[REVIEW MEMORY")
  })

  it("includes lastSignalTs YYYY-MM-DD prefix in each record", () => {
    const out = renderReviewMemoryForPrompt([
      f({ category: "performance", lastSignalTs: "2026-04-12T18:30:11Z" }),
    ])
    expect(out).toContain("last=2026-04-12")
  })
})
