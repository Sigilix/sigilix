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
    expect(md.split("\n")[0]).toBe("<!-- sigilix:pr-overview -->")
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

  // Founder pivot (2026-05-17): the "[!NOTE] Sigilix is warming up
  // its index..." callout that briefly shipped on PR #80 was pulled
  // — too noisy on cold-install PRs. The marker stays (so the rerun
  // fan-out can still grep PRs that need post-indexing re-review)
  // but the customer-visible text is gone.
  it("emits the warmup callout marker (no visible text) when warmup is pending", async () => {
    const { WARMUP_CALLOUT_MARKER } = await import("../src/lib/warmup")
    const md = formatOverviewComment({ verdict, isFirstRun: true, warmup: "pending" })
    expect(md).toContain(WARMUP_CALLOUT_MARKER) // marker present (for rerun detection)
    expect(md).not.toContain("[!NOTE]") // no visible callout block
    expect(md).not.toContain("Sigilix is warming up its index") // no visible header
    expect(md).not.toContain("cross-file context isn't available") // no visible body
  })

  it("omits the warmup marker entirely when warmup is none", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true, warmup: "none" })
    expect(md).not.toContain("sigilix:warmup-callout")
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

// ─── SIG-99 polish: effort + labels + reviewers + related + mermaid ──

describe("parseOverviewResponse — SIG-99 polish fields", () => {
  const base = {
    summary: "Adds X.",
    confidence: 4,
    confidenceReason: "Narrow surface.",
    files: [{ path: "src/foo.ts", score: 3, overview: "ov", nextStep: "ns" }],
    bullets: ["b1"],
  }

  it("reads reviewEffort when in range 1-5", () => {
    const out = parseOverviewResponse(JSON.stringify({ ...base, reviewEffort: 4 }))
    expect(out?.reviewEffort).toBe(4)
  })

  it("drops reviewEffort when out of range", () => {
    expect(parseOverviewResponse(JSON.stringify({ ...base, reviewEffort: 0 }))?.reviewEffort).toBeUndefined()
    expect(parseOverviewResponse(JSON.stringify({ ...base, reviewEffort: 6 }))?.reviewEffort).toBeUndefined()
    expect(parseOverviewResponse(JSON.stringify({ ...base, reviewEffort: "three" }))?.reviewEffort).toBeUndefined()
  })

  it("clamps suggestedLabels to 3 entries", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, suggestedLabels: ["bug", "perf", "docs", "extra"] }),
    )
    expect(out?.suggestedLabels).toEqual(["bug", "perf", "docs"])
  })

  it("filters out empty/whitespace labels and unwraps trim", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, suggestedLabels: ["  bug  ", "", "  ", "perf"] }),
    )
    expect(out?.suggestedLabels).toEqual(["bug", "perf"])
  })

  it("strips leading @ from reviewer handles and accepts valid GH usernames", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, suggestedReviewers: ["@octocat", "monalisa"] }),
    )
    expect(out?.suggestedReviewers).toEqual(["octocat", "monalisa"])
  })

  it("drops reviewer entries that fail the GH username pattern", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, suggestedReviewers: ["valid-user", "spaces in name", "user_with_underscore"] }),
    )
    // GitHub usernames disallow spaces + underscores; only `valid-user` survives.
    expect(out?.suggestedReviewers).toEqual(["valid-user"])
  })

  it("clamps suggestedReviewers to 2 entries", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, suggestedReviewers: ["a", "b", "c"] }),
    )
    expect(out?.suggestedReviewers).toEqual(["a", "b"])
  })

  it("accepts only https github.com PR URLs in relatedPrUrls (anti-injection)", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...base,
        relatedPrUrls: [
          "https://github.com/owner/repo/pull/42",
          "http://github.com/owner/repo/pull/43", // wrong scheme
          "https://evil.com/pull/44", // wrong host
          "https://github.com/owner/repo/issues/45", // not a PR URL
          "https://github.com/owner/repo/pull/46?comment=1", // PR URL with query — accepted
        ],
      }),
    )
    expect(out?.relatedPrUrls).toEqual([
      "https://github.com/owner/repo/pull/42",
      "https://github.com/owner/repo/pull/46?comment=1",
    ])
  })

  it("clamps relatedPrUrls to 3 entries", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...base,
        relatedPrUrls: [
          "https://github.com/o/r/pull/1",
          "https://github.com/o/r/pull/2",
          "https://github.com/o/r/pull/3",
          "https://github.com/o/r/pull/4",
        ],
      }),
    )
    expect(out?.relatedPrUrls).toHaveLength(3)
  })

  it("accepts mermaid diagrams that start with a known diagram kind", () => {
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, mermaidDiagram: "sequenceDiagram\n  A->>B: hello" }),
    )
    expect(out?.mermaidDiagram).toContain("sequenceDiagram")
  })

  it("rejects mermaid payloads that don't start with a known kind (anti-injection)", () => {
    // Anything other than sequenceDiagram/flowchart/graph/stateDiagram
    // gets dropped — the model can't smuggle arbitrary markdown.
    const out = parseOverviewResponse(
      JSON.stringify({ ...base, mermaidDiagram: "## fake heading\nrandom markdown" }),
    )
    expect(out?.mermaidDiagram).toBeUndefined()
  })

  it("a verdict with NO polish fields parses cleanly (back-compat)", () => {
    const out = parseOverviewResponse(JSON.stringify(base))
    expect(out).not.toBeNull()
    expect(out?.reviewEffort).toBeUndefined()
    expect(out?.suggestedLabels).toBeUndefined()
    expect(out?.suggestedReviewers).toBeUndefined()
    expect(out?.relatedPrUrls).toBeUndefined()
    expect(out?.mermaidDiagram).toBeUndefined()
  })
})

