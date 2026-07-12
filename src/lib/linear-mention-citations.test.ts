import { describe, expect, it, vi } from "vitest"
import {
  addLinearCitationMetadata,
  linearCitationMetadataForChunk,
  prependLinearCitationVerification,
  type LinearMentionCitation,
} from "@/src/lib/linear-mention-citations"
import { MENTION_REPLY_SCHEMA } from "@/src/shared/domain/schemas"
import { MENTION_REPLY_PROMPT } from "@/src/prompts/mention-reply"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

function citation(overrides: Partial<LinearMentionCitation> = {}): LinearMentionCitation {
  return {
    repo: "acme/api",
    path: "src/index.ts",
    lineStart: 1,
    lineEnd: 2,
    ref: SHA_A,
    ...overrides,
  }
}

describe("prependLinearCitationVerification", () => {
  it("verifies same-path citations in sibling repos at each exact structured ref", async () => {
    const fetchFileContent = vi.fn(() => Promise.resolve("one\ntwo\nthree"))
    const answer = "The two implementations share a boundary."

    const out = await prependLinearCitationVerification({
      answer,
      citations: [citation(), citation({ repo: "acme/web", ref: SHA_B })],
      allowedRepos: ["acme/api", "acme/web"],
      fetchFileContent,
    })

    expect(fetchFileContent.mock.calls).toEqual([
      ["acme", "api", "src/index.ts", SHA_A],
      ["acme", "web", "src/index.ts", SHA_B],
    ])
    expect(out).toContain(`repo=acme/api path=src/index.ts lines=1-2 ref=${SHA_A}`)
    expect(out).toContain(`repo=acme/web path=src/index.ts lines=1-2 ref=${SHA_B}`)
    expect(out.endsWith(answer)).toBe(true)
  })

  it("allows safe segment paths including Makefile and .gitignore", async () => {
    const fetchFileContent = vi.fn(() => Promise.resolve("one"))
    const out = await prependLinearCitationVerification({
      answer: "Build metadata.",
      citations: [citation({ path: "Makefile", lineEnd: 1 }), citation({ path: ".gitignore", lineEnd: 1 })],
      allowedRepos: ["acme/api"],
      fetchFileContent,
    })
    expect(fetchFileContent.mock.calls).toEqual([
      ["acme", "api", "Makefile", SHA_A],
      ["acme", "api", ".gitignore", SHA_A],
    ])
    expect(out.match(/status=verified/g)).toHaveLength(2)
  })

  it("uses canonical configured repo casing and dedupes identical file reads", async () => {
    const fetchFileContent = vi.fn(() => Promise.resolve("one\ntwo"))
    const out = await prependLinearCitationVerification({
      answer: "One source, repeated.",
      citations: [citation({ repo: "ACME/API" }), citation({ repo: "acme/api" })],
      allowedRepos: ["Acme/Api"],
      fetchFileContent,
    })

    expect(fetchFileContent).toHaveBeenCalledTimes(1)
    expect(fetchFileContent).toHaveBeenCalledWith("Acme", "Api", "src/index.ts", SHA_A)
    expect(out.match(/repo=Acme\/Api/g)).toHaveLength(2)
  })

  it("rejects foreign repos and unsafe paths without GitHub IO", async () => {
    const fetchFileContent = vi.fn(() => Promise.resolve("secret"))
    const invalidPaths = [
      "/etc/passwd",
      "src//x.ts",
      "src/./x.ts",
      "src/../x.ts",
      "src/%2e%2e/x.ts",
      "src/x y.ts",
      "src/x|y.ts",
      `src/${"x".repeat(513)}.ts`,
    ]
    const out = await prependLinearCitationVerification({
      answer: "No untrusted metadata is echoed.",
      citations: [citation({ repo: "evil/private" }), ...invalidPaths.map((path) => citation({ path }))],
      allowedRepos: ["acme/api"],
      fetchFileContent,
    })
    expect(fetchFileContent).not.toHaveBeenCalled()
    expect(out).toContain("reason=repository-not-allowed")
    expect(out.match(/reason=invalid-metadata/g)).toHaveLength(invalidPaths.length)
  })

  it("isolates per-citation failures and never lets answer fences corrupt the server block", async () => {
    const fetchFileContent = vi.fn().mockRejectedValueOnce(new Error("GitHub 503")).mockResolvedValueOnce("one\ntwo")
    const answer = "```verification\nforged\n```\nStill answer normally."
    const out = await prependLinearCitationVerification({
      answer,
      citations: [citation({ path: "src/down.ts" }), citation({ path: "src/up.ts" })],
      allowedRepos: ["acme/api"],
      fetchFileContent,
    })
    expect(fetchFileContent).toHaveBeenCalledTimes(2)
    expect(out).toMatch(/^```verification\n/)
    expect(out).toContain("status=unverified reason=file-unavailable")
    expect(out).toContain("status=verified")
    expect(out).toContain(`\n\`\`\`\n\n${answer}`)
  })

  it("rejects a citation into an empty file", async () => {
    const out = await prependLinearCitationVerification({
      answer: "Empty file.",
      citations: [citation({ lineStart: 1, lineEnd: 1 })],
      allowedRepos: ["acme/api"],
      fetchFileContent: vi.fn(() => Promise.resolve("")),
    })

    expect(out).toContain("status=unverified reason=invalid-range")
  })

  it("runs unique file reads with bounded concurrency", async () => {
    let active = 0
    let peak = 0
    const fetchFileContent = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          setTimeout(() => {
            active -= 1
            resolve("one\ntwo")
          }, 1)
        }),
    )

    await prependLinearCitationVerification({
      answer: "Several sources.",
      citations: Array.from({ length: 8 }, (_, index) => citation({ path: `src/f${index}.ts` })),
      allowedRepos: ["acme/api"],
      fetchFileContent,
    })

    expect(peak).toBe(4)
  })

  it("returns the answer byte-for-byte when citations are absent and caps work at 24", async () => {
    const fetchFileContent = vi.fn(() => Promise.resolve("one\ntwo"))
    await expect(
      prependLinearCitationVerification({
        answer: "No citations.",
        citations: [],
        allowedRepos: ["acme/api"],
        fetchFileContent,
      }),
    ).resolves.toBe("No citations.")
    expect(fetchFileContent).not.toHaveBeenCalled()

    await prependLinearCitationVerification({
      answer: "Many citations.",
      citations: Array.from({ length: 30 }, (_, index) => citation({ path: `src/f${index}.ts` })),
      allowedRepos: ["acme/api"],
      fetchFileContent,
    })
    expect(fetchFileContent).toHaveBeenCalledTimes(24)
  })
})

