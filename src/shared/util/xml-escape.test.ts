import { describe, expect, it } from "vitest"
import { escapeXmlAttribute, escapeXmlText } from "@/shared/util/xml-escape"

describe("escapeXmlText", () => {
  it("escapes literal closing tags so </pr_context> is inert", () => {
    expect(escapeXmlText("</pr_context>")).toBe("&lt;/pr_context&gt;")
  })

  it("escapes ampersand, lt, gt", () => {
    expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d")
  })

  it("renders ]]> inert via > → &gt; (no special CDATA rule needed)", () => {
    expect(escapeXmlText("foo ]]> bar")).toBe("foo ]]&gt; bar")
  })

  it("preserves benign input round-trip-equivalently", () => {
    expect(escapeXmlText("regular text 123")).toBe("regular text 123")
  })

  it("escapes ampersand first to avoid double-encoding", () => {
    expect(escapeXmlText("&lt;")).toBe("&amp;lt;")
  })

  it("handles empty string", () => {
    expect(escapeXmlText("")).toBe("")
  })
})

describe("escapeXmlAttribute", () => {
  it("escapes double-quote so a value can't close the attribute", () => {
    expect(escapeXmlAttribute('merged" injected="yes')).toBe(
      "merged&quot; injected=&quot;yes"
    )
  })

  it("inherits text-node escaping (lt, gt, amp)", () => {
    expect(escapeXmlAttribute("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d")
  })
})
