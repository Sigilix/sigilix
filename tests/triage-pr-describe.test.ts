// ARC-191 — `/sigilix describe` renderers, parser, builder, handler.

import { describe, it, expect } from "vitest"

import {
  renderDescribeComment,
  renderDisabledComment,
  renderSensitiveDenialComment,
  renderUsageComment,
  renderFailureComment,
  renderNoChangesComment,
  parsePrDescribeResponse,
  buildPrompt,
  truncateForGitHub,
} from "../src/lib/triage-pr-describe"

describe("renderDescribeComment", () => {
  it("renders the success draft with visible markers, hidden meta, and subtext for pr-description", () => {
    const out = renderDescribeComment({
      mode: "pr-description",
      headSha: "abc1234567890abcdef1234567890abcdef12345",
      summary: "Adds the foo bar widget.",
      body: "## Summary\nAdds the foo bar widget.\n\n## Testing\n- new unit tests in tests/foo.test.ts",
    })
    expect(out).toMatchInlineSnapshot(`
      "**Sigilix describe** — \`PR description\` draft

      Adds the foo bar widget.

      <!-- sigilix:describe:pr-description:start -->
      ## Summary
      Adds the foo bar widget.

      ## Testing
      - new unit tests in tests/foo.test.ts
      <!-- sigilix:describe:pr-description:end -->

      <sub>Run on \`abc1234\`. Copy the section between markers into the PR description / changelog. \`/sigilix describe apply\` (auto-write) coming in a follow-up.</sub>

      <!-- sigilix-meta: {"kind":"describe","mode":"pr-description","headSha":"abc1234567890abcdef1234567890abcdef12345","schema":1,"source":"comment-draft"} -->"
    `)
  })

  it("renders the success draft for internal-changelog", () => {
    const out = renderDescribeComment({
      mode: "internal-changelog",
      headSha: "deadbee0000000000000000000000000000000d",
      summary: "Internal note.",
      body: "**Refactor:** consolidated foo.\n\n- moved helpers into util/\n- no behavior change",
    })
    expect(out).toMatchInlineSnapshot(`
      "**Sigilix describe** — \`internal changelog\` draft

      Internal note.

      <!-- sigilix:describe:internal-changelog:start -->
      **Refactor:** consolidated foo.

      - moved helpers into util/
      - no behavior change
      <!-- sigilix:describe:internal-changelog:end -->

      <sub>Run on \`deadbee\`. Copy the section between markers into the PR description / changelog. \`/sigilix describe apply\` (auto-write) coming in a follow-up.</sub>

      <!-- sigilix-meta: {"kind":"describe","mode":"internal-changelog","headSha":"deadbee0000000000000000000000000000000d","schema":1,"source":"comment-draft"} -->"
    `)
  })

  it("renders the success draft for external-changelog", () => {
    const out = renderDescribeComment({
      mode: "external-changelog",
      headSha: "1234567890abcdef0000000000000000000000ab",
      summary: "User note.",
      body: "**New:** Faster widget loads.",
    })
    expect(out).toMatchInlineSnapshot(`
      "**Sigilix describe** — \`external changelog\` draft

      User note.

      <!-- sigilix:describe:external-changelog:start -->
      **New:** Faster widget loads.
      <!-- sigilix:describe:external-changelog:end -->

      <sub>Run on \`1234567\`. Copy the section between markers into the PR description / changelog. \`/sigilix describe apply\` (auto-write) coming in a follow-up.</sub>

      <!-- sigilix-meta: {"kind":"describe","mode":"external-changelog","headSha":"1234567890abcdef0000000000000000000000ab","schema":1,"source":"comment-draft"} -->"
    `)
  })

  it("emits a single-line JSON `sigilix-meta` HTML comment for future apply parsing", () => {
    const out = renderDescribeComment({
      mode: "pr-description",
      headSha: "abc",
      summary: "x",
      body: "y",
    })
    const metaLine = out.split("\n").find((l) => l.includes("sigilix-meta:"))
    expect(metaLine).toBeDefined()
    expect(metaLine!).toMatch(/<!-- sigilix-meta: \{.*\} -->/)
    const json = metaLine!.match(/<!-- sigilix-meta: (\{.*\}) -->/)?.[1] ?? ""
    const parsed = JSON.parse(json)
    expect(parsed).toEqual({
      kind: "describe",
      mode: "pr-description",
      headSha: "abc",
      schema: 1,
      source: "comment-draft",
    })
  })
})

describe("renderDisabledComment", () => {
  it("explains the disable mechanism in plain English", () => {
    const out = renderDisabledComment()
    expect(out).toContain("disabled")
    expect(out).toContain("`sigilix.json`")
    expect(out).toContain("describe.enabled")
  })
})

describe("renderSensitiveDenialComment", () => {
  it("explains the sensitive-repo gate without leaking config", () => {
    const out = renderSensitiveDenialComment()
    expect(out).toContain("sensitive")
    expect(out).toContain("operator")
  })
})

describe("renderUsageComment", () => {
  it("lists the three valid mode tokens and quotes the user's bad arg", () => {
    const out = renderUsageComment("foo")
    expect(out).toContain("`foo`")
    expect(out).toContain("`pr`")
    expect(out).toContain("`internal`")
    expect(out).toContain("`external`")
  })
})

describe("renderFailureComment", () => {
  it("includes the mode and the retry hint", () => {
    const out = renderFailureComment("internal-changelog")
    expect(out).toContain("could not generate")
    expect(out).toContain("internal-changelog")
    expect(out).toContain("/sigilix describe internal")
  })

  it("uses the short-token form in the retry hint for each mode", () => {
    expect(renderFailureComment("pr-description")).toContain("/sigilix describe pr")
    expect(renderFailureComment("internal-changelog")).toContain("/sigilix describe internal")
    expect(renderFailureComment("external-changelog")).toContain("/sigilix describe external")
  })
})

