// SIG-70/SIG-326 — compare-reviewers tool tests.
//
// The CLI shell (`cli.ts`) and the `gh` fetch (`github.ts`) need the
// network/filesystem and aren't unit-tested; everything load-bearing is pure
// and covered here: normalization, worksheet build + parse/validate, the
// summary tally + markdown, and the path/merge/arg helpers. The final block
// is an end-to-end pass through the real chain (raw comments → worksheet →
// labels → report) that fails if any stage regresses.

import { describe, expect, it } from "vitest"
import { normalizeFindings, summarizeBody, type RawComment } from "../compare-reviewers/normalize"
import { buildWorksheet, parseWorksheet } from "../compare-reviewers/worksheet"
import { formatSummaryMarkdown, summarize } from "../compare-reviewers/summary"
import { comparisonBasename, mergeComparison, parseTarget } from "../compare-reviewers/io"
import type { ComparisonFile, LabeledItem } from "../compare-reviewers/types"

const SIG = "sigilix[bot]"
const CR = "coderabbitai[bot]"
const GREPTILE = "greptile-apps[bot]"

function comment(over: Partial<RawComment> & { id: number }): RawComment {
  return {
    user: { login: SIG },
    path: "src/foo.ts",
    line: 10,
    body: "<!-- sigilix:pr-review-finding -->\n**logic:** something\n<!-- sigilix:category:logic -->",
    html_url: `https://github.com/o/r/pull/1#discussion_r${over.id}`,
    ...over,
  }
}

function emptyFile(over: Partial<ComparisonFile> = {}): ComparisonFile {
  return {
    schemaVersion: 2,
    owner: "o",
    repo: "r",
    pr: 1,
    prUrl: "https://github.com/o/r/pull/1",
    collectedAt: "2026-06-05T00:00:00.000Z",
    findings: { sigilix: [], coderabbit: [], greptile: [] },
    items: [],
    ...over,
  }
}

// ─── normalize ───────────────────────────────────────────────────

describe("normalizeFindings", () => {
  it("keeps only Sigilix comments carrying the finding marker", () => {
    const out = normalizeFindings([
      comment({ id: 3 }), // sigilix finding
      comment({ id: 4, body: "<!-- sigilix:pr-overview -->\n## Overview" }), // not a finding
      comment({ id: 5, body: "<!-- sigilix:gh-mention-reply -->\nwithdrawing" }), // not a finding
    ])
    expect(out.sigilix).toHaveLength(1)
    expect(out.sigilix[0]!.commentId).toBe(3)
    expect(out.coderabbit).toHaveLength(0)
  })

  it("treats every CodeRabbit inline comment as a finding and drops humans", () => {
    const out = normalizeFindings([
      comment({ id: 1, user: { login: CR }, body: "Potential issue: null deref" }),
      comment({ id: 2, user: { login: "alice" }, body: "lgtm" }),
      comment({ id: 7, user: { login: CR }, body: "Nitpick: rename this" }),
    ])
    expect(out.coderabbit.map((f) => f.commentId)).toEqual([1, 7])
    expect(out.sigilix).toHaveLength(0)
  })

  it("normalizes Greptile inline comments with stable g* refs", () => {
    const out = normalizeFindings([
      comment({ id: 9, user: { login: GREPTILE }, body: "Possible issue: auth bypass" }),
      comment({ id: 7, user: { login: "custom-greptile[bot]" }, body: "Possible issue: race" }),
    ], { greptileLogins: [GREPTILE, "custom-greptile[bot]"] })
    expect(out.greptile.map((f) => [f.ref, f.commentId, f.tool])).toEqual([
      ["g1", 7, "greptile"],
      ["g2", 9, "greptile"],
    ])
  })

  it("excludes thread replies (in_reply_to_id set) so CR replies don't inflate counts", () => {
    const out = normalizeFindings([
      comment({ id: 1, user: { login: CR }, body: "Potential issue: real finding" }),
      comment({ id: 2, user: { login: CR }, body: "@someone exactly right — thanks", in_reply_to_id: 1 }),
      comment({ id: 3, body: "<!-- sigilix:pr-review-finding -->\n**logic:** x", in_reply_to_id: 1 }),
    ])
    expect(out.coderabbit.map((f) => f.commentId)).toEqual([1]) // reply id=2 dropped
    expect(out.sigilix).toHaveLength(0) // reply id=3 dropped even with the marker
  })

  it("assigns stable, sorted refs (s1.. / c1..) by comment id", () => {
    const out = normalizeFindings([
      comment({ id: 30 }),
      comment({ id: 10 }),
      comment({ id: 20, user: { login: CR }, body: "issue" }),
    ])
    expect(out.sigilix.map((f) => [f.ref, f.commentId])).toEqual([
      ["s1", 10],
      ["s2", 30],
    ])
    expect(out.coderabbit.map((f) => f.ref)).toEqual(["c1"])
    expect(out.greptile).toEqual([])
  })

  it("parses Sigilix self-category from the standalone and fid markers; CR has none", () => {
    const std = normalizeFindings([comment({ id: 1 })]).sigilix[0]!
    expect(std.botCategory).toBe("logic")
    const fid = normalizeFindings([
      comment({
        id: 2,
        body: "<!-- sigilix:pr-review-finding -->\n**x**\n<!-- sigilix:fid:abc123:cat:security:sev:warning:path:def -->",
      }),
    ]).sigilix[0]!
    expect(fid.botCategory).toBe("security")
    const cr = normalizeFindings([comment({ id: 3, user: { login: CR }, body: "issue" })]).coderabbit[0]!
    expect(cr.botCategory).toBeUndefined()
  })

  it("carries path=null / line=null through without throwing", () => {
    const out = normalizeFindings([comment({ id: 1, path: null, line: null })])
    expect(out.sigilix[0]!.path).toBeNull()
    expect(out.sigilix[0]!.line).toBeNull()
  })
})

