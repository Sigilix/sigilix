// SIG-70 — compare-reviewers tool tests.
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
    schemaVersion: 1,
    owner: "o",
    repo: "r",
    pr: 1,
    prUrl: "https://github.com/o/r/pull/1",
    collectedAt: "2026-06-05T00:00:00.000Z",
    findings: { sigilix: [], coderabbit: [] },
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
        { ref: "s1", bot: "sigilix", commentId: 10, path: "src/a.ts", line: 5, excerpt: "null deref", url: "u1", botCategory: "logic" },
      ],
      coderabbit: [
        { ref: "c1", bot: "coderabbit", commentId: 11, path: "src/a.ts", line: 5, excerpt: "deref of null", url: "u2" },
        { ref: "c2", bot: "coderabbit", commentId: 12, path: "README.md", line: null, excerpt: "typo", url: "u3" },
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
    expect(md).toContain("## Labels")
    expect(md).toContain("both_noise") // the legend lists every label
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
      "| s1,c1 | both_real | logic | both caught it |",
      "| c2 | cr_only_noise | style | |",
    ])
    const { items, errors, notes } = parseWorksheet(md, file)
    expect(errors).toEqual([])
    expect(notes).toEqual([])
    expect(items).toEqual<LabeledItem[]>([
      { id: 1, findings: ["s1", "c1"], label: "both_real", category: "logic", note: "both caught it" },
      { id: 2, findings: ["c2"], label: "cr_only_noise", category: "style", note: "" },
    ])
  })

  it("rejects an unknown label and an unknown category", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | maybe_real | logic | |",
      "| c1 | both_real | databases | |",
    ])
    const { items, errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('invalid label "maybe_real"'))).toBe(true)
    expect(errors.some((e) => e.includes('invalid category "databases"'))).toBe(true)
    expect(items).toHaveLength(0)
  })

  it("rejects an unknown finding ref", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s9 | sigilix_only_real_bug | logic | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('unknown finding ref "s9"'))).toBe(true)
  })

  it("rejects the same finding labeled in two rows", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | sigilix_only_real_bug | logic | |",
      "| s1 | sigilix_only_noise | logic | |",
    ])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes('"s1" already labeled in row 1'))).toBe(true)
  })

  it("rejects a both_* row missing one bot's ref", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s1 | both_real | logic | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes("needs both a Sigilix"))).toBe(true)
  })

  it("rejects a sigilix_only_* row that lists a CodeRabbit ref", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s1,c1 | sigilix_only_real_bug | logic | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes("Sigilix-only but lists a CodeRabbit"))).toBe(true)
  })

  it("rejects a cr_only_* row that lists a Sigilix ref", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s1,c1 | cr_only_noise | style | |"])
    const { errors } = parseWorksheet(md, file)
    expect(errors.some((e) => e.includes("CodeRabbit-only but lists a Sigilix"))).toBe(true)
  })

  it("preserves a literal pipe in the note cell (no truncation at the first |)", () => {
    const md = fillWorksheet(buildWorksheet(file), [
      "| s1 | sigilix_only_real_bug | logic | use a || b here |",
    ])
    const { items, errors } = parseWorksheet(md, file)
    expect(errors).toEqual([])
    expect(items[0]!.note).toBe("use a || b here")
  })

  it("reports unlabeled findings as a note, not a blocking error", () => {
    const md = fillWorksheet(buildWorksheet(file), ["| s1,c1 | both_real | logic | |"])
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
      items: [{ id: 1, findings: ["s1"], label: "sigilix_only_real_bug", category: "logic", note: "" }],
    })
    const merged = mergeComparison(prev, {
      owner: "o",
      repo: "r",
      pr: 1,
      prUrl: "https://github.com/o/r/pull/1",
      collectedAt: "2026-06-06T00:00:00.000Z",
      findings: { sigilix: [{ ref: "s1", bot: "sigilix", commentId: 9, path: null, line: null, excerpt: "x", url: "u" }], coderabbit: [] },
    })
    expect(merged.items).toEqual(prev.items)
    expect(merged.collectedAt).toBe("2026-06-06T00:00:00.000Z")
    expect(merged.findings.sigilix).toHaveLength(1)
  })
  it("starts items empty with no prior file", () => {
    expect(mergeComparison(null, {
      owner: "o", repo: "r", pr: 1, prUrl: "u", collectedAt: "t",
      findings: { sigilix: [], coderabbit: [] },
    }).items).toEqual([])
  })
})

// ─── summary ─────────────────────────────────────────────────────

function fileWithItems(items: LabeledItem[]): ComparisonFile {
  return emptyFile({ items })
}

