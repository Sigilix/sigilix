// GitHub @-mention reply pure helpers — response parser + reply
// formatter. The handler itself orchestrates network calls and is
// covered by integration smoke; these tests pin down the JSON-shape
// tolerance and the marker discipline.

import { describe, expect, it } from "vitest"
import {
  formatReply,
  parseGithubMentionResponse,
} from "../src/lib/github-mention"

describe("parseGithubMentionResponse", () => {
  const valid = {
    answer: "Fixed — guard now uses `<=` on `bounds.length` at `src/lib/foo.ts:42`.",
    confidence: 4,
    abstain: false,
  }

  it("parses a well-formed JSON object", () => {
    const out = parseGithubMentionResponse(JSON.stringify(valid))
    expect(out?.answer).toBe(valid.answer)
    expect(out?.confidence).toBe(4)
    expect(out?.abstain).toBe(false)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("extracts JSON from prose-wrapped output", () => {
    const text = `Here's my answer:\n\n${JSON.stringify(valid)}\n\n— Arc`
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("returns null on missing answer", () => {
    expect(parseGithubMentionResponse(JSON.stringify({ ...valid, answer: "" }))).toBeNull()
  })

  it("falls back to confidence 3 when confidence is out of range", () => {
    const out = parseGithubMentionResponse(JSON.stringify({ ...valid, confidence: 99 }))
    expect(out?.confidence).toBe(3)
  })

  it("falls back to confidence 3 when confidence is missing", () => {
    const obj = { answer: valid.answer, abstain: false }
    const out = parseGithubMentionResponse(JSON.stringify(obj))
    expect(out?.confidence).toBe(3)
  })

  it("coerces abstain to boolean", () => {
    const out = parseGithubMentionResponse(
      JSON.stringify({ answer: valid.answer, confidence: 2, abstain: "yes" })
    )
    expect(out?.abstain).toBe(true)
  })

  it("returns null on non-object input", () => {
    expect(parseGithubMentionResponse("[1, 2, 3]")).toBeNull()
    expect(parseGithubMentionResponse("not json")).toBeNull()
  })
})

describe("formatReply", () => {
  it("prepends the dedupe marker so Arc's own replies are detectable", () => {
    const out = formatReply({
      answer: "Fixed — guard now uses `<=` on `bounds.length`.",
      confidence: 5,
      abstain: false,
    })
    expect(out.startsWith("<!-- openclaw:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("Fixed — guard now uses")
  })

  it("preserves the model's Markdown verbatim under the marker", () => {
    const answer = "Returns `null` when `x` is empty — see `src/lib/foo.ts:42`."
    const out = formatReply({ answer, confidence: 3, abstain: false })
    expect(out.endsWith(answer)).toBe(true)
  })
})
