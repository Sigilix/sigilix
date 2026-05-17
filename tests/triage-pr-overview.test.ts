// PR overview prompt parser + comment formatter. The pipeline (PR fetch
// → Ollama → post comment) is integration-tested manually after deploy;
// these unit tests cover only the pure helpers.

import { describe, expect, it } from "vitest"
import {
  formatOverviewComment,
  mergeCachedAndFreshRows,
  parseOverviewResponse,
  scopedDiffFromMisses,
  type PrOverviewVerdict,
} from "../src/lib/triage-pr-overview"
import type { CachedFileRow } from "../src/lib/pr-overview-file-cache"

describe("parseOverviewResponse", () => {
  const valid: PrOverviewVerdict = {
    summary: "Adds a regex guard around path normalization.",
    confidence: 4,
    confidenceReason: "Small surface, well-tested.",
    files: [
      { path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" },
    ],
    bullets: ["Verify the regex catches `..` segments"],
  }

  it("parses a well-formed JSON object", () => {
    const text = JSON.stringify(valid)
    expect(parseOverviewResponse(text)).toEqual(valid)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseOverviewResponse(text)).toEqual(valid)
  })

  it("returns null when summary is missing", () => {
    const broken = { ...valid, summary: "" }
    expect(parseOverviewResponse(JSON.stringify(broken))).toBeNull()
  })

  it("returns null when confidence is out of range", () => {
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: 0 }))).toBeNull()
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: 6 }))).toBeNull()
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: "five" }))).toBeNull()
  })

  it("clamps per-file score to 1-5", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...valid,
        files: [{ path: "a.ts", score: 99 }, { path: "b.ts", score: -3 }],
      })
    )
    expect(out?.files[0]?.score).toBe(5)
    expect(out?.files[1]?.score).toBe(1)
  })

  it("caps files at 20 (ARC-263: bumped from 5 so cache can hold rows for every changed file)", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      score: 3,
      overview: "x",
      nextStep: "y",
    }))
    const out = parseOverviewResponse(JSON.stringify({ ...valid, files: many }))
    expect(out?.files).toHaveLength(20)
  })

  it("drops files without a path", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...valid,
        files: [{ score: 3 }, { path: "ok.ts", score: 2 }],
      })
    )
    expect(out?.files).toHaveLength(1)
    expect(out?.files[0]?.path).toBe("ok.ts")
  })

  it("returns null on bare prose / no JSON", () => {
    expect(parseOverviewResponse("Sure! Here's the overview...")).toBeNull()
  })

  it("extracts the first object even when wrapped in an array (lenient fallback)", () => {
    // Model occasionally returns `[{...}]` despite the prompt asking for
    // a bare object. Balanced-brace scan picks the first `{...}` inside.
    const out = parseOverviewResponse('[{"summary":"x","confidence":3}]')
    expect(out?.summary).toBe("x")
    expect(out?.confidence).toBe(3)
  })

  it("extracts the JSON object from prose-wrapped responses", () => {
    const wrapped = `Here's the overview for the PR:\n\n{"summary":"adds a guard","confidence":4}\n\nLet me know if you need adjustments.`
    const out = parseOverviewResponse(wrapped)
    expect(out?.summary).toBe("adds a guard")
    expect(out?.confidence).toBe(4)
  })
})

describe("formatOverviewComment", () => {
  const verdict: PrOverviewVerdict = {
    summary: "Adds null-safe access on `user.profile`.",
    confidence: 4,
    confidenceReason: "Narrow surface; good test coverage.",
    files: [
      { path: "app/user.ts", score: 4, overview: "Guards profile read", nextStep: "Add e2e test" },
    ],
    bullets: ["lines 42-58 — verify the fallback empties the badge cache"],
  }

  it("starts with the dedupe marker on line 1", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md.split("\n")[0]).toBe("<!-- openclaw:pr-overview -->")
  })

  it("renders the summary heading + content", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("## Sigilix Overview")
    expect(md).toContain("### Summary")
    expect(md).toContain(verdict.summary)
  })

  it('appends " — latest push" on incremental runs', () => {
    const md = formatOverviewComment({ verdict, isFirstRun: false })
    expect(md).toContain("### Summary — latest push")
  })

  it("renders the per-file table when files are present", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("### Important files")
    expect(md).toContain("| File | Score | Notes | Next step |")
    expect(md).toMatch(/\| `app\/user\.ts` \| 4\/5 \|/)
  })

  it("omits the file table when files is empty", () => {
    const md = formatOverviewComment({
      verdict: { ...verdict, files: [] },
      isFirstRun: true,
    })
    expect(md).not.toContain("### Important files")
  })

  it("renders confidence + reason", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("### Confidence: 4/5")
    expect(md).toContain(verdict.confidenceReason)
  })

  it("renders each bullet as a list item", () => {
    const md = formatOverviewComment({
      verdict: { ...verdict, bullets: ["one", "two"] },
      isFirstRun: true,
    })
    expect(md).toContain("- one")
    expect(md).toContain("- two")
  })
})

