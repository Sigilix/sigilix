// SIG-225 — unit tests for the gate-decision helper extracted from
// `handleMention`. Sigilix bot's PR #198 review flagged the missing
// coverage for the thread-followup branch as a High (score-4) testing
// finding; the bug it would catch is the EXACT prod failure mode that
// motivated PR #198 — webhook fires the new trigger reason but the
// consumer's body-must-@-mention gate drops every thread-followup
// job (commit `5bba8d6`).

import { describe, expect, it } from "vitest"
import { resolveMentionQuestion } from "@/src/lib/mention-reply"
import { getMentionTriggers } from "@/src/lib/mention"

// Use the production default triggers so the test reflects the real
// `bodyMentionsBot` matcher. Treating triggers as a black box: any
// non-mentioning body fails the @-check, and any body containing
// `@sigilix` (the leading default trigger) passes.
const triggers = getMentionTriggers(undefined)

describe("resolveMentionQuestion — thread-followup path (SIG-225)", () => {
  it("does NOT enforce bodyMentionsBot and returns the trimmed body as the question", () => {
    // The whole point of the thread-followup trigger: the webhook
    // already verified the comment is a reply inside a Sigilix thread,
    // so the body intentionally has no @-mention. The consumer MUST
    // continue rather than bail at `[mention] no-mention` — which is
    // exactly the bug the founder hit on the first prod test of
    // SIG-225.
    const gate = resolveMentionQuestion({
      triggerReason: "thread-followup",
      body: "test again",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      expect(gate.fullQuestion).toBe("test again")
    }
  })

  it("trims leading/trailing whitespace from the body", () => {
    const gate = resolveMentionQuestion({
      triggerReason: "thread-followup",
      body: "  what about edge cases?  \n",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      expect(gate.fullQuestion).toBe("what about edge cases?")
    }
  })

  it("does NOT strip @-mentions — full body passes through (no stripMentionFromBody on thread-followup)", () => {
    // A founder who happens to include `@sigilix` IN a thread-followup
    // reply still gets the full body as the question. The strip step
    // exists to remove the trigger token from the question payload sent
    // to the model, but on the thread-followup path the @-mention is
    // semantically part of the message, not a trigger. Round-trip
    // assertion: `<@sigilix> ahem` survives as-is.
    const gate = resolveMentionQuestion({
      triggerReason: "thread-followup",
      body: "@sigilix any chance you could check the diff?",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      expect(gate.fullQuestion).toBe("@sigilix any chance you could check the diff?")
    }
  })

  it("returns empty string for an empty body (no skip — caller decides via the empty-question-after-strip log)", () => {
    // The downstream `question = fullQuestion.slice(...)` + empty
    // check in `handleMention` handles the empty-string case. The
    // gate helper just trims and returns; the empty-question log
    // lives in the caller. Verify the helper doesn't ALSO add an
    // implicit skip on empty (that would mask debugging signal).
    const gate = resolveMentionQuestion({
      triggerReason: "thread-followup",
      body: "   \n  ",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      expect(gate.fullQuestion).toBe("")
    }
  })
})

describe("resolveMentionQuestion — mention path (legacy default)", () => {
  it("skips with `no-mention` when body has no @-mention", () => {
    // The legacy defense-in-depth gate. Catches spurious queue
    // messages from any producer that didn't pre-check.
    const gate = resolveMentionQuestion({
      triggerReason: "mention",
      body: "this comment has no @-mention",
      triggers,
    })
    expect(gate.skip).toBe("no-mention")
  })

  it("strips the @-mention and returns the remainder as the question", () => {
    const gate = resolveMentionQuestion({
      triggerReason: "mention",
      body: "@sigilix what about the auth flow?",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      // The exact strip behavior is owned by stripMentionFromBody —
      // assert that the result no longer contains the @-mention and
      // does contain the surrounding text. Avoids pinning to the
      // specific whitespace-handling of the strip helper.
      expect(gate.fullQuestion).not.toContain("@sigilix")
      expect(gate.fullQuestion).toContain("what about the auth flow?")
    }
  })

  it("handles a mention at the END of the body (not just the start)", () => {
    const gate = resolveMentionQuestion({
      triggerReason: "mention",
      body: "anyone reviewing this — @sigilix?",
      triggers,
    })
    expect(gate.skip).toBeNull()
    if (gate.skip === null) {
      expect(gate.fullQuestion).not.toContain("@sigilix")
      expect(gate.fullQuestion).toContain("anyone reviewing this")
    }
  })
})

describe("resolveMentionQuestion — contract invariants", () => {
  it("never returns `skip: 'no-mention'` on the thread-followup path (even with an unmentioning body)", () => {
    // This is the load-bearing invariant — if a future refactor flips
    // the conditional and applies bodyMentionsBot to thread-followup,
    // every prod thread-reply triggers a `no-mention` bail again.
    // Pin it as an explicit test so the regression breaks loudly.
    const cases = ["plain reply", "", "no @ here at all", "🔥 emoji-only reply", "multi\nline\nreply\nno mention"]
    for (const body of cases) {
      const gate = resolveMentionQuestion({
        triggerReason: "thread-followup",
        body,
        triggers,
      })
      expect(gate.skip).toBeNull()
    }
  })
})
