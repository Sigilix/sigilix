// SIG-161 PR 4b — collector parser tests.
// The script's CLI + `gh api` calls aren't unit-tested (they need the
// network); we cover the pure helpers — `parseFinding` and
// `splitConcatenatedJsonArrays` — which are the load-bearing logic.

import { describe, expect, it } from "vitest"
import {
  parseFinding,
  splitConcatenatedJsonArrays,
} from "../scripts/collect-sig-161-findings"
import {
  formatFindingComment,
  type PrReviewFinding,
} from "../src/lib/triage-pr-review"

const baseComment = {
  id: 123456,
  user: { login: "sigilix[bot]" },
  path: "src/lib/foo.ts",
  line: 42,
  start_line: null,
  body: "",
  pull_request_review_id: null,
  created_at: "2026-05-22T10:00:00Z",
  html_url: "https://github.com/owner/repo/pull/138#discussion_r123456",
}

const baseArgs = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 138,
  prUrl: "https://github.com/Sigilix/sigilix/pull/138",
  headSha: "abc1234567890",
}

describe("parseFinding (SIG-161)", () => {
  it("parses a canonical Sigilix bot finding (heading + marker)", () => {
    const body = [
      "<!-- sigilix:pr-review-finding -->",
      "🟠 P1 · **testing:** New `scheduled` cron handler lacks test coverage · _confidence: 3/5_",
      "",
      "The `scheduled` handler at `src/index.ts:960` implements the index reconciliation cron tick.",
      "",
      "<!-- sigilix:fid:6133bdb79f7b71af:cat:tests:sev:warning:path:a2a171449d86 -->",
    ].join("\n")
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body },
    })
    expect(row).not.toBeNull()
    expect(row!.findingId).toMatch(/^[0-9a-f]{16}$/)
    expect(row!.category).toBe("testing")
    expect(row!.headline).toContain("scheduled")
    expect(row!.confidence).toBe(3)
    expect(row!.score).toBe(4) // sev:warning → 4
    expect(row!.sigilixFid).toBe("6133bdb79f7b71af")
    expect(row!.sigilixSev).toBe("warning")
    expect(row!.body).toContain("reconciliation cron tick")
    expect(row!.body).not.toContain("sigilix:pr-review-finding")
    expect(row!.body).not.toContain("sigilix:fid:")
  })

  it("parses the previous headline-first finding shape with visible metadata", () => {
    const body = [
      "<!-- sigilix:pr-review-finding -->",
      '<a href="https://sigilix.ai"><img alt="P1" src="https://badges.example/p1.svg" align="top" width="34" height="24"></a> **New `scheduled` cron handler lacks test coverage**',
      "_category: testing_ · _severity: P1 high (4/5)_ · _confidence: 3/5_",
      "",
      "The `scheduled` handler at `src/index.ts:960` implements the index reconciliation cron tick.",
      "",
      "<!-- sigilix:fid:6133bdb79f7b71af:cat:testing:sev:warning:path:a2a171449d86 -->",
    ].join("\n")
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body },
    })
    expect(row).not.toBeNull()
    expect(row!.category).toBe("testing")
    expect(row!.headline).toContain("scheduled")
    expect(row!.confidence).toBe(3)
    expect(row!.body).toContain("reconciliation cron tick")
    expect(row!.body).not.toContain("_category: testing_")
  })

  it("parses the current quiet headline-first finding shape", () => {
    const body = [
      "<!-- sigilix:pr-review-finding -->",
      '<a href="https://sigilix.ai"><img alt="P1" src="https://badges.example/p1.svg" align="top" width="34" height="24"></a> **New `scheduled` cron handler lacks test coverage**',
      "<!-- sigilix:confidence:3 -->",
      "",
      "The `scheduled` handler at `src/index.ts:960` implements the index reconciliation cron tick.",
      "",
      "<!-- sigilix:fid:6133bdb79f7b71af:cat:testing:sev:warning:path:a2a171449d86 -->",
    ].join("\n")
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body },
    })
    expect(row).not.toBeNull()
    expect(row!.category).toBe("testing")
    expect(row!.headline).toContain("scheduled")
    expect(row!.confidence).toBe(3)
    expect(row!.body).toContain("reconciliation cron tick")
    expect(row!.body).not.toContain("sigilix:confidence")
  })

  it("round-trips the current renderer shape through the collector parser", () => {
    const finding: PrReviewFinding = {
      path: "src/index.ts",
      line: 960,
      score: 4,
      category: "testing",
      headline: "New `scheduled` cron handler lacks test coverage",
      body: "The `scheduled` handler implements the index reconciliation cron tick.",
    }
    const body = [
      formatFindingComment(finding, 3),
      "<!-- sigilix:fid:6133bdb79f7b71af:cat:testing:sev:warning:path:a2a171449d86 -->",
    ].join("\n\n")

    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body },
    })

    expect(row).not.toBeNull()
    expect(row!.category).toBe("testing")
    expect(row!.headline).toBe(finding.headline)
    expect(row!.confidence).toBe(3)
    expect(row!.body).toContain("reconciliation cron tick")
  })

  it("skips non-Sigilix-bot comments (CodeRabbit, human review)", () => {
    const cr = parseFinding({
      ...baseArgs,
      comment: {
        ...baseComment,
        user: { login: "coderabbitai[bot]" },
        body: "<!-- sigilix:pr-review-finding -->\n**logic:** something",
      },
    })
    expect(cr).toBeNull()

    const human = parseFinding({
      ...baseArgs,
      comment: {
        ...baseComment,
        user: { login: "alice" },
        body: "<!-- sigilix:pr-review-finding -->\nfake",
      },
    })
    expect(human).toBeNull()
  })

  it("skips Sigilix comments without the finding marker (overviews, mention replies)", () => {
    const overview = parseFinding({
      ...baseArgs,
      comment: {
        ...baseComment,
        body: "<!-- sigilix:pr-overview -->\n## Sigilix Overview\nThis PR…",
      },
    })
    expect(overview).toBeNull()

    const mentionReply = parseFinding({
      ...baseArgs,
      comment: {
        ...baseComment,
        body: "<!-- sigilix:gh-mention-reply -->\nYou're right — withdrawing.",
      },
    })
    expect(mentionReply).toBeNull()
  })

  it("preserves the comment when the heading is malformed (best-effort, body still kept)", () => {
    // A future renderer change could break the heading regex. Don't lose
    // the finding — the labeler still gets the body to judge from.
    const body = [
      "<!-- sigilix:pr-review-finding -->",
      "## Unexpected heading shape that doesn't match the regex",
      "",
      "Body content that the labeler still needs to see.",
      "",
      "<!-- sigilix:fid:abcdef0123456789:cat:logic:sev:info:path:0000000000aa -->",
    ].join("\n")
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body },
    })
    expect(row).not.toBeNull()
    expect(row!.category).toBe("logic") // recovered from the marker
    expect(row!.score).toBe(3)          // sev:info → 3
    expect(row!.confidence).toBeUndefined()
    expect(row!.headline).toBeUndefined()
    expect(row!.body).toContain("Body content that the labeler still needs to see")
  })

  it("produces a STABLE findingId across re-runs", () => {
    const body =
      "<!-- sigilix:pr-review-finding -->\n**logic:** x · _confidence: 4/5_\n\nbody\n<!-- sigilix:fid:abc:cat:logic:sev:warning:path:def -->"
    const a = parseFinding({ ...baseArgs, comment: { ...baseComment, body } })
    const b = parseFinding({ ...baseArgs, comment: { ...baseComment, body } })
    expect(a!.findingId).toBe(b!.findingId)
  })

  it("differentiates findingIds across PRs / repos", () => {
    const body =
      "<!-- sigilix:pr-review-finding -->\n**logic:** x · _confidence: 4/5_\n\nb\n<!-- sigilix:fid:abc:cat:logic:sev:warning:path:def -->"
    const a = parseFinding({ ...baseArgs, comment: { ...baseComment, body } })
    const b = parseFinding({ ...baseArgs, prNumber: 139, comment: { ...baseComment, body } })
    const c = parseFinding({
      ...baseArgs, repo: "rubberfit",
      comment: { ...baseComment, body },
    })
    expect(a!.findingId).not.toBe(b!.findingId)
    expect(a!.findingId).not.toBe(c!.findingId)
  })

  it("handles missing optional fields (line=null start_line=null) without throwing", () => {
    const body =
      "<!-- sigilix:pr-review-finding -->\n**security:** x · _confidence: 5/5_\n\nbody\n<!-- sigilix:fid:abc:cat:security:sev:critical:path:def -->"
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, line: null, start_line: null, body },
    })
    expect(row).not.toBeNull()
    expect(row!.line).toBeNull()
    expect(row!.startLine).toBeNull()
    expect(row!.score).toBe(5)
  })

  it("caps body at 4000 chars (labeler safety)", () => {
    const longBody =
      "<!-- sigilix:pr-review-finding -->\n**logic:** x · _confidence: 3/5_\n\n" +
      "x".repeat(10_000) +
      "\n<!-- sigilix:fid:abc:cat:logic:sev:info:path:def -->"
    const row = parseFinding({
      ...baseArgs,
      comment: { ...baseComment, body: longBody },
    })
    expect(row!.body!.length).toBeLessThanOrEqual(4000)
  })
})

