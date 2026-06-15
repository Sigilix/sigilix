// CI-failure triage → review-synth pure core (PR 1). Every test asserts a
// behavior that would break if the corresponding logic were reverted.

import { describe, expect, it } from "vitest"
import {
  parseCiTriageSynthMode,
  buildCiSynthUserMessage,
  isLogGrounded,
  disposeCiFinding,
  ciFindingCoarseKey,
  isDuplicateOfExistingReview,
  matchesExistingCoarseKey,
  renderCiFindingComment,
  CI_HEDGE_LINE,
  CI_REVIEW_MARKER,
  type CiDedupCandidate,
  type ExistingReviewFindings,
} from "@/src/lib/ci-triage-synth"

describe("parseCiTriageSynthMode", () => {
  it("defaults to off for unset / empty / unknown values (dark default)", () => {
    expect(parseCiTriageSynthMode(undefined)).toBe("off")
    expect(parseCiTriageSynthMode("")).toBe("off")
    expect(parseCiTriageSynthMode("on")).toBe("off")
    expect(parseCiTriageSynthMode("enforced")).toBe("off")
    expect(parseCiTriageSynthMode("true")).toBe("off")
  })
  it("returns shadow only for the literal 'shadow' (trim + case-insensitive)", () => {
    expect(parseCiTriageSynthMode("shadow")).toBe("shadow")
    expect(parseCiTriageSynthMode("  SHADOW ")).toBe("shadow")
  })
  it("returns enforce only for the literal 'enforce' (trim + case-insensitive)", () => {
    expect(parseCiTriageSynthMode("enforce")).toBe("enforce")
    expect(parseCiTriageSynthMode(" Enforce  ")).toBe("enforce")
  })
})

describe("buildCiSynthUserMessage", () => {
  it("threads the diff and the failure log under their labeled sections", () => {
    const msg = buildCiSynthUserMessage({
      ciLog: "FAIL src/a.ts > does the thing\nExpected 1, got 2",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+const y = 2",
      fileContexts: [],
    })
    expect(msg).toContain("[PR DIFF]")
    expect(msg).toContain("diff --git a/src/a.ts b/src/a.ts")
    expect(msg).toContain("[FAILED CI LOG]")
    expect(msg).toContain("Expected 1, got 2")
    // Instructs the verbatim-logExcerpt + diff-anchor grounding contract.
    expect(msg).toContain("logExcerpt")
    expect(msg).toContain("anchor")
  })

  it("includes a file-context section only when file contexts are present", () => {
    const without = buildCiSynthUserMessage({ ciLog: "log", diff: "diff", fileContexts: [] })
    expect(without).not.toContain("[AFFECTED FILE CONTEXT]")

    const withCtx = buildCiSynthUserMessage({
      ciLog: "log",
      diff: "diff",
      fileContexts: [{ path: "src/a.ts", content: "export const x = 1" }],
    })
    expect(withCtx).toContain("[AFFECTED FILE CONTEXT]")
    expect(withCtx).toContain("--- src/a.ts ---")
    expect(withCtx).toContain("export const x = 1")
  })
})

describe("isLogGrounded (the key gate)", () => {
  const log = "  FAIL  src/a.ts > sums two numbers\n    TS2339: Property 'foo' does not exist on type 'Bar'\n"

  it("passes when the excerpt is a verbatim substring of the log", () => {
    expect(isLogGrounded("TS2339: Property 'foo' does not exist on type 'Bar'", log)).toBe(true)
  })

  it("passes despite whitespace differences (normalized substring)", () => {
    // Re-indented + collapsed internal spacing — still grounded.
    expect(isLogGrounded("FAIL   src/a.ts   >   sums two numbers", log)).toBe(true)
    expect(isLogGrounded("  TS2339: Property 'foo' does not exist on type 'Bar'  ", log)).toBe(true)
  })

  it("fails when the excerpt is NOT in the log (the #24 fabrication)", () => {
    expect(isLogGrounded("SyntaxError: unexpected token", log)).toBe(false)
    expect(isLogGrounded("TS9999: invented error code", log)).toBe(false)
  })

  it("fails for an empty / whitespace-only excerpt (quotes nothing → not corroborated)", () => {
    expect(isLogGrounded("", log)).toBe(false)
    expect(isLogGrounded("   \n  ", log)).toBe(false)
  })

  it("is case-sensitive on error codes (TS2339 != ts2339)", () => {
    expect(isLogGrounded("ts2339: property 'foo'", log)).toBe(false)
  })
})