// ARC-263 — walkthrough caching helpers
describe("scopedDiffFromMisses", () => {
  it("builds `diff --git` blocks for each miss with a patch", () => {
    const out = scopedDiffFromMisses(
      [
        { filename: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y" },
        { filename: "b.ts", patch: "@@ -5 +5 @@\n-foo\n+bar" },
      ],
      "FALLBACK",
    )
    expect(out).toContain("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@")
    expect(out).toContain("diff --git a/b.ts b/b.ts\n@@ -5 +5 @@")
    expect(out).not.toContain("FALLBACK")
  })

  it("falls back to the full diff when no miss has a patch", () => {
    const out = scopedDiffFromMisses(
      [{ filename: "huge.lock" }, { filename: "binary.png", patch: "" }],
      "FULL DIFF HERE",
    )
    expect(out).toBe("FULL DIFF HERE")
  })

  it("appends a no-patch footer when some misses have no patch", () => {
    const out = scopedDiffFromMisses(
      [
        { filename: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y" },
        { filename: "binary.png", status: "modified" },
      ],
      "FALLBACK",
    )
    expect(out).toContain("diff --git a/a.ts b/a.ts")
    expect(out).toContain("[Files changed but no patch available")
    expect(out).toContain("- binary.png (modified)")
  })

  // CodeRabbit MAJOR catch on PR #81 — the all-hit case (every file
  // served from cache) is the cache's whole point. Must NOT fall
  // back to the full diff; should emit a minimal placeholder so
  // PR-level summary/confidence/bullets still regenerate cheaply.
  it("returns a minimal placeholder when all files are cache hits (misses is empty)", () => {
    const out = scopedDiffFromMisses([], "FULL DIFF HERE")
    expect(out).not.toBe("FULL DIFF HERE")
    expect(out).toContain("All file rows were served from the walkthrough cache")
  })
})

describe("mergeCachedAndFreshRows", () => {
  const baseVerdict: PrOverviewVerdict = {
    summary: "S", confidence: 3, confidenceReason: "R",
    files: [{ path: "fresh.ts", score: 5, overview: "fresh-o", nextStep: "fresh-n" }],
    bullets: [],
  }
  const cachedRow = (path: string, score: number): CachedFileRow => ({
    path, score, overview: "cached-o", nextStep: "cached-n",
  })

  it("includes cached rows whose path isn't in the fresh set", () => {
    const cached = new Map<string, CachedFileRow>([
      ["cached-a.ts", cachedRow("cached-a.ts", 2)],
      ["cached-b.ts", cachedRow("cached-b.ts", 1)],
    ])
    const out = mergeCachedAndFreshRows(baseVerdict, cached)
    const paths = out.files.map((f) => f.path).sort()
    expect(paths).toEqual(["cached-a.ts", "cached-b.ts", "fresh.ts"])
  })

  it("fresh rows win on path collision (model just looked at this file)", () => {
    const cached = new Map<string, CachedFileRow>([
      ["fresh.ts", cachedRow("fresh.ts", 1)],
    ])
    const out = mergeCachedAndFreshRows(baseVerdict, cached)
    expect(out.files).toHaveLength(1)
    expect(out.files[0]?.overview).toBe("fresh-o") // fresh, not cached
  })

  it("truncates the merged list to top-5 by score for display", () => {
    const fresh: PrOverviewVerdict = {
      ...baseVerdict,
      files: Array.from({ length: 4 }, (_, i) => ({
        path: `fresh-${i}.ts`, score: 5, overview: "o", nextStep: "n",
      })),
    }
    const cached = new Map<string, CachedFileRow>(
      Array.from({ length: 10 }, (_, i) => [`cached-${i}.ts`, cachedRow(`cached-${i}.ts`, 4)]),
    )
    const out = mergeCachedAndFreshRows(fresh, cached)
    expect(out.files).toHaveLength(5)
    // All score-5 fresh rows must appear (4 of them) + one score-4 cached.
    expect(out.files.filter((f) => f.score === 5)).toHaveLength(4)
    expect(out.files.filter((f) => f.score === 4)).toHaveLength(1)
  })

  it("preserves non-files verdict fields (summary, confidence, bullets)", () => {
    const out = mergeCachedAndFreshRows(baseVerdict, new Map())
    expect(out.summary).toBe(baseVerdict.summary)
    expect(out.confidence).toBe(baseVerdict.confidence)
    expect(out.bullets).toEqual(baseVerdict.bullets)
  })
})
