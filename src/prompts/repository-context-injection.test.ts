import { describe, expect, it } from "vitest"

import { buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"

const REPOSITORY_CONTEXT_BLOCK = `[REPOSITORY CONTEXT — UNTRUSTED DATA]
{"repositories":[{"fullName":"Sigilix/sigilix","context":"Review worker"},{"fullName":"Sigilix/portal","context":"Portal UI"}]}`

function buildPrompt(repositoryContextBlock?: string): string {
  const ctx = {
    prNumber: 42,
    title: "Repository context wiring",
    body: "Use canonical cross-repository context.",
    diff: "diff --git a/src/index.ts b/src/index.ts\n",
    retrievalSnapshot: "retrieval marker",
    namespace: "owner/repo",
    graphContext: "graph marker",
    dynamicEvidenceBlock: "[DYNAMIC REVIEW EVIDENCE]\ndynamic marker",
    ...(repositoryContextBlock !== undefined ? { repositoryContextBlock } : {}),
  }
  return buildSpecialistInitialMessage(ctx)
}

describe("buildSpecialistInitialMessage — repository context placement", () => {
  it("keeps an empty repository-context block byte-identical to an omitted block", () => {
    expect(buildPrompt("")).toBe(buildPrompt())
  })

  it("renders canonical context exactly once after grounding and before the follow-up namespace", () => {
    const prompt = buildPrompt(REPOSITORY_CONTEXT_BLOCK)

    expect(prompt.match(/\[REPOSITORY CONTEXT — UNTRUSTED DATA\]/gu) ?? []).toHaveLength(1)
    expect(prompt).toContain("Sigilix/portal")
    expect(prompt.indexOf("dynamic marker")).toBeLessThan(prompt.indexOf(REPOSITORY_CONTEXT_BLOCK))
    expect(prompt.indexOf(REPOSITORY_CONTEXT_BLOCK)).toBeLessThan(
      prompt.indexOf("[CODEBASE NAMESPACE FOR FOLLOW-UP retrieve_codebase CALLS]"),
    )
  })
})