describe("formatOverviewComment — SIG-99 polish rendering", () => {
  const verdict: PrOverviewVerdict = {
    summary: "Adds X.",
    confidence: 4,
    confidenceReason: "Narrow surface.",
    files: [{ path: "src/foo.ts", score: 3, overview: "ov", nextStep: "ns" }],
    bullets: ["b1"],
  }

  it("omits ALL polish sections when none of the fields are set (back-compat)", () => {
    const body = formatOverviewComment({ verdict, isFirstRun: true })
    expect(body).not.toContain("**Effort:**")
    expect(body).not.toContain("Sequence diagram")
    expect(body).not.toContain("Suggested labels")
    expect(body).not.toContain("Suggested reviewers")
    expect(body).not.toContain("Related context")
  })

  it("renders the effort badge under the heading when reviewEffort is set", () => {
    const body = formatOverviewComment({
      verdict: { ...verdict, reviewEffort: 3 },
      isFirstRun: true,
    })
    expect(body).toContain("**Effort:** 3/5 _(medium)_")
    // Badge sits BEFORE the Summary heading.
    expect(body.indexOf("**Effort:**")).toBeLessThan(body.indexOf("### Summary"))
  })

  it("renders the suggested labels as backtick pills", () => {
    const body = formatOverviewComment({
      verdict: { ...verdict, suggestedLabels: ["bug", "perf"] },
      isFirstRun: true,
    })
    expect(body).toContain("**Suggested labels:** `bug` `perf`")
  })

  it("renders suggested reviewers as @-mentions", () => {
    const body = formatOverviewComment({
      verdict: { ...verdict, suggestedReviewers: ["alice", "bob"] },
      isFirstRun: true,
    })
    expect(body).toContain("**Suggested reviewers:** @alice, @bob")
  })

  it("renders the related-PR URLs as a bulleted list under Related context", () => {
    const body = formatOverviewComment({
      verdict: {
        ...verdict,
        relatedPrUrls: ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
      },
      isFirstRun: true,
    })
    expect(body).toContain("**Related context:**")
    expect(body).toContain("- https://github.com/o/r/pull/1")
    expect(body).toContain("- https://github.com/o/r/pull/2")
  })

  it("renders the mermaid diagram inside a fenced ```mermaid block under a Sequence diagram heading", () => {
    const body = formatOverviewComment({
      verdict: {
        ...verdict,
        mermaidDiagram: "sequenceDiagram\n  A->>B: hello",
      },
      isFirstRun: true,
    })
    expect(body).toContain("### Sequence diagram")
    expect(body).toContain("```mermaid\nsequenceDiagram\n  A->>B: hello\n```")
  })

  it("renders the polish sections in the documented order: effort → summary → files → mermaid → confidence → bullets → labels → reviewers → related", () => {
    const body = formatOverviewComment({
      verdict: {
        ...verdict,
        reviewEffort: 4,
        suggestedLabels: ["bug"],
        suggestedReviewers: ["alice"],
        relatedPrUrls: ["https://github.com/o/r/pull/1"],
        mermaidDiagram: "sequenceDiagram\n  A->>B",
      },
      isFirstRun: true,
    })
    const effort = body.indexOf("**Effort:**")
    const summary = body.indexOf("### Summary")
    const files = body.indexOf("### Important files")
    const mermaid = body.indexOf("### Sequence diagram")
    const confidence = body.indexOf("### Confidence:")
    const labels = body.indexOf("**Suggested labels:**")
    const reviewers = body.indexOf("**Suggested reviewers:**")
    const related = body.indexOf("**Related context:**")
    expect(effort).toBeGreaterThan(-1)
    expect(summary).toBeGreaterThan(effort)
    expect(files).toBeGreaterThan(summary)
    expect(mermaid).toBeGreaterThan(files)
    expect(confidence).toBeGreaterThan(mermaid)
    expect(labels).toBeGreaterThan(confidence)
    expect(reviewers).toBeGreaterThan(labels)
    expect(related).toBeGreaterThan(reviewers)
  })
})
