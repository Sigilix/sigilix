// ARC-269 — gate tests for the implicit review-thread-reply path.

import { describe, it, expect } from "vitest"

import {
  shouldQueueReviewThreadReply,
  type ReviewReplySkipReason,
} from "@/lib/review-thread-reply"

function expectSkip(args: Parameters<typeof shouldQueueReviewThreadReply>[0], reason: ReviewReplySkipReason) {
  const out = shouldQueueReviewThreadReply(args)
  expect(out.ok).toBe(false)
  if (out.ok) throw new Error("unreachable")
  expect(out.reason).toBe(reason)
}

function expectOk(args: Parameters<typeof shouldQueueReviewThreadReply>[0]) {
  const out = shouldQueueReviewThreadReply(args)
  expect(out.ok).toBe(true)
}

describe("shouldQueueReviewThreadReply — gate ordering", () => {
  it("returns `self` when the author is Sigilix (most important guard, runs first)", () => {
    expectSkip({
      body: "is this safe in prod?",
      authorLogin: "sigilix[bot]",
      inReplyToId: 100,
    }, "self")
  })

  it("recognizes the legacy bot login (`arc-copilot[bot]`) as self too", () => {
    // `isArcGithubLogin` covers the historical bot name from the
    // pre-rename era; the gate must NOT queue replies from it.
    expectSkip({
      body: "this is a perfectly fine question?",
      authorLogin: "arc-copilot[bot]",
      inReplyToId: 100,
    }, "self")
  })

  it("returns `not-a-reply` when `in_reply_to_id` is missing (first comment in a thread)", () => {
    expectSkip({
      body: "is this safe in prod?",
      authorLogin: "human-user",
      inReplyToId: null,
    }, "not-a-reply")
    expectSkip({
      body: "is this safe in prod?",
      authorLogin: "human-user",
      inReplyToId: undefined,
    }, "not-a-reply")
  })

  it("self gate runs BEFORE the not-a-reply gate (Sigilix posting a top-level comment still classified as self)", () => {
    // Loop-prevention is the most consequential property; it must
    // beat every other skip reason so a future caller that omits
    // `in_reply_to_id` for some reason still can't trigger Sigilix
    // replying to itself.
    expectSkip({
      body: "anything",
      authorLogin: "sigilix[bot]",
      inReplyToId: null,
    }, "self")
  })
})