describe("disposeCiFinding (two-stack disposition)", () => {
  it("anchored + corroborated → inline-clean", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: true, hardWithholdUncorroborated: false })).toBe(
      "inline-clean",
    )
    // The hard-withhold flag does NOT affect the corroborated bucket.
    expect(disposeCiFinding({ anchored: true, logCorroborated: true, hardWithholdUncorroborated: true })).toBe(
      "inline-clean",
    )
  })

  it("anchored + uncorroborated → inline-hedged BY DEFAULT (recall-safe, not dropped)", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: false, hardWithholdUncorroborated: false })).toBe(
      "inline-hedged",
    )
  })

  it("anchored + uncorroborated → withhold ONLY when the hard-withhold flag is set", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: false, hardWithholdUncorroborated: true })).toBe(
      "withhold",
    )
  })

  it("not anchored → withhold regardless of corroboration (off-diff: flaky / infra)", () => {
    expect(disposeCiFinding({ anchored: false, logCorroborated: true, hardWithholdUncorroborated: false })).toBe(
      "withhold",
    )
    expect(disposeCiFinding({ anchored: false, logCorroborated: false, hardWithholdUncorroborated: false })).toBe(
      "withhold",
    )
    expect(disposeCiFinding({ anchored: false, logCorroborated: false, hardWithholdUncorroborated: true })).toBe(
      "withhold",
    )
  })
})

describe("ciFindingCoarseKey", () => {
  it("lowercases the path and normalizes the headline (collapse ws + strip trailing punctuation)", () => {
    expect(ciFindingCoarseKey("src/A.ts", "Missing  null   check.")).toBe("src/a.ts|missing null check")
    expect(ciFindingCoarseKey("SRC/a.ts", "Off-by-one in loop!!!")).toBe("src/a.ts|off-by-one in loop")
  })
  it("makes rephrased-only-by-trailing-punctuation headlines collide (the intended coarseness)", () => {
    expect(ciFindingCoarseKey("src/a.ts", "Bad cast")).toBe(ciFindingCoarseKey("src/a.ts", "Bad cast."))
  })
})

