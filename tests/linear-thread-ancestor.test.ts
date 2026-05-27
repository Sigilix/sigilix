// SIG-225 — pure-helper tests for the Linear in-thread-reply trigger.
//
// Mirrors `arc-in-thread-above.test.ts` (the GitHub-side equivalent)
// — same cases, Linear shape. Documents the closed-set behavior so a
// regression in `commentHasSigilixAncestor` shows up here before it
// degrades the webhook trigger in production.

import { describe, expect, it } from "vitest"
import {
  commentHasSigilixAncestor,
  type LinearThreadComment,
} from "../src/lib/linear-thread-ancestor"

const sigilix = (id: string, parentId: string | null = null): LinearThreadComment => ({
  id,
  parentId,
  user: { name: "sigilix", displayName: "sigilix[bot]" },
})
const human = (id: string, parentId: string | null = null): LinearThreadComment => ({
  id,
  parentId,
  user: { name: "danny", displayName: "Danny" },
})

describe("commentHasSigilixAncestor", () => {
  it("returns false on a top-level comment (no startParentId)", () => {
    expect(commentHasSigilixAncestor({ startParentId: null, comments: [human("a")] })).toBe(false)
    expect(commentHasSigilixAncestor({ startParentId: undefined, comments: [human("a")] })).toBe(false)
    expect(commentHasSigilixAncestor({ startParentId: "", comments: [human("a")] })).toBe(false)
  })

  it("returns true when the immediate parent is Sigilix (most common case)", () => {
    // user → reply-to → sigilix; new comment is a child of `s1`.
    const comments = [sigilix("s1"), human("u2", "s1")]
    expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(true)
  })

  it("returns true when Sigilix is two levels up (sigilix → human → human-reply)", () => {
    const comments = [sigilix("s1"), human("u2", "s1"), human("u3", "u2")]
    expect(commentHasSigilixAncestor({ startParentId: "u2", comments })).toBe(true)
  })

  it("returns false when the chain is human-only above the parent", () => {
    const comments = [human("u1"), human("u2", "u1"), human("u3", "u2")]
    expect(commentHasSigilixAncestor({ startParentId: "u2", comments })).toBe(false)
  })

  it("fails closed when startParentId isn't in the snapshot (walked past the page)", () => {
    // Long thread paginated past `first: 100` — parent ref dangles.
    const comments = [sigilix("s1")]
    expect(commentHasSigilixAncestor({ startParentId: "missing-id", comments })).toBe(false)
  })

  it("survives a self-referential cycle without infinite-looping", () => {
    // Defensive: malformed Linear data where a comment's parent points
    // back at itself. The `seen` set bounds the walk; expected false.
    const comments: LinearThreadComment[] = [
      { id: "loop", parentId: "loop", user: { name: "danny", displayName: "Danny" } },
    ]
    expect(commentHasSigilixAncestor({ startParentId: "loop", comments })).toBe(false)
  })

  it("survives a longer cycle (a→b→a) without infinite-looping", () => {
    const comments: LinearThreadComment[] = [
      { id: "a", parentId: "b", user: { name: "danny", displayName: null } },
      { id: "b", parentId: "a", user: { name: "danny", displayName: null } },
    ]
    expect(commentHasSigilixAncestor({ startParentId: "a", comments })).toBe(false)
  })

  it("matches isBotHandle on either displayName or name (displayName preferred)", () => {
    // displayName="Sigilix Bot" → not a bot handle; name="sigilix[bot]" SHOULD match.
    // Verifies the displayName-then-name fallback in the helper.
    const comments: LinearThreadComment[] = [
      { id: "s1", parentId: null, user: { name: "sigilix[bot]", displayName: null } },
      human("u2", "s1"),
    ]
    expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(true)
  })

  it("matches every legacy bot-handle alias the cross-platform isBotHandle accepts", () => {
    const variants = [
      "sigilix[bot]",
      "Sigilix[bot]",
      "arc[bot]",
      "Arc[bot]",
      "arc-copilot[bot]",
      "openclaw[bot]",
    ]
    for (const displayName of variants) {
      const comments: LinearThreadComment[] = [
        { id: "s1", parentId: null, user: { name: null, displayName } },
        human("u2", "s1"),
      ]
      expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(true)
    }
  })

  it("matches bare 'sigilix'/'arc'/'openclaw' (Linear OAuth bot display name has no [bot] suffix)", () => {
    // CRITICAL for SIG-225 in prod: Linear's OAuth flow stamps the bot
    // identity as the plain workspace-display name (e.g. "Sigilix"),
    // not "sigilix[bot]" like GitHub. `isBotHandle`'s regex makes the
    // `[bot]` suffix OPTIONAL for the three known names — that's the
    // ONLY reason the thread-walk fires under real OAuth in prod. If a
    // future change tightens isBotHandle to require `[bot]`, this test
    // breaks LOUDLY and the SIG-225 trigger silently stops working.
    for (const display of ["sigilix", "Sigilix", "arc", "Arc", "openclaw"]) {
      const comments: LinearThreadComment[] = [
        { id: "s1", parentId: null, user: { name: null, displayName: display } },
        human("u2", "s1"),
      ]
      expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(true)
    }
  })

  it("returns false on an unrelated human display name", () => {
    // Defensive: handle that doesn't end in [bot] AND isn't one of the
    // three known bot names should NOT trigger.
    const comments: LinearThreadComment[] = [
      { id: "s1", parentId: null, user: { name: "danny", displayName: "Danny Martinez" } },
      human("u2", "s1"),
    ]
    expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(false)
  })

  it("returns false when an ancestor exists with no user (null user)", () => {
    const comments: LinearThreadComment[] = [
      { id: "s1", parentId: null, user: null },
      human("u2", "s1"),
    ]
    expect(commentHasSigilixAncestor({ startParentId: "s1", comments })).toBe(false)
  })
})
