import { describe, it, expect } from "vitest"
import { stripThinking, isLowQuality, htmlToText, extractTitle, truncate, isTrivialMessage } from "./text-utils"

describe("stripThinking", () => {
  it("removes paired <think> blocks and trims", () => {
    expect(stripThinking("<think>reasoning here</think>The answer.")).toBe("The answer.")
  })

  it("removes <thinking> and <reasoning> variants case-insensitively", () => {
    expect(stripThinking("<THINKING>x</THINKING>a<Reasoning>y</Reasoning>b")).toBe("ab")
  })

  it("drops a truncated (unmatched opening) reasoning tail so it never leaks", () => {
    // Revert-proof: if the unmatched-opener branch were removed, the secret CoT
    // tail would leak into the returned text.
    expect(stripThinking("visible<think>secret chain of thought never ends")).toBe("visible")
  })

  it("drops everything before an unmatched closing tag", () => {
    expect(stripThinking("leaked cot</think>final")).toBe("final")
  })

  it("returns empty for empty input", () => {
    expect(stripThinking("")).toBe("")
  })
})

describe("isLowQuality", () => {
  it("flags empty / too-short text", () => {
    expect(isLowQuality("")).toBe(true)
    expect(isLowQuality("short")).toBe(true)
  })

  it("flags pure junk/boilerplate markers", () => {
    expect(isLowQuality("No relevant information. Could not find. N/A. None found.")).toBe(true)
  })

  it("flags a repeated-token wall (low lexical diversity)", () => {
    expect(isLowQuality("spam spam spam spam spam spam spam spam spam spam spam spam")).toBe(true)
  })

  it("accepts genuinely informative text", () => {
    expect(
      isLowQuality(
        "The useEffect cleanup function runs before the component unmounts and before " +
          "every re-render where the dependency array has changed, preventing stale subscriptions.",
      ),
    ).toBe(false)
  })
})

describe("htmlToText", () => {
  it("drops script/style subtrees entirely", () => {
    const html = "<p>keep</p><script>evil()</script><style>.x{}</style><p>also keep</p>"
    const out = htmlToText(html)
    expect(out).toContain("keep")
    expect(out).toContain("also keep")
    expect(out).not.toContain("evil")
    expect(out).not.toContain(".x{}")
  })

  it("decodes entities and collapses whitespace", () => {
    expect(htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>")).toBe("a & b")
  })

  it("decodes numeric references", () => {
    expect(htmlToText("<p>&#65;&#x42;</p>")).toBe("AB")
  })

  it("returns empty for empty input", () => {
    expect(htmlToText("")).toBe("")
  })
})

describe("extractTitle", () => {
  it("pulls and cleans the <title>", () => {
    expect(extractTitle("<html><head><title>  Hello   World </title></head></html>")).toBe("Hello World")
  })

  it("returns empty when absent", () => {
    expect(extractTitle("<html><body>no title</body></html>")).toBe("")
  })
})

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("abc", 10)).toBe("abc")
  })
  it("caps long text with a marker", () => {
    expect(truncate("abcdefgh", 3)).toBe("abc\n…[truncated]")
  })
})

describe("isTrivialMessage", () => {
  it("flags greetings / thanks / acknowledgements (case + punctuation insensitive)", () => {
    for (const m of [
      "hey!",
      "Hi",
      "hello there",
      "thanks",
      "Thank you!",
      "ok",
      "cool",
      "sounds good",
      "bye",
      "what's up?",
    ]) {
      expect(isTrivialMessage(m)).toBe(true)
    }
  })

  it("flags pure emoji / punctuation", () => {
    expect(isTrivialMessage("\u{1F44B}")).toBe(true)
    expect(isTrivialMessage("!!!")).toBe(true)
  })

  it("does NOT flag a real question, even one that opens with a greeting", () => {
    for (const m of [
      "hey, where does auth live in our repo?",
      "what is the latest stable Node.js version?",
      "fix the failing CI job",
      "compare our approach to OAuth 2.1",
    ]) {
      expect(isTrivialMessage(m)).toBe(false)
    }
  })

  it("does NOT flag a real non-latin-script question as empty/trivial", () => {
    expect(isTrivialMessage("\u8BA4\u8BC1\u5728\u54EA\u91CC\u5B9A\u4E49\uFF1F")).toBe(false)
  })
})
