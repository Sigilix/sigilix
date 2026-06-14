import { describe, expect, it, vi } from "vitest"
import { verifyAndSanitizeCitations } from "@/src/lib/citation-verifier"

describe("verifyAndSanitizeCitations", () => {
  it("rewrites line citations that do not exist on the live ref", async () => {
    const fetchFileContent = vi.fn(async () => Array.from({ length: 549 }, (_, i) => `line ${i + 1}`).join("\n"))

    const out = await verifyAndSanitizeCitations({
      answer: "The slash dispatcher is at `src/index.ts:3689`.",
      ref: "479ea6b",
      fetchFileContent,
    })

    expect(out.answer).not.toContain("src/index.ts:3689")
    expect(out.answer).toContain("src/index.ts (line 3689 not verified on current ref)")
    expect(out.answer).toContain("Citation check:")
    expect(out.invalid).toEqual([
      {
        raw: "src/index.ts:3689",
        path: "src/index.ts",
        lineStart: 3689,
        lineEnd: 3689,
        reason: "line-out-of-range",
        totalLines: 549,
      },
    ])
  })

  it("leaves valid ranges unchanged", async () => {
    const fetchFileContent = vi.fn(async () => Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"))

    const out = await verifyAndSanitizeCitations({
      answer: "The helper is still at `src/lib/foo.ts:4-6`.",
      ref: "head-sha",
      fetchFileContent,
    })

    expect(out.answer).toBe("The helper is still at `src/lib/foo.ts:4-6`.")
    expect(out.invalid).toEqual([])
  })

  it("leaves citations unchanged when file content is unavailable", async () => {
    const out = await verifyAndSanitizeCitations({
      answer: "The helper is at `src/lib/foo.ts:4-6`.",
      ref: "head-sha",
      fetchFileContent: async () => null,
    })

    expect(out.answer).toContain("Unable to verify cited file/line ranges")
    expect(out.answer).toContain("src/lib/foo.ts:4-6")
    expect(out.invalid).toEqual([])
  })

  it("leaves citations unchanged when GitHub fetch throws", async () => {
    const out = await verifyAndSanitizeCitations({
      answer: "The helper is at `src/lib/foo.ts:4-6`.",
      ref: "head-sha",
      fetchFileContent: async () => {
        throw new Error("GitHub 503")
      },
    })

    expect(out.answer).toContain("Unable to verify cited file/line ranges")
    expect(out.answer).toContain("src/lib/foo.ts:4-6")
    expect(out.invalid).toEqual([])
  })

  it("does not rewrite path-like strings inside fenced code blocks", async () => {
    const out = await verifyAndSanitizeCitations({
      answer: "Patch:\n```suggestion\nconst x = 'src/index.ts:3689'\n```",
      ref: "479ea6b",
      fetchFileContent: async () => "line 1\n",
    })

    expect(out.answer).toContain("src/index.ts:3689")
    expect(out.invalid).toEqual([])
  })

  it("rewrites invalid prose citations without touching the same text inside fenced code", async () => {
    const out = await verifyAndSanitizeCitations({
      answer: "The stale line is `src/index.ts:3689`.\n\n```ts\nconst marker = 'src/index.ts:3689'\n```",
      ref: "479ea6b",
      fetchFileContent: async () => "line 1\n",
    })

    expect(out.answer).toContain("src/index.ts (line 3689 not verified on current ref)")
    expect(out.answer).toContain("const marker = 'src/index.ts:3689'")
    expect(out.invalid).toHaveLength(1)
  })
})