describe("summarizeBody", () => {
  it("strips markers/badges and returns the first meaningful line", () => {
    const body = [
      "<!-- sigilix:pr-review-finding -->",
      '<a href="https://sigilix.ai"><img alt="P1" src="x"></a> **Null deref in handler**',
      "<!-- sigilix:category:logic -->",
      "",
      "more detail",
    ].join("\n")
    expect(summarizeBody(body)).toBe("**Null deref in handler**")
  })

  it("caps long lines and never returns empty", () => {
    expect(summarizeBody("x".repeat(500)).length).toBeLessThanOrEqual(280)
    expect(summarizeBody("<!-- only a marker -->")).toBe("(no text)")
  })

  it("caps on a code-point boundary without splitting a surrogate pair (emoji)", () => {
    // Each 🟠 is 2 UTF-16 units; a naive .slice(0, 279) would cut mid-pair and
    // emit a lone surrogate. Code-point slicing keeps every char whole.
    const out = summarizeBody("🟠".repeat(300))
    expect([...out].every((c) => c === "🟠" || c === "…")).toBe(true)
  })
})

// ─── worksheet build + parse ─────────────────────────────────────

const twoFindingFile = (): ComparisonFile =>
  emptyFile({
    findings: {
      sigilix: [
        { ref: "s1", tool: "sigilix", commentId: 10, path: "src/a.ts", line: 5, excerpt: "null deref", url: "u1", botCategory: "logic" },
      ],
      coderabbit: [
        { ref: "c1", tool: "coderabbit", commentId: 11, path: "src/a.ts", line: 5, excerpt: "deref of null", url: "u2" },
        { ref: "c2", tool: "coderabbit", commentId: 12, path: "README.md", line: null, excerpt: "typo", url: "u3" },
      ],
      greptile: [
        { ref: "g1", tool: "greptile", commentId: 13, path: "src/a.ts", line: 6, excerpt: "same deref", url: "u4" },
      ],
    },
  })

/** Replace the worksheet's empty placeholder row with real label rows. */
function fillWorksheet(md: string, rows: string[]): string {
  return md.replace("| | | | |", rows.join("\n"))
}

describe("buildWorksheet", () => {
  it("lists each bot's findings and the labels table scaffold", () => {
    const md = buildWorksheet(twoFindingFile())
    expect(md).toContain("### Sigilix findings")
    expect(md).toContain("`s1` src/a.ts:5")
    expect(md).toContain("### CodeRabbit findings")
    expect(md).toContain("`c2` README.md")
    expect(md).toContain("### Greptile findings")
    expect(md).toContain("`g1` src/a.ts:6")
    expect(md).toContain("## Labels")
    expect(md).toContain("real_bug") // the legend lists every outcome
  })

  it("renders '(none)' for a bot with no findings", () => {
    const md = buildWorksheet(emptyFile())
    expect(md).toContain("_(none)_")
  })
})