describe("summarize", () => {
  it("tallies labels, categories, precision, overlap, and decision metrics", () => {
    const files = [
      fileWithItems([
        { id: 1, findings: ["s1", "c1"], label: "both_real", category: "logic", note: "" },
        { id: 2, findings: ["s2"], label: "sigilix_only_real_bug", category: "security", note: "" },
        { id: 3, findings: ["s3"], label: "sigilix_only_noise", category: "style", note: "" },
      ]),
      fileWithItems([
        { id: 1, findings: ["c1"], label: "cr_only_real_bug", category: "perf", note: "" },
        { id: 2, findings: ["c2"], label: "cr_only_noise", category: "style", note: "" },
        { id: 3, findings: ["s1", "c3"], label: "both_noise", category: "tests", note: "" },
      ]),
    ]
    const r = summarize(files)
    expect(r.filesCollected).toBe(2)
    expect(r.filesLabeled).toBe(2)
    expect(r.totalItems).toBe(6)
    expect(r.byLabel.both_real).toBe(1)
    expect(r.byLabel.sigilix_only_real_bug).toBe(1)
    expect(r.byLabel.cr_only_noise).toBe(1)

    // Sigilix flagged: both_real, sig_only_real, sig_only_noise, both_noise = 4; real = 2
    expect(r.sigilix.flagged).toBe(4)
    expect(r.sigilix.real).toBe(2)
    expect(r.sigilix.precision).toBeCloseTo(0.5)
    // CR flagged: both_real, cr_only_real, cr_only_noise, both_noise = 4; real = 2
    expect(r.coderabbit.flagged).toBe(4)
    expect(r.coderabbit.real).toBe(2)

    expect(r.overlap).toBe(2) // both_real + both_noise
    expect(r.crUniqueRealBugs).toBe(1)
    expect(r.sigilixUniqueRealBugs).toBe(1)
    expect(r.crOnlyNoise).toBe(1)

    expect(r.byCategory.style.total).toBe(2)
    expect(r.byCategory.style.real).toBe(0)
    expect(r.byCategory.security.real).toBe(1)
  })

  it("reports null precision (—) when a bot flagged nothing", () => {
    const r = summarize([fileWithItems([{ id: 1, findings: ["s1"], label: "sigilix_only_noise", category: "style", note: "" }])])
    expect(r.coderabbit.flagged).toBe(0)
    expect(r.coderabbit.precision).toBeNull()
    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T00:00:00.000Z" })
    expect(md).toContain("| CodeRabbit | 0 | 0 | 0 | — |")
  })
})

describe("formatSummaryMarkdown", () => {
  it("renders the matrix, precision, decision, and category sections", () => {
    const r = summarize([
      fileWithItems([
        { id: 1, findings: ["s1", "c1"], label: "both_real", category: "logic", note: "" },
        { id: 2, findings: ["c2"], label: "cr_only_real_bug", category: "security", note: "" },
      ]),
    ])
    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T12:00:00.000Z" })
    expect(md).toContain("# Sigilix vs CodeRabbit — head-to-head comparison")
    expect(md).toContain("2026-06-05T12:00:00.000Z")
    expect(md).toContain("## Label matrix")
    expect(md).toContain("## Per-bot precision")
    expect(md).toContain("## Decision support")
    expect(md).toContain("real bugs only CodeRabbit caught: **1**")
    expect(md).toContain("## By category")
  })
})

// ─── end-to-end (raw comments → worksheet → labels → report) ─────

describe("end-to-end pipeline", () => {
  it("flows raw comments through normalize → worksheet → parse → summarize", () => {
    const raw: RawComment[] = [
      comment({ id: 100, path: "src/auth.ts", line: 22, body: "<!-- sigilix:pr-review-finding -->\n**security:** token logged in plaintext\n<!-- sigilix:category:security -->" }),
      comment({ id: 101, user: { login: CR }, path: "src/auth.ts", line: 22, body: "Potential issue: secret written to logs" }),
      comment({ id: 102, user: { login: CR }, path: "README.md", line: 1, body: "Nitpick: trailing whitespace" }),
      comment({ id: 103, user: { login: "human" }, body: "looks good" }),
    ]
    const file = emptyFile({ findings: normalizeFindings(raw) })
    expect(file.findings.sigilix.map((f) => f.ref)).toEqual(["s1"])
    expect(file.findings.coderabbit.map((f) => f.ref)).toEqual(["c1", "c2"])

    const filled = fillWorksheet(buildWorksheet(file), [
      "| s1,c1 | both_real | security | secret logged |",
      "| c2 | cr_only_noise | style | |",
    ])
    const parsed = parseWorksheet(filled, file)
    expect(parsed.errors).toEqual([])
    file.items = parsed.items

    const r = summarize([file])
    expect(r.byLabel.both_real).toBe(1)
    expect(r.crOnlyNoise).toBe(1)
    expect(r.sigilix.precision).toBe(1) // 1 flagged, 1 real
    expect(r.byCategory.security.real).toBe(1)

    const md = formatSummaryMarkdown(r, { generatedIso: "2026-06-05T00:00:00.000Z" })
    expect(md).toContain("real bugs only CodeRabbit caught: **0**")
  })
})
