// ARC-191 — `/sigilix describe` renderers, parser, builder, handler.

import { describe, it, expect } from "vitest"

import {
  renderDescribeComment,
  renderDisabledComment,
  renderSensitiveDenialComment,
  renderUsageComment,
  renderFailureComment,
  renderNoChangesComment,
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
