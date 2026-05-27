// SIG-225 follow-up — pure-helper tests for the parent-id resolution
// extracted from `handleMention`. Sigilix bot's PR #200 review flagged
// the missing coverage as a HIGH (score-4) testing finding: "The
// SIG-225 fix extracts `data.parent?.id` and forwards it to
// `createComment` ... This non‑trivial branching logic (parent exists
// vs. null) is not exercised by any test in this PR."
//
// True — the previous PR-200 commit only had coverage at the
// LinearClient.createComment boundary (tests/linear-create-comment.test.ts),
// not at the handleMention → createComment plumbing. Extracting the
// resolution into a pure helper makes the contract testable without
// the full mock stack.

import { describe, expect, it } from "vitest"
import { resolveReplyParentId } from "../src/lib/mention-reply"

describe("resolveReplyParentId — handleMention threading plumbing (SIG-225)", () => {
  it("returns the parent id when the source comment is a thread reply", () => {
    // Linear's thread model is FLAT: every reply in a thread carries
    // parentId = thread-root. The source comment's parent.id IS the
    // value we forward so the bot's reply lands beside the user's
    // reply under the same thread root.
    const result = resolveReplyParentId({ parent: { id: "comment-abc-123" } })
    expect(result).toBe("comment-abc-123")
  })

  it("returns undefined when the source comment is top-level (parent: null)", () => {
    // Legacy mention path: founder @-mentioned at issue root.
    // No parent → bot's reply also lands at issue root.
    const result = resolveReplyParentId({ parent: null })
    expect(result).toBeUndefined()
  })

  it("returns undefined defensively when parent.id is an empty string", () => {
    // Defensive: if Linear's GraphQL ever returns a malformed empty
    // id, we treat it as absent rather than pass an empty string to
    // LinearClient.createComment (which would silently route to a
    // top-level post or fail server-side). Mirrors the same
    // defensive check on the LinearClient.createComment surface.
    const result = resolveReplyParentId({ parent: { id: "" } })
    expect(result).toBeUndefined()
  })

  it("contract invariant: source with a valid parent.id is ALWAYS forwarded (no validation gate)", () => {
    // The parent.id comes from Linear's own GraphQL response — it's
    // Linear's own opaque ID echoed back. There's no injection
    // vector and no length / format that needs gating client-side
    // (Linear's server is authoritative for ID validity). This
    // assertion pins the contract so a future "validation" PR
    // doesn't accidentally drop valid Linear IDs that look unusual
    // (e.g. legacy v1 IDs without the modern UUID shape).
    const ids = [
      "00000000-0000-0000-0000-000000000000",
      "abc",
      "x".repeat(200),
      "some-unusual_id.format/with.special-chars",
      "🦄",
    ]
    for (const id of ids) {
      expect(resolveReplyParentId({ parent: { id } })).toBe(id)
    }
  })
})