describe("splitConcatenatedJsonArrays (SIG-161)", () => {
  it("splits a single array into one element", () => {
    expect(splitConcatenatedJsonArrays('[1,2,3]')).toEqual(['[1,2,3]'])
  })

  it("splits two concatenated arrays", () => {
    expect(splitConcatenatedJsonArrays('[1,2][3,4]')).toEqual(['[1,2]', '[3,4]'])
  })

  it("handles nested arrays inside top-level arrays", () => {
    const s = '[[1,2],[3,4]][[5,6]]'
    expect(splitConcatenatedJsonArrays(s)).toEqual(['[[1,2],[3,4]]', '[[5,6]]'])
  })

  it("ignores brackets inside JSON strings", () => {
    const s = '[{"a":"[oops]"}][{"b":"]"}]'
    expect(splitConcatenatedJsonArrays(s)).toEqual(['[{"a":"[oops]"}]', '[{"b":"]"}]'])
  })

  it("handles escaped quotes in strings", () => {
    const s = '[{"a":"x\\"]"}]'
    expect(splitConcatenatedJsonArrays(s)).toEqual(['[{"a":"x\\"]"}]'])
  })

  it("returns empty list on empty input", () => {
    expect(splitConcatenatedJsonArrays("")).toEqual([])
  })

  it("survives whitespace and newlines between arrays", () => {
    const s = '[1]\n[2]\n  [3]'
    expect(splitConcatenatedJsonArrays(s)).toEqual(['[1]', '[2]', '[3]'])
  })
})