describe("shouldQueueReviewThreadReply — empty / ack-only", () => {
  it("returns `empty` for a blank body", () => {
    expectSkip({ body: "", authorLogin: "human", inReplyToId: 100 }, "empty")
    expectSkip({ body: "   \n\n  ", authorLogin: "human", inReplyToId: 100 }, "empty")
    expectSkip({ body: null, authorLogin: "human", inReplyToId: 100 }, "empty")
    expectSkip({ body: undefined, authorLogin: "human", inReplyToId: 100 }, "empty")
  })

  it("returns `empty` for a body that's only a fenced code block (stripQuotesAndCode removes it)", () => {
    expectSkip({
      body: "```\nlooks fine\n```",
      authorLogin: "human",
      inReplyToId: 100,
    }, "empty")
  })

  it("returns `empty` for a body that's only a blockquote", () => {
    expectSkip({
      body: "> Sigilix said something\n> across two lines",
      authorLogin: "human",
      inReplyToId: 100,
    }, "empty")
  })

  it("returns `ack-only` for short acknowledgements", () => {
    for (const tok of ["fixed", "FIXED", "done", "Done!", "thanks", "thx", "ty", "ack", "lgtm", "sgtm", "ok", "okay", "noted", "+1", "resolved", "addressed"]) {
      expectSkip({ body: tok, authorLogin: "human", inReplyToId: 100 }, "ack-only")
    }
  })

  it("returns `ack-only` for the additional acks added per code-review L2", () => {
    for (const tok of ["agreed", "merged", "approved", "deployed", "shipped", "yes", "yeah", "yep", "wfm"]) {
      expectSkip({ body: tok, authorLogin: "human", inReplyToId: 100 }, "ack-only")
    }
  })

  it("returns `ack-only` for emoji-only acknowledgements", () => {
    for (const tok of ["👍", "👎", "✅", "🙏", "🚀", "💯"]) {
      expectSkip({ body: tok, authorLogin: "human", inReplyToId: 100 }, "ack-only")
    }
  })

  it("ack tokens with trailing punctuation are still acks", () => {
    expectSkip({ body: "fixed.", authorLogin: "human", inReplyToId: 100 }, "ack-only")
    expectSkip({ body: "done!", authorLogin: "human", inReplyToId: 100 }, "ack-only")
    expectSkip({ body: "thanks!", authorLogin: "human", inReplyToId: 100 }, "ack-only")
  })

  // Code-review H1 catch: literal questions like "thanks?" used to
  // skip as ack-only because the trailing `?` got split out by the
  // tokenizer before the strong-signal check. The fix moved the
  // `endsWith("?")` short-circuit ABOVE the ack-only check so a
  // single-token question is recognised as a question first.
  it("queues single-token bodies that END with `?` (NOT classified as ack)", () => {
    for (const body of ["thanks?", "done?", "fixed?", "ok?", "resolved?", "sgtm?"]) {
      expectOk({ body, authorLogin: "human", inReplyToId: 100 })
    }
  })

  it("multi-word body containing 'thanks' is NOT classified as ack-only (only single-token bodies are)", () => {
    // A reply like "thanks for the catch, but I think this is intentional"
    // contains "thanks" but is a real ask — the trigger-word path
    // ("intentional") will pick it up below.
    expectOk({
      body: "thanks for the catch, but this is intentional",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })
})

describe("shouldQueueReviewThreadReply — signal detection", () => {
  it("queues when the body ends with `?`", () => {
    expectOk({
      body: "is this dead code?",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  it("queues when the body is >= 80 chars (long-form bodies almost always deserve a reply)", () => {
    expectOk({
      body: "This branch is unreachable in production because we always set the flag at boot.",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  it("queues on each trigger word individually (with word boundaries)", () => {
    const triggers = [
      "this is intentional",
      "false positive on the legacy path",
      "false-positive on the legacy path",
      "dead code from the old api",
      "ignore — handled by the parent middleware",
      "this never runs in prod",
      "we never hit this in production",
      "could you verify the conclusion",
      "can you re-check the assumption",
      "does this account for the empty array",
      "is this actually correct",
      "the trace shows this is wrong",
      "isn't the loop already bounded",
      "doesn't the guard upstream cover this",
      "explain how this affects the rollback path",
      "is the new path safe under load",
      "concerns about thread safety",
      "what are your thoughts on this",
      "please clarify the contract",
      "the rationale is unclear",
      "correct me if I'm wrong",
    ]
    for (const body of triggers) {
      expectOk({ body, authorLogin: "human", inReplyToId: 100 })
    }
  })

  // Code-review M2 catch: substring matching used to over-fire on
  // common English ("prod" → "product" → "reproduction"; "how" →
  // "however" → "show"). Now matched with word boundaries.
  it("does NOT trip the trigger heuristic on common English substrings (M2 catch)", () => {
    // Each of these contains a literal trigger as a substring but
    // not as a word. They should fall through to no-reply-signal
    // (or stay skipped via length/ack — point is they don't queue).
    for (const body of [
      "however that worked out",       // "how" → "however"
      "the product looks fine",         // "prod" → "product"
      "reproduction is straightforward", // "prod" → "reproduction"
      "show me the line",               // "how" → "show"
      "somehow this passes ci",         // "how" → "somehow"
      "deprecated path",                // "prod"? no, but a sanity check
    ]) {
      const out = shouldQueueReviewThreadReply({
        body, authorLogin: "human", inReplyToId: 100,
      })
      expect(out.ok).toBe(false)
    }
  })

  it("queues on `??` even when the body doesn't end in `?` (multi-q strong signal)", () => {
    expectOk({
      body: "wait ?? this is weird",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  it("returns `no-reply-signal` for short, signal-less bodies that aren't single-token acks", () => {
    // Multi-word but no `?`, no trigger, short.
    expectSkip({
      body: "that one over there",
      authorLogin: "human",
      inReplyToId: 100,
    }, "no-reply-signal")
  })

  it("returns `no-reply-signal` for short emoji bursts that aren't on the single-token ack list", () => {
    expectSkip({
      body: "🤔 🤔",
      authorLogin: "human",
      inReplyToId: 100,
    }, "no-reply-signal")
  })

  it("trigger-word match is case-insensitive", () => {
    expectOk({
      body: "PROD outage if we ship this",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  // Code-review M1 catch: strong-signal scoring runs on the RAW
  // body (not the stripped body), so code-rich asks aren't lost
  // when stripQuotesAndCode eats their inline backticks.
  it("queues a code-rich reply whose stripped form would be too short (M1 catch)", () => {
    // After stripQuotesAndCode the body becomes " breaks the null
    // path" (no `?`, no trigger, but length is borderline). The
    // RAW body is "`foo()` breaks the null path" (29 chars, no `?`,
    // no trigger). Both fall under no-reply-signal — pick a
    // longer code-rich body to clearly demonstrate the path:
    expectOk({
      body: "I think `foo()` is wrong — it doesn't handle the null case the upstream guarantees",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })
})

describe("shouldQueueReviewThreadReply — robustness", () => {
  it("ignores leading/trailing whitespace before classifying", () => {
    expectSkip({
      body: "\n   fixed   \n",
      authorLogin: "human",
      inReplyToId: 100,
    }, "ack-only")
  })

  it("a body shaped `> Sigilix said X\n\nbut intentional` skips the quote and queues on the trigger word", () => {
    expectOk({
      body: "> Sigilix said this is unsafe\n\nthat's intentional",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  it("queues a body whose ONLY content is a trailing question mark in a multi-line reply", () => {
    expectOk({
      body: "hmm\nhmm\nis this right?",
      authorLogin: "human",
      inReplyToId: 100,
    })
  })

  it("respects the not-a-reply gate even when the body is a meaningful ask (top-level review comments aren't replies)", () => {
    expectSkip({
      body: "is this safe in prod?",
      authorLogin: "human",
      inReplyToId: undefined,
    }, "not-a-reply")
  })
})