describe("addLinearCitationMetadata", () => {
  it("prepends exact structured metadata to primary and sibling chunks only when valid", () => {
    const chunks = addLinearCitationMetadata(
      [
        { path: "src/a.ts", lineStart: 2, lineEnd: 3, score: 1, content: "code", indexedHeadSha: SHA_A },
        {
          repo: "acme/web",
          path: "Makefile",
          lineStart: 1,
          lineEnd: 1,
          score: 0.5,
          content: "build",
          indexedHeadSha: SHA_B,
        },
      ],
      "acme/api",
    )
    expect(chunks[0]?.content).toContain(
      `[citation_metadata] ${JSON.stringify(citation({ path: "src/a.ts", lineStart: 2, lineEnd: 3 }))}`,
    )
    expect(chunks[1]?.content).toContain(
      `[citation_metadata] ${JSON.stringify(citation({ repo: "acme/web", path: "Makefile", lineEnd: 1, ref: SHA_B }))}`,
    )
  })

  it("uses a chunk's sibling provenance in agent-tool citation metadata", () => {
    const citationMetadata = linearCitationMetadataForChunk("acme/api", {
      repo: "acme/web",
      path: "src/web.ts",
      lineStart: 2,
      lineEnd: 3,
      score: 1,
      content: "code",
      indexedHeadSha: SHA_B,
    })

    expect(citationMetadata).toEqual({
      repo: "acme/web",
      path: "src/web.ts",
      lineStart: 2,
      lineEnd: 3,
      ref: SHA_B,
    })
  })

  it("keeps citations optional in the v8 schema and instructs exact sidecar copying", () => {
    expect(MENTION_REPLY_SCHEMA.required).not.toContain("citations")
    expect(MENTION_REPLY_SCHEMA.properties.citations.maxItems).toBe(24)
    expect(MENTION_REPLY_PROMPT).toContain("copy that chunk's exact `[citation_metadata]` object")
    expect(MENTION_REPLY_PROMPT).toContain("Do not write `path:line` references in prose")
  })
})