describe("renderNoChangesComment", () => {
  it("explains there's nothing to describe and references the PR number", () => {
    const out = renderNoChangesComment(42)
    expect(out).toContain("no changes")
    expect(out).toContain("#42")
  })
})

describe("parsePrDescribeResponse", () => {
  it("parses a clean verdict", () => {
    const json = JSON.stringify({
      summary: "Adds the foo bar widget for users.",
      body: "## Summary\n\nAdds the foo bar widget. Users will see a new button on the home screen.",
    })
    const v = parsePrDescribeResponse(json)
    expect(v).not.toBeNull()
    expect(v!.summary).toBe("Adds the foo bar widget for users.")
    expect(v!.body).toContain("foo bar widget")
  })

  it("returns null for unparseable text", () => {
    expect(parsePrDescribeResponse("not json")).toBeNull()
  })

  it("returns null for missing summary", () => {
    expect(parsePrDescribeResponse(JSON.stringify({ body: "x".repeat(60) }))).toBeNull()
  })

  it("returns null for missing body", () => {
    expect(parsePrDescribeResponse(JSON.stringify({ summary: "ten chars." }))).toBeNull()
  })

  it("returns null for too-short summary (< 10 chars)", () => {
    expect(parsePrDescribeResponse(JSON.stringify({
      summary: "short",
      body: "x".repeat(60),
    }))).toBeNull()
  })

  it("returns null for too-short body (< 50 chars)", () => {
    expect(parsePrDescribeResponse(JSON.stringify({
      summary: "ten chars exactly here.",
      body: "still too short",
    }))).toBeNull()
  })

  it("returns null for non-string fields", () => {
    expect(parsePrDescribeResponse(JSON.stringify({
      summary: 42,
      body: "x".repeat(60),
    }))).toBeNull()
    expect(parsePrDescribeResponse(JSON.stringify({
      summary: "ten chars exactly here.",
      body: ["array", "not", "string"],
    }))).toBeNull()
  })

  it("trims whitespace from summary + body", () => {
    const v = parsePrDescribeResponse(JSON.stringify({
      summary: "   ten chars exactly here.   ",
      body: "   " + "x".repeat(60) + "   ",
    }))
    expect(v!.summary).toBe("ten chars exactly here.")
    expect(v!.body.startsWith(" ")).toBe(false)
    expect(v!.body.endsWith(" ")).toBe(false)
  })

  it("tolerates light JSON malformation via parseFirstJsonObject", () => {
    // The model sometimes wraps in a code fence; parseFirstJsonObject
    // already strips that.
    const text = "```json\n" + JSON.stringify({
      summary: "Adds the foo bar widget.",
      body: "x".repeat(60),
    }) + "\n```"
    const v = parsePrDescribeResponse(text)
    expect(v).not.toBeNull()
  })
})

describe("buildPrompt", () => {
  it("wraps PR title / body / diff in UNTRUSTED-CONTENT blocks per mode", () => {
    const prompt = buildPrompt({
      mode: "pr-description",
      prNumber: 42,
      title: "Add the widget",
      body: "Closes #41. Adds a widget.",
      diff: "diff --git a/src/foo.ts ...\n+console.log('hi')",
    })
    expect(prompt).toContain('<UNTRUSTED-CONTENT type="pr-title">Add the widget</UNTRUSTED-CONTENT>')
    expect(prompt).toContain('<UNTRUSTED-CONTENT type="pr-body">Closes #41. Adds a widget.</UNTRUSTED-CONTENT>')
    expect(prompt).toContain('<UNTRUSTED-CONTENT type="pr-diff">')
    expect(prompt).toContain("diff --git a/src/foo.ts")
    expect(prompt).toContain("PR description")
  })

  it("uses internal-changelog prompt for that mode", () => {
    const prompt = buildPrompt({
      mode: "internal-changelog",
      prNumber: 1, title: "x", body: "", diff: "",
    })
    expect(prompt).toContain("internal changelog")
  })

  it("uses external-changelog prompt with disclosure boundary for that mode", () => {
    const prompt = buildPrompt({
      mode: "external-changelog",
      prNumber: 1, title: "x", body: "", diff: "",
    })
    expect(prompt).toContain("external changelog")
    expect(prompt).toContain("Disclosure boundary")
    expect(prompt).toContain("(no user-facing changes)")
  })

  it("truncates oversized diffs with the existing improve marker", () => {
    const huge = "x".repeat(200_000)
    const prompt = buildPrompt({
      mode: "pr-description",
      prNumber: 1, title: "x", body: "", diff: huge,
    })
    expect(prompt).toContain("[…truncated…]")
    expect(prompt.length).toBeLessThan(huge.length)
  })

  it("substitutes a placeholder for empty PR body so the model knows it's intentional", () => {
    const prompt = buildPrompt({
      mode: "pr-description",
      prNumber: 1, title: "x", body: "", diff: "",
    })
    expect(prompt).toContain("(no description)")
  })
})

describe("truncateForGitHub", () => {
  it("returns input unchanged when under the cap", () => {
    expect(truncateForGitHub("hello", 60_000)).toBe("hello")
  })

  it("truncates the body field with a marker when output would exceed the cap", () => {
    const body = "x".repeat(70_000)
    const out = truncateForGitHub(body, 60_000)
    expect(out.length).toBeLessThanOrEqual(60_000)
    expect(out).toContain("[…truncated to fit GitHub comment limit]")
  })

  it("handles a cap smaller than the marker length gracefully", () => {
    const out = truncateForGitHub("x".repeat(100), 10)
    expect(out.length).toBeLessThanOrEqual(10)
  })
})