describe("parseWorksheet", () => {
  const file = twoFindingFile()

  it("parses valid rows into items, skipping the empty placeholder", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1,c1 | real_bug | logic | both caught it |",
      "| c2 | noise | style | |",
      "| none | real_bug | security | missed by every tool |",
    ])
    const { items, errors, notes } = parseWorksheet(md, file)
    expect(errors).toEqual([])
    expect(notes.some((n) => n.includes("g1"))).toBe(true)
    expect(items).toEqual<LabeledItem[]>([
      { id: 1, findings: ["s1", "c1"], outcome: "real_bug", category: "logic", note: "both caught it" },
      { id: 2, findings: ["c2"], outcome: "noise", category: "style", note: "" },
      { id: 3, findings: [], outcome: "real_bug", category: "security", note: "missed by every tool" },
    ])
  })

  it("rejects an unknown outcome and an unknown category", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | maybe_real | logic | |",
      "| c1 | real_bug | databases | |",
    ])
    const { items, errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('invalid outcome "maybe_real"'))).toBe(true)
    expect(errors.some((e) => e.includes('invalid category "databases"'))).toBe(true)
    expect(items).toHaveLength(0)
  })

  it("rejects an unknown finding ref", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s9 | real_bug | logic | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('unknown finding ref "s9"'))).toBe(true)
  })

  it("rejects the same finding labeled in two rows", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | real_bug | logic | |",
      "| s1 | noise | logic | |",
    ])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('"s1" already labeled in row 1'))).toBe(true)
  })

  it("requires explicit none for a missed-by-all row", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| | real_bug | logic | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('use "none" for a missed real bug'))).toBe(true)
  })

  it("rejects a noise row without a tool finding", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| none | noise | style | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('outcome "noise" requires at least one tool finding ref'))).toBe(true)
  })

  it("preserves a literal pipe in the note cell (no truncation at the first |)", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | real_bug | logic | use a || b here |",
    ])
    const { items, errors } = parseWorksheet(md, file)
    expect(errors).toEqual([])
    expect(items[0]!.note).toBe("use a || b here")
  })

  it("reports unlabeled findings as a note, not a blocking error", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s1,c1 | real_bug | logic | |"])
    const { items, errors, notes } = parseWorksheet(md, file)
    expect(errors).toEqual([])
    expect(items).toHaveLength(1)
    expect(notes.some((n) => n.includes("c2"))).toBe(true)
  })

  it("errors cleanly when the Labels section is missing", () => {
    const { errors } = parseWorksheet("# no labels here", file)
    expect(errors).toEqual(['worksheet has no "## Labels" section'])
  })
})

// ─── io helpers ──────────────────────────────────────────────────

describe("parseTarget", () => {
  it("accepts OWNER/REPO + --pr", () => {
    expect(parseTarget({ repo: "Sigilix/sigilix", pr: "365" })).toEqual({
      owner: "Sigilix",
      repo: "sigilix",
      pr: 365,
    })
  })
  it("accepts the OWNER/REPO#PR shorthand", () => {
    expect(parseTarget({ repo: "Sigilix/sigilix#42" })).toEqual({
      owner: "Sigilix",
      repo: "sigilix",
      pr: 42,
    })
  })
  it("rejects a malformed repo and a non-positive PR", () => {
    expect(() => parseTarget({ repo: "not-a-repo", pr: "1" })).toThrow(/OWNER\/REPO/)
    expect(() => parseTarget({ repo: "o/r", pr: "0" })).toThrow(/positive integer/)
    expect(() => parseTarget({ repo: "o/r", pr: "x" })).toThrow(/positive integer/)
  })
})

describe("comparisonBasename", () => {
  it("joins owner/repo/pr and sanitizes unsafe chars", () => {
    expect(comparisonBasename("Sigilix", "sigilix", 365)).toBe("Sigilix-sigilix-365")
    expect(comparisonBasename("a/b", "c", 1)).toBe("a_b-c-1")
  })
})

