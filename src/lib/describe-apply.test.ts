// ARC-264 — pure body-merge helper tests.

import { describe, it, expect } from "vitest"

import {
  applyDescribeToBody,
  describeMarkers,
} from "@/src/lib/describe-apply"

describe("describeMarkers", () => {
  it("returns the start + end marker strings for each mode", () => {
    expect(describeMarkers("pr-description")).toEqual({
      start: "<!-- sigilix:describe:pr-description:start -->",
      end: "<!-- sigilix:describe:pr-description:end -->",
    })
    expect(describeMarkers("internal-changelog")).toEqual({
      start: "<!-- sigilix:describe:internal-changelog:start -->",
      end: "<!-- sigilix:describe:internal-changelog:end -->",
    })
    expect(describeMarkers("external-changelog")).toEqual({
      start: "<!-- sigilix:describe:external-changelog:start -->",
      end: "<!-- sigilix:describe:external-changelog:end -->",
    })
  })
})

describe("applyDescribeToBody — empty body", () => {
  it("returns just the marker-fenced block + trailing newline when current body is empty", () => {
    const out = applyDescribeToBody({
      currentBody: "",
      mode: "pr-description",
      sectionContent: "## Summary\n\nAdds the widget.",
    })
    expect(out).toBe(
      "<!-- sigilix:describe:pr-description:start -->\n" +
      "## Summary\n\nAdds the widget.\n" +
      "<!-- sigilix:describe:pr-description:end -->\n"
    )
  })

  it("treats null / undefined / whitespace-only bodies as empty (same shape)", () => {
    const expected =
      "<!-- sigilix:describe:pr-description:start -->\n" +
      "x\n" +
      "<!-- sigilix:describe:pr-description:end -->\n"
    expect(applyDescribeToBody({
      currentBody: null,
      mode: "pr-description",
      sectionContent: "x",
    })).toBe(expected)
    expect(applyDescribeToBody({
      currentBody: undefined,
      mode: "pr-description",
      sectionContent: "x",
    })).toBe(expected)
    expect(applyDescribeToBody({
      currentBody: "   \n\n  \t  \n",
      mode: "pr-description",
      sectionContent: "x",
    })).toBe(expected)
  })
})

describe("applyDescribeToBody — body without matching markers (append path)", () => {
  it("appends a new fenced block separated by a blank line, preserving the original body", () => {
    const original = "Manual PR description.\n\nLinks: https://example.com"
    const out = applyDescribeToBody({
      currentBody: original,
      mode: "pr-description",
      sectionContent: "## Summary\n\nFoo bar.",
    })
    expect(out).toBe(
      "Manual PR description.\n\nLinks: https://example.com\n\n" +
      "<!-- sigilix:describe:pr-description:start -->\n" +
      "## Summary\n\nFoo bar.\n" +
      "<!-- sigilix:describe:pr-description:end -->\n"
    )
  })

  it("trims trailing whitespace on the existing body before appending", () => {
    const out = applyDescribeToBody({
      currentBody: "Original.\n\n\n  ",
      mode: "external-changelog",
      sectionContent: "User-facing note.",
    })
    expect(out).toBe(
      "Original.\n\n" +
      "<!-- sigilix:describe:external-changelog:start -->\n" +
      "User-facing note.\n" +
      "<!-- sigilix:describe:external-changelog:end -->\n"
    )
  })

  it("ignores reversed-order markers and appends a new block (does NOT replace)", () => {
    // The end marker appears before the start marker — broken pair.
    // Auto-deleting would be destructive; we just append a fresh block
    // and leave the broken pair for the user to clean up.
    const original =
      "<!-- sigilix:describe:pr-description:end -->\n" +
      "stuff\n" +
      "<!-- sigilix:describe:pr-description:start -->"
    const out = applyDescribeToBody({
      currentBody: original,
      mode: "pr-description",
      sectionContent: "new content",
    })
    expect(out).toContain(original)
    // Two start markers + two end markers now (broken pair + the
    // freshly-appended new pair).
    expect(out.match(/sigilix:describe:pr-description:start/g)?.length).toBe(2)
    expect(out.match(/sigilix:describe:pr-description:end/g)?.length).toBe(2)
  })
})