describe("isDuplicateOfExistingReview (dedup predicate)", () => {
  const existing: ExistingReviewFindings = {
    fingerprints: new Set(["a".repeat(64)]),
    coarseKeys: new Set(["src/a.ts|missing null check"]),
  }

  it("HARD-DROPS on an exact contentFingerprint match (the review already posted it)", () => {
    const candidate: CiDedupCandidate = { contentFingerprint: "a".repeat(64), coarseKey: "src/b.ts|unrelated" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(true)
  })

  it("KEEPS a genuinely-new finding (no fingerprint match)", () => {
    const candidate: CiDedupCandidate = { contentFingerprint: "b".repeat(64), coarseKey: "src/c.ts|new thing" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
  })

  it("does NOT hard-drop on a coarse-key-only match (recall-safety: coarse is a hint, not a drop)", () => {
    // Same coarse key as an existing manifest finding, but a different (or no)
    // fingerprint — must NOT be suppressed by the hard-drop predicate.
    const candidate: CiDedupCandidate = { contentFingerprint: "c".repeat(64), coarseKey: "src/a.ts|missing null check" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
    const noFingerprint: CiDedupCandidate = { coarseKey: "src/a.ts|missing null check" }
    expect(isDuplicateOfExistingReview(noFingerprint, existing)).toBe(false)
  })

  it("KEEPS a finding with no fingerprint at all (can't fingerprint-match → not a hard dup)", () => {
    const candidate: CiDedupCandidate = { coarseKey: "src/z.ts|brand new" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
  })
})

describe("matchesExistingCoarseKey (secondary hint)", () => {
  const existing: ExistingReviewFindings = {
    fingerprints: new Set<string>(),
    coarseKeys: new Set(["src/a.ts|missing null check"]),
  }
  it("flags a coarse-key match as a hint", () => {
    expect(matchesExistingCoarseKey({ coarseKey: "src/a.ts|missing null check" }, existing)).toBe(true)
  })
  it("returns false when the coarse key is not in the manifest set", () => {
    expect(matchesExistingCoarseKey({ coarseKey: "src/a.ts|something else" }, existing)).toBe(false)
  })
})

describe("renderCiFindingComment (presentation — Kimi's template, NO emojis)", () => {
  const base = {
    statement: "The added `parseAmount` returns a string, but the caller expects a number.",
    runId: 123456,
    runUrl: "https://github.com/o/r/actions/runs/123456",
  }

  it("renders statement, fix block, and the provenance line in order", () => {
    const body = renderCiFindingComment({ ...base, fix: "Wrap the result in `Number(...)`." }, false)
    expect(body).toBe(
      [
        "The added `parseAmount` returns a string, but the caller expects a number.",
        "",
        "Likely fix:\nWrap the result in `Number(...)`.",
        "",
        "Surfaced from failed CI run [123456](https://github.com/o/r/actions/runs/123456).",
      ].join("\n"),
    )
  })

  it("omits the `Likely fix:` block when there is no fix", () => {
    const body = renderCiFindingComment(base, false)
    expect(body).not.toContain("Likely fix:")
    expect(body).toContain("The added `parseAmount` returns a string")
    expect(body).toContain("Surfaced from failed CI run [123456]")
  })

  it("omits the fix block for an empty / whitespace-only fix", () => {
    expect(renderCiFindingComment({ ...base, fix: "" }, false)).not.toContain("Likely fix:")
    expect(renderCiFindingComment({ ...base, fix: "   " }, false)).not.toContain("Likely fix:")
  })

  it("prepends the hedge line for the hedged (uncorroborated) disposition", () => {
    const hedged = renderCiFindingComment({ ...base, fix: "Cast it." }, true)
    expect(hedged.startsWith(CI_HEDGE_LINE)).toBe(true)
    expect(hedged).toContain("Likely fix:\nCast it.")
  })

  it("does NOT prepend the hedge line for the clean disposition", () => {
    expect(renderCiFindingComment(base, false)).not.toContain(CI_HEDGE_LINE)
  })

  it("contains NO emoji (Kimi: drop emojis, model, confidence)", () => {
    const clean = renderCiFindingComment({ ...base, fix: "Cast it." }, false)
    const hedged = renderCiFindingComment({ ...base, fix: "Cast it." }, true)
    // Match any emoji / pictographic codepoint; the legacy CI sticky used 🔴📍📋🤔.
    const emojiRe = /\p{Extended_Pictographic}/u
    expect(emojiRe.test(clean)).toBe(false)
    expect(emojiRe.test(hedged)).toBe(false)
    // And it drops model / confidence framing entirely.
    expect(clean.toLowerCase()).not.toContain("confidence")
    expect(clean.toLowerCase()).not.toContain("model")
  })
})

describe("CI_REVIEW_MARKER", () => {
  it("is the distinct CI-review idempotency marker (not the legacy sticky / suggestion markers)", () => {
    expect(CI_REVIEW_MARKER).toBe("<!-- sigilix:ci-review -->")
    expect(CI_REVIEW_MARKER).not.toBe("<!-- sigilix:ci-triage -->")
    expect(CI_REVIEW_MARKER).not.toBe("<!-- sigilix:ci-suggestion -->")
  })
})