describe("mergeComparison", () => {
  it("takes fresh findings but preserves prior labels", () => {
    const prev = emptyFile({
      items: [{ id: 1, findings: ["s1"], outcome: "real_bug", category: "logic", note: "" }],
    })
    const merged = mergeComparison(prev, {
      owner: "o",
      repo: "r",
      pr: 1,
      prUrl: "https://github.com/o/r/pull/1",
      collectedAt: "2026-06-06T00:00:00.000Z",
      findings: {
        sigilix: [{ ref: "s1", tool: "sigilix", commentId: 9, path: null, line: null, excerpt: "x", url: "u" }],
        coderabbit: [],
        greptile: [],
      },
    })
    expect(merged.items).toEqual(prev.items)
    expect(merged.collectedAt).toBe("2026-06-06T00:00:00.000Z")
    expect(merged.findings.sigilix).toHaveLength(1)
  })
  it("starts items empty with no prior file", () => {
    expect(mergeComparison(null, {
      owner: "o", repo: "r", pr: 1, prUrl: "u", collectedAt: "t",
      findings: { sigilix: [], coderabbit: [], greptile: [] },
    }).items).toEqual([])
  })
})

// ─── summary ─────────────────────────────────────────────────────

function finding(ref: string, tool: "sigilix" | "coderabbit" | "greptile", commentId: number) {
  return { ref, tool, commentId, path: "src/a.ts", line: 1, excerpt: ref, url: `u-${ref}` }
}

function fileWithItems(items: LabeledItem[]): ComparisonFile {
  return emptyFile({
    findings: {
      sigilix: [finding("s1", "sigilix", 1), finding("s2", "sigilix", 2), finding("s3", "sigilix", 3)],
      coderabbit: [finding("c1", "coderabbit", 4), finding("c2", "coderabbit", 5), finding("c3", "coderabbit", 6)],
      greptile: [finding("g1", "greptile", 7), finding("g2", "greptile", 8)],
    },
    items,
  })
}

describe("summarize", () => {
  it("tallies outcomes, categories, precision, recall, overlap, and unique metrics", () => {
    const files = [
      fileWithItems([
        { id: 1, findings: ["s1", "c1", "g1"], outcome: "real_bug", category: "logic", note: "" },
        { id: 2, findings: ["s2"], outcome: "real_bug", category: "security", note: "" },
        { id: 3, findings: ["s3"], outcome: "noise", category: "style", note: "" },
      ]),
      fileWithItems([
        { id: 1, findings: ["c1"], outcome: "real_bug", category: "perf", note: "" },
        { id: 2, findings: ["c2"], outcome: "noise", category: "style", note: "" },
        { id: 3, findings: ["s1", "c3"], outcome: "noise", category: "tests", note: "" },
        { id: 4, findings: [], outcome: "real_bug", category: "logic", note: "missed by all" },
      ]),
    ]
    const r = summarize(files)
    expect(r.filesCollected).toBe(2)
    expect(r.filesLabeled).toBe(2)
    expect(r.totalItems).toBe(7)
    expect(r.byOutcome.real_bug).toBe(4)
    expect(r.byOutcome.noise).toBe(3)

    expect(r.byTool.sigilix.flagged).toBe(4)
    expect(r.byTool.sigilix.real).toBe(2)
    expect(r.byTool.sigilix.precision).toBeCloseTo(0.5)
    expect(r.byTool.sigilix.recall).toBeCloseTo(0.5)
    expect(r.byTool.coderabbit.flagged).toBe(4)
    expect(r.byTool.coderabbit.real).toBe(2)
    expect(r.byTool.greptile.flagged).toBe(1)
    expect(r.byTool.greptile.real).toBe(1)

    expect(r.totalRealBugs).toBe(4)
    expect(r.missedByAllRealBugs).toBe(1)
    expect(r.byTool.coderabbit.uniqueRealBugs).toBe(1)
    expect(r.byTool.sigilix.uniqueRealBugs).toBe(1)
    expect(r.byTool.coderabbit.onlyNoise).toBe(1)
    expect(r.pairOverlap["sigilix+coderabbit"]).toBe(2)
    expect(r.pairOverlap["sigilix+greptile"]).toBe(1)
    expect(r.byCombination["missed_by_all"]!.real).toBe(1)

    expect(r.byCategory.style.total).toBe(2)
    expect(r.byCategory.style.real).toBe(0)
    expect(r.byCategory.security.real).toBe(1)
  })

  it("reports null precision (—) when a bot flagged nothing", () => {
    const r = summarize([fileWithItems([{ id: 1, findings: ["s1"], outcome: "noise", category: "style", note: "" }])])
    expect(r.byTool.coderabbit.flagged).toBe(0)
    expect(r.byTool.coderabbit.precision).toBeNull()
    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T00:00:00.000Z" })
    expect(md).toContain("| CodeRabbit | 3 | 0 | 0 | 0 | — | — | 0 | 0 |")
  })
})

