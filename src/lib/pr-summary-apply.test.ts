// SIG-437 — pure managed-block merge helper tests. Covers the idempotency
// matrix Codex flagged: replace-the-marker (first apply), replace-the-block
// (re-edit), byte-for-byte no-op on identical re-apply, and the malformed-fence
// cases (duplicate start, missing end, reversed markers) which must NEVER
// double-fence — they fall through to the trigger-line replace or to no-op.

import { describe, it, expect } from "vitest"

import {
  SUMMARY_MARKERS,
  applySummaryToBody,
  hasSummaryBlock,
  hasSummaryTrigger,
  stripSummaryBlock,
  summaryTriggerRegex,
} from "@/src/lib/pr-summary-apply"

const START = SUMMARY_MARKERS.start
const END = SUMMARY_MARKERS.end

describe("summaryTriggerRegex", () => {
  it("matches a `@sigilix summary` line, case-insensitively, anchored", () => {
    const re = summaryTriggerRegex(["sigilix"])
    expect(re.test("@sigilix summary")).toBe(true)
    expect(re.test("  @Sigilix   SUMMARY  ")).toBe(true)
    expect(re.test("text\n@sigilix summary\nmore")).toBe(true)
  })

  it("does NOT match `@sigilix summary` mid-sentence (not its own line)", () => {
    const re = summaryTriggerRegex(["sigilix"])
    expect(re.test("please @sigilix summary this")).toBe(false)
    expect(re.test("@sigilix summarize")).toBe(false)
    expect(re.test("@sigilix review")).toBe(false)
  })

  it("honors custom triggers and prefers the longest handle", () => {
    const re = summaryTriggerRegex(["sigilix", "sigilix[bot]"])
    expect(re.test("@sigilix[bot] summary")).toBe(true)
    expect(re.test("@sigilix summary")).toBe(true)
  })
})

describe("hasSummaryBlock / stripSummaryBlock", () => {
  it("detects a well-formed block and strips it", () => {
    const body = `intro\n\n${START}\ngenerated\n${END}\n\noutro`
    expect(hasSummaryBlock(body)).toBe(true)
    expect(stripSummaryBlock(body)).toBe("intro\n\n\n\noutro")
  })

  it("rejects reversed markers (end before start)", () => {
    const body = `${END}\nx\n${START}`
    expect(hasSummaryBlock(body)).toBe(false)
    // nothing usable to strip → unchanged
    expect(stripSummaryBlock(body)).toBe(body)
  })

  it("treats a stray inner start as block content (start … start … end → one block)", () => {
    // The inner start sits inside the first start→end pair, so it's content of a
    // single block — stripped/replaced whole, not orphaned.
    const body = `${START}\na\n${START}\nb\n${END}`
    expect(hasSummaryBlock(body)).toBe(true)
    expect(stripSummaryBlock(body)).toBe("")
  })

  it("SIG-437 P1: TWO complete blocks collapse to ONE on apply (never double-fence)", () => {
    const body = `intro\n${START}\nold1\n${END}\nmid\n${START}\nold2\n${END}\noutro`
    expect(hasSummaryBlock(body)).toBe(true)
    // strip removes BOTH managed blocks
    expect(stripSummaryBlock(body)).toBe("intro\n\nmid\n\noutro")
    // apply collapses to a SINGLE fresh block at the first block's position
    const out = applySummaryToBody({ currentBody: body, sectionContent: "fresh" })
    expect(out).toBe(`intro\n${START}\nfresh\n${END}\nmid\n\noutro`)
    expect(out.split(START).length - 1).toBe(1)
    expect(out.split(END).length - 1).toBe(1)
    // idempotent: re-apply same content → byte-identical
    expect(applySummaryToBody({ currentBody: out, sectionContent: "fresh" })).toBe(out)
  })

  it("rejects a missing-end shape (start with no end)", () => {
    const body = `${START}\nonly a start`
    expect(hasSummaryBlock(body)).toBe(false)
  })
})

describe("hasSummaryTrigger", () => {
  it("is true for a trigger line, false otherwise", () => {
    expect(hasSummaryTrigger("@sigilix summary")).toBe(true)
    expect(hasSummaryTrigger("no marker here")).toBe(false)
    expect(hasSummaryTrigger("")).toBe(false)
  })
})

