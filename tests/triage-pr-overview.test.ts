// PR overview prompt parser + comment formatter. The pipeline (PR fetch
// → Ollama → post comment) is integration-tested manually after deploy;
// these unit tests cover only the pure helpers.

import { describe, expect, it } from "vitest"
import {
  formatOverviewComment,
  parseOverviewResponse,
  type PrOverviewVerdict,
} from "../src/lib/triage-pr-overview"

describe("parseOverviewResponse", () => {
  const valid: PrOverviewVerdict = {
    summary: "Adds a regex guard around path normalization.",
    confidence: 4,
    confidenceReason: "Small surface, well-tested.",
    files: [
      { path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" },
    ],
    bullets: ["Verify the regex catches `..` segments"],
  }

  it("parses a well-formed JSON object", () => {
    const text = JSON.stringify(valid)
    expect(parseOverviewResponse(text)).toEqual(valid)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseOverviewResponse(text)).toEqual(valid)
  })

  it("returns null when summary is missing", () => {
    const broken = { ...valid, summary: "" }
    expect(parseOverviewResponse(JSON.stringify(broken))).toBeNull()
  })

  it("returns null when confidence is out of range", () => {
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: 0 }))).toBeNull()
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: 6 }))).toBeNull()
    expect(parseOverviewResponse(JSON.stringify({ ...valid, confidence: "five" }))).toBeNull()
  })

  it("clamps per-file score to 1-5", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...valid,
        files: [{ path: "a.ts", score: 99 }, { path: "b.ts", score: -3 }],
      })
    )
    expect(out?.files[0]?.score).toBe(5)
    expect(out?.files[1]?.score).toBe(1)
  })

  it("caps files at 5", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      score: 3,
      overview: "x",
      nextStep: "y",
    }))
    const out = parseOverviewResponse(JSON.stringify({ ...valid, files: many }))
    expect(out?.files).toHaveLength(5)
  })

  it("drops files without a path", () => {
    const out = parseOverviewResponse(
      JSON.stringify({
        ...valid,
        files: [{ score: 3 }, { path: "ok.ts", score: 2 }],
      })
    )
    expect(out?.files).toHaveLength(1)
    expect(out?.files[0]?.path).toBe("ok.ts")
  })

  it("returns null on bare prose / no JSON", () => {
    expect(parseOverviewResponse("Sure! Here's the overview...")).toBeNull()
  })

  it("extracts the first object even when wrapped in an array (lenient fallback)", () => {
    // Model occasionally returns `[{...}]` despite the prompt asking for
    // a bare object. Balanced-brace scan picks the first `{...}` inside.
    const out = parseOverviewResponse('[{"summary":"x","confidence":3}]')
    expect(out?.summary).toBe("x")
    expect(out?.confidence).toBe(3)
  })

  it("extracts the JSON object from prose-wrapped responses", () => {
    const wrapped = `Here's the overview for the PR:\n\n{"summary":"adds a guard","confidence":4}\n\nLet me know if you need adjustments.`
    const out = parseOverviewResponse(wrapped)
    expect(out?.summary).toBe("adds a guard")
    expect(out?.confidence).toBe(4)
  })
})

describe("formatOverviewComment", () => {
  const verdict: PrOverviewVerdict = {
    summary: "Adds null-safe access on `user.profile`.",
    confidence: 4,
    confidenceReason: "Narrow surface; good test coverage.",
    files: [
      { path: "app/user.ts", score: 4, overview: "Guards profile read", nextStep: "Add e2e test" },
    ],
    bullets: ["lines 42-58 — verify the fallback empties the badge cache"],
  }

  it("starts with the dedupe marker on line 1", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md.split("\n")[0]).toBe("<!-- openclaw:pr-overview -->")
  })

  it("renders the summary heading + content", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("## Sigilix Overview")
    expect(md).toContain("### Summary")
    expect(md).toContain(verdict.summary)
  })

  it('appends " — latest push" on incremental runs', () => {
    const md = formatOverviewComment({ verdict, isFirstRun: false })
    expect(md).toContain("### Summary — latest push")
  })

  it("renders the per-file table when files are present", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("### Important files")
    expect(md).toContain("| File | Score | Notes | Next step |")
    expect(md).toMatch(/\| `app\/user\.ts` \| 4\/5 \|/)
  })

  it("omits the file table when files is empty", () => {
    const md = formatOverviewComment({
      verdict: { ...verdict, files: [] },
      isFirstRun: true,
    })
    expect(md).not.toContain("### Important files")
  })

  it("renders confidence + reason", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true })
    expect(md).toContain("### Confidence: 4/5")
    expect(md).toContain(verdict.confidenceReason)
  })

  it("renders each bullet as a list item", () => {
    const md = formatOverviewComment({
      verdict: { ...verdict, bullets: ["one", "two"] },
      isFirstRun: true,
    })
    expect(md).toContain("- one")
    expect(md).toContain("- two")
  })

  // Founder pivot (2026-05-17): the "[!NOTE] Sigilix is warming up
  // its index..." callout that briefly shipped on PR #80 was pulled
  // — too noisy on cold-install PRs. The marker stays (so the rerun
  // fan-out can still grep PRs that need post-indexing re-review)
  // but the customer-visible text is gone.
  it("emits the warmup callout marker (no visible text) when warmup is pending", async () => {
    const { WARMUP_CALLOUT_MARKER } = await import("../src/lib/warmup")
    const md = formatOverviewComment({ verdict, isFirstRun: true, warmup: "pending" })
    expect(md).toContain(WARMUP_CALLOUT_MARKER) // marker present (for rerun detection)
    expect(md).not.toContain("[!NOTE]") // no visible callout block
    expect(md).not.toContain("Sigilix is warming up its index") // no visible header
    expect(md).not.toContain("cross-file context isn't available") // no visible body
  })

  it("omits the warmup marker entirely when warmup is none", () => {
    const md = formatOverviewComment({ verdict, isFirstRun: true, warmup: "none" })
    expect(md).not.toContain("sigilix:warmup-callout")
  })
})
