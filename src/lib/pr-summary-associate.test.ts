// SIG-437 — deterministic association tests: Linear ref extraction (body refs
// before branch fallback, uppercase key, no guess) and the "Related" block
// render (PRs + Linear, omitted when nothing to relate, link-text escaped).

import { describe, it, expect } from "vitest"

import { extractLinearIssueRef, renderAssociations, escapeLinkText } from "@/src/lib/pr-summary-associate"
import type { StackContext } from "@/src/lib/pr-stack"

function stack(overrides: Partial<StackContext>): StackContext {
  return {
    isStacked: false,
    position: 1,
    depth: 1,
    parent: null,
    ancestors: [],
    children: [],
    root: null,
    cycleDetected: false,
    stackWalkCapped: false,
    hasUpstackFork: false,
    ...overrides,
  }
}

function stackPr(number: number) {
  return {
    number,
    title: `PR ${number}`,
    headRef: `h${number}`,
    baseRef: `b${number}`,
    headRepo: "o/r",
    baseRepo: "o/r",
    author: "alice",
    updatedAt: null,
  }
}

describe("extractLinearIssueRef", () => {
  it("prefers a body declaration over the branch name", () => {
    const ref = extractLinearIssueRef("Closes SIG-437", "sig-999-other")
    expect(ref).toEqual({ id: "SIG-437", url: "https://linear.app/sigilix/issue/SIG-437" })
  })

  it("matches the keyword variants case-insensitively and uppercases the key", () => {
    expect(extractLinearIssueRef("fixes sig-12", null)?.id).toBe("SIG-12")
    expect(extractLinearIssueRef("Resolved ABC-3", null)?.id).toBe("ABC-3")
    expect(extractLinearIssueRef("Refs SIG-5", null)).toBeNull() // "Refs" is not a closing keyword
  })

  it("falls back to the branch name when the body has no declaration", () => {
    expect(extractLinearIssueRef("no refs here", "sig-437-pr-summary")).toEqual({
      id: "SIG-437",
      url: "https://linear.app/sigilix/issue/SIG-437",
    })
  })

  it("returns null when neither body nor branch yields a key (no guessing)", () => {
    expect(extractLinearIssueRef("just prose", "feature/no-issue")).toBeNull()
    expect(extractLinearIssueRef(null, null)).toBeNull()
    expect(extractLinearIssueRef("", "")).toBeNull()
  })

  it("does not match a key embedded mid-branch (branch fallback is anchored)", () => {
    expect(extractLinearIssueRef(null, "feature-sig-437")).toBeNull()
  })

  it("does NOT mislink a non-Linear PR-number branch (branch fallback is sig-only)", () => {
    // `fix-123-...` is a PR-number branch, not a Linear key — must not produce a
    // FIX-123 link that 404s (code-review P2).
    expect(extractLinearIssueRef(null, "fix-123-some-bug")).toBeNull()
    expect(extractLinearIssueRef(null, "feat-2-thing")).toBeNull()
    expect(extractLinearIssueRef(null, "ab-12-x")).toBeNull()
  })

  it("ignores a body declaration inside code/quotes (parity with the trigger parser)", () => {
    expect(extractLinearIssueRef("```\ncloses ABC-123\n```", null)).toBeNull()
    expect(extractLinearIssueRef("> Closes XYZ-9", null)).toBeNull()
    expect(extractLinearIssueRef("inline `closes ABC-1` ref", null)).toBeNull()
  })
})

describe("renderAssociations", () => {
  it("renders Linear + parent + children", () => {
    const out = renderAssociations({
      stack: stack({ isStacked: true, parent: stackPr(87), children: [stackPr(91), stackPr(92)] }),
      linear: { id: "SIG-437", url: "https://linear.app/sigilix/issue/SIG-437" },
    })
    expect(out).toBe(
      [
        "## Related",
        "",
        "- Linear: [SIG-437](https://linear.app/sigilix/issue/SIG-437)",
        "- Stacked on #87",
        "- Followed by #91, #92",
      ].join("\n"),
    )
  })

  it("renders Linear-only when not stacked", () => {
    const out = renderAssociations({
      stack: stack({}),
      linear: { id: "SIG-1", url: "https://linear.app/sigilix/issue/SIG-1" },
    })
    expect(out).toBe(["## Related", "", "- Linear: [SIG-1](https://linear.app/sigilix/issue/SIG-1)"].join("\n"))
  })

  it("renders stack-only when no Linear ref", () => {
    const out = renderAssociations({ stack: stack({ isStacked: true, parent: stackPr(5) }), linear: null })
    expect(out).toBe(["## Related", "", "- Stacked on #5"].join("\n"))
  })

  it("returns null when there is nothing to relate", () => {
    expect(renderAssociations({ stack: stack({}), linear: null })).toBeNull()
    expect(renderAssociations({ stack: null, linear: null })).toBeNull()
  })
})

describe("escapeLinkText", () => {
  it("escapes square brackets so a title cannot break the markdown link", () => {
    expect(escapeLinkText("fix [bug] in module")).toBe("fix \\[bug\\] in module")
  })
})
