// ARC-189 — Reviewer-reply dismissal-signal parser tests (Task 3).

import { describe, expect, it } from "vitest"
import { parseDismissalSignal } from "../src/lib/review-memory/parse-dismissal"

describe("parseDismissalSignal — keyword set triggers", () => {
  it.each([
    "not relevant",
    "Not Relevant",
    "this is a false positive",
    "False Positive — the test is correct",
    "ignore",
    "noise",
    "noisy nit",
    "dismiss",
    "dismissed; not applicable here",
    "won't fix",
    "wontfix",
    "WONTFIX",
  ])(`triggers on %p`, (body) => {
    const r = parseDismissalSignal(body)
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("dismissed-textual")
  })
})

describe("parseDismissalSignal — `nit` is bare-only (spec §13 risk #4)", () => {
  it.each(["nit", "Nit", "NIT", "nit.", "nit!", "Nit ", "  nit  "])(
    `triggers on bare %p`,
    (body) => {
      const r = parseDismissalSignal(body)
      expect(r).not.toBeNull()
    },
  )

  it.each([
    "nit: actually let's keep this",
    "nit: I think this is fine",
    "Nit: but consider renaming",
    "nit followed by real content",
    "this is not a nit, the test should fail",
  ])(`does NOT trigger on prefix-style %p`, (body) => {
    expect(parseDismissalSignal(body)).toBeNull()
  })
})

describe("parseDismissalSignal — keyword embedded in surrounding text", () => {
  it("triggers on keyword anywhere in non-code text", () => {
    expect(parseDismissalSignal("Hmm, I think this is a false positive — see PR #42.")).not.toBeNull()
    expect(parseDismissalSignal("Thanks but ignore — out of scope for this PR.")).not.toBeNull()
  })

  it("emoji decoration around keyword still triggers", () => {
    expect(parseDismissalSignal("👎 false positive imo")).not.toBeNull()
    expect(parseDismissalSignal("not relevant 🤷")).not.toBeNull()
  })
})

describe("parseDismissalSignal — neutral text", () => {
  it.each([
    "Thanks for the catch",
    "LGTM",
    "Good point, will fix",
    "Hmm, you're right.",
    "let me look into this",
    "Yes, agreed",
    "I'll update.",
  ])(`returns null for %p`, (body) => {
    expect(parseDismissalSignal(body)).toBeNull()
  })
})

describe("parseDismissalSignal — SIG-114 PR 4 canonical reason capture", () => {
  it("captures the reason from an explicit '@sigilix dismiss <reason>' reply", () => {
    expect(parseDismissalSignal("@sigilix dismiss not-a-bug")).toEqual({
      kind: "dismissed-textual",
      dismissReason: "not-a-bug",
    })
  })
  it("captures a reason after a 'dismiss:' prefix (space-alias)", () => {
    expect(parseDismissalSignal("dismiss: too minor")).toEqual({
      kind: "dismissed-textual",
      dismissReason: "too-minor",
    })
  })
  it("captures a reason trailing another dismissal keyword", () => {
    expect(parseDismissalSignal("false positive — wrong context")).toEqual({
      kind: "dismissed-textual",
      dismissReason: "wrong-context",
    })
  })
  it("leaves a freeform dismissal unlabeled (no fuzzy guessing)", () => {
    expect(parseDismissalSignal("false positive")).toEqual({ kind: "dismissed-textual" })
    expect(parseDismissalSignal("Hmm, I think this is a false positive — see PR #42.")).toEqual({
      kind: "dismissed-textual",
    })
    expect(parseDismissalSignal("ignore, out of scope for this PR")).toEqual({ kind: "dismissed-textual" })
  })
  it("leaves bare nit unlabeled", () => {
    expect(parseDismissalSignal("nit")).toEqual({ kind: "dismissed-textual" })
  })
  it("captures a reason after a keyword + separators (e.g. 'noisy — too minor')", () => {
    expect(parseDismissalSignal("noisy — too minor")).toEqual({
      kind: "dismissed-textual",
      dismissReason: "too-minor",
    })
  })
})

describe("parseDismissalSignal — degenerate / empty inputs", () => {
  it("returns null for empty string", () => {
    expect(parseDismissalSignal("")).toBeNull()
  })

  it("returns null for whitespace-only", () => {
    expect(parseDismissalSignal("   \n\t  ")).toBeNull()
  })

  it("returns null for non-string input (defensive)", () => {

    expect(parseDismissalSignal(null as any)).toBeNull()

    expect(parseDismissalSignal(undefined as any)).toBeNull()

    expect(parseDismissalSignal(123 as any)).toBeNull()
  })
})

describe("parseDismissalSignal — code fences excluded from keyword scan", () => {
  it("ignores keyword inside a triple-backtick code block", () => {
    const body = [
      "Thanks!",
      "",
      "```ts",
      "// not relevant comment in code is not a dismissal",
      "const dismiss = false // wontfix",
      "```",
      "",
      "I'll address this in a follow-up.",
    ].join("\n")
    expect(parseDismissalSignal(body)).toBeNull()
  })

  it("triggers when keyword is in prose AND a code fence also contains the word", () => {
    const body = [
      "This is a false positive — the regex already handles it.",
      "",
      "```ts",
      "// dismiss this comment",
      "```",
    ].join("\n")
    const r = parseDismissalSignal(body)
    expect(r).not.toBeNull()
  })

  it("inline single-backtick `code` does NOT shield prose around it", () => {
    const body = "I think `someVar` is a false positive here."
    expect(parseDismissalSignal(body)).not.toBeNull()
  })
})