describe("applyDescribeToBody — body WITH matching markers (replace path)", () => {
  it("replaces content between the markers, preserving content outside", () => {
    const original = [
      "Manual prose before.",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "OLD generated content",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "Manual prose after.",
    ].join("\n")
    const out = applyDescribeToBody({
      currentBody: original,
      mode: "pr-description",
      sectionContent: "NEW generated content",
    })
    expect(out).toBe([
      "Manual prose before.",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "NEW generated content",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "Manual prose after.",
    ].join("\n"))
  })

  it("user-authored content outside markers is byte-for-byte preserved across multiple applies", () => {
    let body = [
      "## Manual checklist",
      "- [x] Item A",
      "- [ ] Item B",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "auto v1",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "## Manual notes",
      "Some longer prose here.",
    ].join("\n")
    const expectedOuter = (inner: string) => [
      "## Manual checklist",
      "- [x] Item A",
      "- [ ] Item B",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      inner,
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "## Manual notes",
      "Some longer prose here.",
    ].join("\n")
    body = applyDescribeToBody({
      currentBody: body,
      mode: "pr-description",
      sectionContent: "auto v2",
    })
    expect(body).toBe(expectedOuter("auto v2"))
    body = applyDescribeToBody({
      currentBody: body,
      mode: "pr-description",
      sectionContent: "auto v3 with\nmultiple lines",
    })
    expect(body).toBe(expectedOuter("auto v3 with\nmultiple lines"))
  })

  it("only replaces the FIRST marker pair when two complete pairs exist (start…end…start…end)", () => {
    // Defensive: if the body somehow contains a start marker twice,
    // indexOf returns the first occurrence; replace ends at the
    // first end marker. Don't try to be clever; just don't crash.
    const original = [
      "<!-- sigilix:describe:pr-description:start -->",
      "A",
      "<!-- sigilix:describe:pr-description:end -->",
      "<!-- sigilix:describe:pr-description:start -->",
      "B",
      "<!-- sigilix:describe:pr-description:end -->",
    ].join("\n")
    const out = applyDescribeToBody({
      currentBody: original,
      mode: "pr-description",
      sectionContent: "NEW",
    })
    // First pair replaced; second pair untouched.
    expect(out).toBe([
      "<!-- sigilix:describe:pr-description:start -->",
      "NEW",
      "<!-- sigilix:describe:pr-description:end -->",
      "<!-- sigilix:describe:pr-description:start -->",
      "B",
      "<!-- sigilix:describe:pr-description:end -->",
    ].join("\n"))
  })

  // Code-review L8 catch: a body shaped `start … start … end` would
  // produce an orphan start marker inside the new block if we just
  // sliced from first-start to first-end. Defensive: detect a second
  // start marker before the first end and bail to the append path so
  // the broken pair stays visible for manual cleanup.
  it("falls back to append on malformed `start … start … end` (does NOT swallow the second start)", () => {
    const original = [
      "<!-- sigilix:describe:pr-description:start -->",
      "stray A",
      "<!-- sigilix:describe:pr-description:start -->",
      "stray B",
      "<!-- sigilix:describe:pr-description:end -->",
    ].join("\n")
    const out = applyDescribeToBody({
      currentBody: original,
      mode: "pr-description",
      sectionContent: "NEW",
    })
    // Original broken pair preserved verbatim (no replace inside the
    // malformed region) — both start markers + the end + a fresh
    // appended block remain.
    expect(out).toContain(original)
    expect(out.endsWith(
      "<!-- sigilix:describe:pr-description:start -->\n" +
      "NEW\n" +
      "<!-- sigilix:describe:pr-description:end -->\n"
    )).toBe(true)
    // Three start markers total now: the two strays + the freshly
    // appended pair. Two end markers: the stray and the appended.
    expect(out.match(/sigilix:describe:pr-description:start/g)?.length).toBe(3)
    expect(out.match(/sigilix:describe:pr-description:end/g)?.length).toBe(2)
  })
})

describe("applyDescribeToBody — multi-mode independence", () => {
  it("different modes coexist; replacing one leaves the others untouched", () => {
    const body = [
      "Prose.",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "pr content",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "<!-- sigilix:describe:internal-changelog:start -->",
      "internal content",
      "<!-- sigilix:describe:internal-changelog:end -->",
    ].join("\n")
    const next = applyDescribeToBody({
      currentBody: body,
      mode: "internal-changelog",
      sectionContent: "internal v2",
    })
    expect(next).toBe([
      "Prose.",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "pr content",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "<!-- sigilix:describe:internal-changelog:start -->",
      "internal v2",
      "<!-- sigilix:describe:internal-changelog:end -->",
    ].join("\n"))
  })

  it("a body with one mode's markers gets a new section for a different mode appended", () => {
    const body = [
      "<!-- sigilix:describe:pr-description:start -->",
      "pr",
      "<!-- sigilix:describe:pr-description:end -->",
    ].join("\n")
    const next = applyDescribeToBody({
      currentBody: body,
      mode: "external-changelog",
      sectionContent: "ext",
    })
    expect(next).toBe([
      "<!-- sigilix:describe:pr-description:start -->",
      "pr",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "<!-- sigilix:describe:external-changelog:start -->",
      "ext",
      "<!-- sigilix:describe:external-changelog:end -->",
      "",
    ].join("\n"))
  })
})

describe("applyDescribeToBody — idempotency", () => {
  it("applying the same content twice produces the same body", () => {
    const once = applyDescribeToBody({
      currentBody: "Manual.\n\n",
      mode: "pr-description",
      sectionContent: "auto",
    })
    const twice = applyDescribeToBody({
      currentBody: once,
      mode: "pr-description",
      sectionContent: "auto",
    })
    expect(twice).toBe(once)
  })

  it("trailing whitespace in section content does NOT accumulate across re-applies", () => {
    const once = applyDescribeToBody({
      currentBody: "",
      mode: "pr-description",
      sectionContent: "auto\n\n\n  ",
    })
    const twice = applyDescribeToBody({
      currentBody: once,
      mode: "pr-description",
      sectionContent: "auto\n\n\n  ",
    })
    expect(twice).toBe(once)
    // Confirm trailing whitespace inside the block was trimmed.
    expect(once).toBe(
      "<!-- sigilix:describe:pr-description:start -->\n" +
      "auto\n" +
      "<!-- sigilix:describe:pr-description:end -->\n"
    )
  })
})
