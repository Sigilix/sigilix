// CR-evaluator pure helpers: file-context extraction, prompt
// stripping, response parsing, reply formatting, author detection.

import { describe, expect, it } from "vitest"
import {
  extractFileContext,
  formatVerdictReply,
  isCodeRabbitAuthor,
  parseEvaluatorResponse,
  stripCRAgentPrompt,
  type CrVerdict,
} from "../src/lib/triage-cr"

describe("isCodeRabbitAuthor", () => {
  it("matches the standard CR bot login", () => {
    expect(isCodeRabbitAuthor("coderabbitai")).toBe(true)
    expect(isCodeRabbitAuthor("coderabbitai[bot]")).toBe(true)
    expect(isCodeRabbitAuthor("coderabbitai-staging[bot]")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isCodeRabbitAuthor("CodeRabbitAI")).toBe(true)
  })

  it("rejects non-CR authors", () => {
    expect(isCodeRabbitAuthor("danielmartinezjulio07")).toBe(false)
    expect(isCodeRabbitAuthor("openclaw[bot]")).toBe(false)
  })

  it("handles null / empty", () => {
    expect(isCodeRabbitAuthor(null)).toBe(false)
    expect(isCodeRabbitAuthor("")).toBe(false)
    expect(isCodeRabbitAuthor(undefined)).toBe(false)
  })
})

describe("stripCRAgentPrompt", () => {
  it("removes the AI Agents details block", () => {
    const input = `Some real comment text.

<details>
<summary>🤖 Prompt for AI Agents</summary>

Don't read this.

</details>

More real comment.`
    const out = stripCRAgentPrompt(input)
    expect(out).not.toContain("Prompt for AI Agents")
    expect(out).not.toContain("Don't read this")
    expect(out).toContain("Some real comment text")
    expect(out).toContain("More real comment")
  })

  it("leaves comments without the details block unchanged", () => {
    const input = "Plain comment, no AI agents block."
    expect(stripCRAgentPrompt(input)).toBe(input)
  })

  it("returns the empty string on non-string input", () => {
    expect(stripCRAgentPrompt(null as unknown as string)).toBe("")
  })
})

describe("extractFileContext", () => {
  const FILE = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n")

  it("returns ±radius lines around the target line", () => {
    const out = extractFileContext(FILE, 15, 2)
    const lines = out.split("\n")
    expect(lines).toHaveLength(5) // 13, 14, 15, 16, 17
    expect(lines[0]).toContain("line13")
    expect(lines[2]).toContain("line15")
    expect(lines[4]).toContain("line17")
  })

  it("marks the target line with `>`", () => {
    const out = extractFileContext(FILE, 15, 2)
    const lines = out.split("\n")
    expect(lines[2]?.startsWith(">")).toBe(true)
    expect(lines[1]?.startsWith(" ")).toBe(true)
  })

  it("clamps to file boundaries near the start / end", () => {
    const startOut = extractFileContext(FILE, 1, 5)
    expect(startOut.split("\n")[0]).toContain("line1") // can't go below 1

    const endOut = extractFileContext(FILE, 30, 5)
    const last = endOut.split("\n").at(-1)
    expect(last).toContain("line30")
  })

  it("returns empty string on invalid line", () => {
    expect(extractFileContext(FILE, 0)).toBe("")
    expect(extractFileContext(FILE, -1)).toBe("")
    expect(extractFileContext(FILE, NaN)).toBe("")
    expect(extractFileContext("", 5)).toBe("")
  })
})

describe("parseEvaluatorResponse", () => {
  const valid = [
    {
      commentId: 999,
      classification: "ACCEPT",
      headline: "missing null check on `user.email`",
      body: "Wrap with `if (!user.email) return`.",
      location: "src/foo.ts:42",
    },
  ]

  it("parses a valid array", () => {
    const out = parseEvaluatorResponse(JSON.stringify(valid))
    expect(out).toHaveLength(1)
    expect(out?.[0]?.commentId).toBe(999)
    expect(out?.[0]?.classification).toBe("ACCEPT")
    expect(out?.[0]?.location).toBe("src/foo.ts:42")
  })

  it("strips a markdown ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseEvaluatorResponse(text)).toHaveLength(1)
  })

  it("wraps a single-object response into an array", () => {
    expect(parseEvaluatorResponse(JSON.stringify(valid[0]!))).toHaveLength(1)
  })

  it("rejects unknown classifications", () => {
    const bad = [{ commentId: 1, classification: "MAYBE", headline: "x", body: "y" }]
    expect(parseEvaluatorResponse(JSON.stringify(bad))).toBeNull()
  })

  it("rejects non-numeric commentId", () => {
    const bad = [{ commentId: "abc", classification: "ACCEPT", headline: "x", body: "y" }]
    expect(parseEvaluatorResponse(JSON.stringify(bad))).toBeNull()
  })

  it("returns null on bare prose", () => {
    expect(parseEvaluatorResponse("Sure! Here's the answer...")).toBeNull()
  })

  it("falls back to legacy `reason` field when `body` is absent", () => {
    const legacy = [
      {
        commentId: 5,
        classification: "SKIP_NITPICK",
        headline: "stylistic",
        reason: "this is the legacy reason field",
      },
    ]
    const out = parseEvaluatorResponse(JSON.stringify(legacy))
    expect(out?.[0]?.body).toBe("this is the legacy reason field")
  })

  it("preserves opener when set; omits when missing", () => {
    const withOpener = [{ ...valid[0], opener: "this read holds up because the regex is wrong" }]
    const out = parseEvaluatorResponse(JSON.stringify(withOpener))
    expect(out?.[0]?.opener).toContain("regex is wrong")

    const out2 = parseEvaluatorResponse(JSON.stringify(valid))
    expect(out2?.[0]?.opener).toBeUndefined()
  })
})