describe("applySummaryToBody — mode 2: replace the trigger line (first apply)", () => {
  it("replaces a standalone `@sigilix summary` line with the fenced block, preserving surrounding prose", () => {
    const body = "## Context\n\nSome author prose.\n\n@sigilix summary\n\n## Footer"
    const out = applySummaryToBody({ currentBody: body, sectionContent: "## What\n\nDoes the thing." })
    expect(out).toBe(
      "## Context\n\nSome author prose.\n\n" + `${START}\n## What\n\nDoes the thing.\n${END}` + "\n\n## Footer",
    )
    // the trigger line is gone; exactly one managed block exists
    expect(out).not.toMatch(/@sigilix summary/i)
    expect(out.match(new RegExp(escapeRe(START), "g"))?.length).toBe(1)
    expect(out.match(new RegExp(escapeRe(END), "g"))?.length).toBe(1)
  })

  it("inserts `$`-bearing generated content LITERALLY (no String.replace pattern expansion)", () => {
    // Regression for the P1: `$&`, `$\``, `$'`, `$1` in the model output must NOT
    // be interpreted as replacement-string special patterns (which would splice
    // the matched trigger / surrounding body text into the description).
    const body = "BEFORE\n\n@sigilix summary\n\nAFTER"
    const sectionContent = "shell: `s/x/$&/` and $` and $' and $1 and $$"
    const out = applySummaryToBody({ currentBody: body, sectionContent })
    expect(out).toBe(`BEFORE\n\n${START}\n${sectionContent}\n${END}\n\nAFTER`)
    // the literal sequences survive intact; no body text leaked into the block
    expect(out).toContain("s/x/$&/")
    expect(out).toContain("$` and $' and $1 and $$")
    expect(out).not.toContain("@sigilix summary")
  })
})

describe("applySummaryToBody — mode 1: replace the managed block (re-edit)", () => {
  it("replaces only the block interior, preserving content outside", () => {
    const body = `before\n\n${START}\nOLD CONTENT\n${END}\n\nafter`
    const out = applySummaryToBody({ currentBody: body, sectionContent: "NEW CONTENT" })
    expect(out).toBe(`before\n\n${START}\nNEW CONTENT\n${END}\n\nafter`)
  })

  it("is byte-for-byte idempotent: applying the same content twice == once", () => {
    const body = "intro\n\n@sigilix summary\n\noutro"
    const once = applySummaryToBody({ currentBody: body, sectionContent: "## What\n\nThing.\n" })
    const twice = applySummaryToBody({ currentBody: once, sectionContent: "## What\n\nThing.\n" })
    expect(twice).toBe(once)
  })

  it("trims trailing whitespace on the inner content so re-apply doesn't accrete blank lines", () => {
    const a = applySummaryToBody({ currentBody: "@sigilix summary", sectionContent: "body\n\n\n" })
    const b = applySummaryToBody({ currentBody: a, sectionContent: "body\n\n\n" })
    expect(a).toBe(`${START}\nbody\n${END}`)
    expect(b).toBe(a)
  })

  it("prefers the block over a leftover trigger line (block wins when both present)", () => {
    // degenerate: a block AND a stray trigger line both present → mode 1
    const body = `${START}\nOLD\n${END}\n\n@sigilix summary`
    const out = applySummaryToBody({ currentBody: body, sectionContent: "NEW" })
    expect(out).toBe(`${START}\nNEW\n${END}\n\n@sigilix summary`)
  })
})

describe("applySummaryToBody — mode 3: no-op, and malformed fences never double-fence", () => {
  it("returns the body unchanged when neither block nor trigger is present", () => {
    const body = "just a normal PR body, nothing to do"
    expect(applySummaryToBody({ currentBody: body, sectionContent: "x" })).toBe(body)
  })

  it("treats empty/null/undefined body as no-op (no trigger to replace)", () => {
    expect(applySummaryToBody({ currentBody: "", sectionContent: "x" })).toBe("")
    expect(applySummaryToBody({ currentBody: null, sectionContent: "x" })).toBe("")
    expect(applySummaryToBody({ currentBody: undefined, sectionContent: "x" })).toBe("")
  })

  it("does NOT append when only a malformed (reversed) fence pair exists and no trigger line", () => {
    const body = `${END}\nstuff\n${START}`
    const out = applySummaryToBody({ currentBody: body, sectionContent: "NEW" })
    // unchanged — never appends a fresh fenced block onto a malformed one
    expect(out).toBe(body)
    expect(out.match(new RegExp(escapeRe(START), "g"))?.length).toBe(1)
  })

  it("with a malformed fence AND a trigger line, replaces only the trigger line (no double-fence)", () => {
    const body = `${END}\nbroken\n${START}\n\n@sigilix summary`
    const out = applySummaryToBody({ currentBody: body, sectionContent: "NEW" })
    // the trigger line became a block; the broken pair is left for manual cleanup
    expect(out).toContain(`${START}\nNEW\n${END}`)
    expect(out).not.toMatch(/@sigilix summary/i)
  })
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