describe("formatSummaryMarkdown", () => {
  it("renders the matrix, precision, decision, and category sections", () => {
    const r = summarize([
      fileWithItems([
        { id: 1, findings: ["s1", "c1"], outcome: "real_bug", category: "logic", note: "" },
        { id: 2, findings: ["c2"], outcome: "real_bug", category: "security", note: "" },
      ]),
    ])
    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T12:00:00.000Z" })
    expect(md).toContain("# Reviewer head-to-head comparison")
    expect(md).toContain("2026-06-05T12:00:00.000Z")
    expect(md).toContain("## Outcome Matrix")
    expect(md).toContain("## Per-Tool Precision And Recall")
    expect(md).toContain("## Overlap")
    expect(md).toContain("| coderabbit | 1 | 0 | 1 |")
    expect(md).toContain("## By category")
  })

  it("warns when a tool has zero collected comments, so recall is not over-read", () => {
    const r = summarize([
      emptyFile({
        items: [
          { id: 1, findings: [], outcome: "real_bug", category: "logic", note: "seeded bug missed by all" },
        ],
      }),
    ])
    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T12:00:00.000Z" })
    expect(md).toContain("had zero collected comments")
    expect(md).toContain("recall for those tools as not interpretable")
  })
})

// ─── end-to-end (raw comments → worksheet → labels → report) ─────

describe("end-to-end pipeline", () => {
  it("flows raw comments through normalize → worksheet → parse → summarize", () => {
    const raw: RawComment[] = [
      comment({ id: 100, path: "src/auth.ts", line: 22, body: "<!-- sigilix:pr-review-finding -->\n**security:** token logged in plaintext\n<!-- sigilix:category:security -->" }),
      comment({ id: 101, user: { login: CR }, path: "src/auth.ts", line: 22, body: "Potential issue: secret written to logs" }),
      comment({ id: 102, user: { login: CR }, path: "README.md", line: 1, body: "Nitpick: trailing whitespace" }),
      comment({ id: 103, user: { login: GREPTILE }, path: "src/auth.ts", line: 22, body: "Secret appears in log output" }),
      comment({ id: 104, user: { login: "human" }, body: "looks good" }),
    ]
    const file = emptyFile({ findings: normalizeFindings(raw) })
    expect(file.findings.sigilix.map((f) => f.ref)).toEqual(["s1"])
    expect(file.findings.coderabbit.map((f) => f.ref)).toEqual(["c1", "c2"])
    expect(file.findings.greptile.map((f) => f.ref)).toEqual(["g1"])

    const filled = fillWorksheet(buildWorksheet(file), [
      "| s1,c1,g1 | real_bug | security | secret logged |",
      "| c2 | noise | style | |",
      "| none | real_bug | logic | known seeded bug no tool caught |",
    ])
    const parsed = parseWorksheet(filled, file)
    expect(parsed.errors).toEqual([])
    file.items = parsed.items

    const r = summarize([file])
    expect(r.byOutcome.real_bug).toBe(2)
    expect(r.byTool.coderabbit.onlyNoise).toBe(1)
    expect(r.byTool.sigilix.precision).toBe(1) // 1 flagged, 1 real
    expect(r.byTool.sigilix.recall).toBeCloseTo(0.5)
    expect(r.missedByAllRealBugs).toBe(1)
    expect(r.byCategory.security.real).toBe(1)

    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T00:00:00.000Z" })
    expect(md).toContain("missed by all compared tools: **1**")
  })
})