describe("formatVerdictReply", () => {
  const accept: CrVerdict = {
    commentId: 1,
    classification: "ACCEPT",
    headline: "missing null check",
    body: "Wrap `user.email` with a guard.",
    location: "src/foo.ts:42",
  }

  it("starts with the per-comment dedupe marker", () => {
    const reply = formatVerdictReply(accept, "danielmartinezjulio07")
    expect(reply).toContain(`<!-- openclaw:cr-eval:${accept.commentId} -->`)
  })

  it("includes the bracketed severity tag + headline on the first content line", () => {
    const reply = formatVerdictReply(accept, "danielmartinezjulio07")
    expect(reply).toContain("[ACCEPT] missing null check")
  })

  it("@-mentions the PR author on ACCEPT", () => {
    const reply = formatVerdictReply(accept, "danielmartinezjulio07")
    expect(reply).toContain("@danielmartinezjulio07 — flagging since this read holds up")
  })

  it("does not @-mention bot authors", () => {
    const reply = formatVerdictReply(accept, "openclaw[bot]")
    expect(reply).not.toContain("@openclaw[bot]")
  })

  it("rejects an opener containing `@` to avoid injecting GitHub mentions", () => {
    const dangerous: CrVerdict = {
      ...accept,
      opener: "@everyone — please look",
    }
    const reply = formatVerdictReply(dangerous, "alice")
    expect(reply).not.toContain("@everyone")
    expect(reply).toContain("flagging since this read holds up") // fallback opener
  })

  it("uses the model's opener when safe", () => {
    const safe: CrVerdict = {
      ...accept,
      opener: "this read holds up because the regex is wrong",
    }
    const reply = formatVerdictReply(safe, "bob")
    expect(reply).toContain("@bob — this read holds up because the regex is wrong.")
  })

  it("preserves a ```suggestion block in body verbatim", () => {
    const withSuggestion: CrVerdict = {
      ...accept,
      body: "Use `??` instead of `||`.\n\n```suggestion\nconst x = a ?? b\n```",
    }
    const reply = formatVerdictReply(withSuggestion, "alice")
    expect(reply).toContain("```suggestion")
    expect(reply).toContain("const x = a ?? b")
  })

  it("renders the location footer on ACCEPT", () => {
    const reply = formatVerdictReply(accept, "alice")
    expect(reply).toContain("**Where:** `src/foo.ts:42`")
  })

  it("uses the SKIP_NITPICK tag and skips the @-mention on SKIP_*", () => {
    const skip: CrVerdict = {
      commentId: 1,
      classification: "SKIP_NITPICK",
      headline: "stylistic preference",
      body: "Existing code is fine.",
    }
    const reply = formatVerdictReply(skip, "danielmartinezjulio07")
    expect(reply).toContain("[NITPICK — safe to skip]")
    expect(reply).not.toContain("@danielmartinezjulio07")
  })

  it("preserves a model-emitted @author mention in body verbatim", () => {
    // The cr-evaluation prompt instructs the model to weave a natural
    // @<author> mention into its body on debatable SKIP_* verdicts.
    // The formatter must not strip it. (CR's bot-loop protection
    // ignores @coderabbitai mentions in threaded replies, so the
    // model is told to escalate to the PR author instead.)
    const skip: CrVerdict = {
      commentId: 1,
      classification: "SKIP_OUT_OF_SCOPE",
      headline: "edges of scope",
      body: "Reading this as out of scope — @alice if that's wrong, push back.",
    }
    const reply = formatVerdictReply(skip, "alice")
    expect(reply).toContain("@alice")
  })

  it("does not inject any hardcoded pushback dialogue into the body", () => {
    // Earlier versions appended a canned line on every SKIP_*. We
    // dropped that — the model decides whether to invite pushback per
    // verdict instead of every reply ending the same way.
    const skip: CrVerdict = {
      commentId: 1,
      classification: "SKIP_NITPICK",
      headline: "stylistic",
      body: "existing code is fine",
    }
    const reply = formatVerdictReply(skip, "alice")
    expect(reply).not.toMatch(/if I've misread/i)
    expect(reply).not.toMatch(/push back here — happy to revise/i)
    expect(reply).not.toMatch(/@coderabbitai/i)
  })
})
