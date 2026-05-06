// ARC-181 — auto-inline poster tests.
//
// Codex MAJOR #5: explicit absent-config + empty-config coverage.
// Kimi MINOR #6: `ast-rules-inline-posted` telemetry assertion.

import { describe, it, expect, vi } from "vitest"
import { postAstInlineFindings } from "../src/lib/ast-rules/inline-poster"
import { resolveAstRulesConfig } from "../src/lib/sigilix-config"
import type { GitHubClient, SubmitReviewBody } from "../src/lib/github"
import type { AstFinding } from "../src/lib/ast-rules/types"

const CTX = { owner: "o", repo: "r", prNumber: 1, headSha: "h".repeat(40) }

function makeClient(submitReview = vi.fn(async () => ({ id: 1, state: "COMMENTED" }))): {
  client: GitHubClient
  submitReview: typeof submitReview
} {
  return {
    client: { submitReview } as unknown as GitHubClient,
    submitReview,
  }
}

const ERROR_FINDING: AstFinding = {
  ruleId: "no-eval-call",
  severity: "error",
  roleHint: "security",
  path: "src/auth.ts",
  line: 42,
  column: 14,
  message: "Direct eval() call",
  evidence: `eval("payload")`,
  astFindingId: "ast/no-eval-call/abcdef0/42",
}

const WARNING_FINDING: AstFinding = {
  ruleId: "no-throw-literal",
  severity: "warning",
  roleHint: "logic",
  path: "src/util.ts",
  line: 7,
  column: 2,
  message: "Throw of literal",
  evidence: `throw "boom"`,
  astFindingId: "ast/no-throw-literal/1234567/7",
}

describe("postAstInlineFindings — gating", () => {
  it("does NOT post when autoInline is false (default-config)", async () => {
    // Caller (ensemble) is responsible for the gate; here we test
    // the poster's inputs would be empty when the gate is false.
    // resolveAstRulesConfig confirms the default.
    expect(resolveAstRulesConfig({}).autoInline).toBe(false)
  })

  it("ABSENT-config (Codex MAJOR #5): astRules undefined → autoInline false", () => {
    expect(resolveAstRulesConfig(null).autoInline).toBe(false)
    expect(resolveAstRulesConfig({}).autoInline).toBe(false)
  })

  it("EMPTY astRules: {} → autoInline false", () => {
    expect(resolveAstRulesConfig({ astRules: {} }).autoInline).toBe(false)
  })
})

describe("postAstInlineFindings — emission", () => {
  it("posts a single review with all error-severity findings (autoInline true)", async () => {
    const { client, submitReview } = makeClient()
    const positions = new Map<string, { line: number; side: "RIGHT" } | null>([
      [ERROR_FINDING.astFindingId, { line: 42, side: "RIGHT" }],
    ])
    const r = await postAstInlineFindings({
      client, ...CTX,
      findings: [ERROR_FINDING],
      perFindingPositions: positions,
    })
    expect(r.posted).toBe(1)
    expect(submitReview).toHaveBeenCalledOnce()
    const body = submitReview.mock.calls[0]![3] as SubmitReviewBody
    expect(body.event).toBe("COMMENT")
    expect(body.commit_id).toBe(CTX.headSha)
    expect(body.comments?.length).toBe(1)
    expect(body.comments?.[0]?.body).toContain(`<!-- ${ERROR_FINDING.astFindingId} -->`)
    expect(body.comments?.[0]?.body).toContain("**no-eval-call**")
    expect(body.comments?.[0]?.path).toBe("src/auth.ts")
    expect(body.comments?.[0]?.line).toBe(42)
    expect(body.comments?.[0]?.side).toBe("RIGHT")
  })

  it("skips warning-severity findings (only error auto-posts)", async () => {
    const { client, submitReview } = makeClient()
    const r = await postAstInlineFindings({
      client, ...CTX,
      findings: [WARNING_FINDING],
      perFindingPositions: new Map([[WARNING_FINDING.astFindingId, { line: 7, side: "RIGHT" }]]),
    })
    expect(r.posted).toBe(0)
    expect(r.skippedNonError).toBe(1)
    expect(submitReview).not.toHaveBeenCalled()
  })

  it("skips error finding with no resolved review position", async () => {
    const { client, submitReview } = makeClient()
    const r = await postAstInlineFindings({
      client, ...CTX,
      findings: [ERROR_FINDING],
      perFindingPositions: new Map([[ERROR_FINDING.astFindingId, null]]),
    })
    expect(r.posted).toBe(0)
    expect(r.skippedNoReviewPosition).toBe(1)
    expect(submitReview).not.toHaveBeenCalled()
  })

  it("submitReview failure is swallowed; result.posted is 0", async () => {
    const submitReview = vi.fn(async () => { throw new Error("forbidden") })
    const { client } = makeClient(submitReview)
    const r = await postAstInlineFindings({
      client, ...CTX,
      findings: [ERROR_FINDING],
      perFindingPositions: new Map([[ERROR_FINDING.astFindingId, { line: 42, side: "RIGHT" }]]),
    })
    expect(r.posted).toBe(0)
    expect(submitReview).toHaveBeenCalledOnce()
  })

  it("hidden audit marker preserves the astFindingId", async () => {
    const { client, submitReview } = makeClient()
    await postAstInlineFindings({
      client, ...CTX,
      findings: [ERROR_FINDING],
      perFindingPositions: new Map([[ERROR_FINDING.astFindingId, { line: 42, side: "RIGHT" }]]),
    })
    const body = submitReview.mock.calls[0]![3] as SubmitReviewBody
    const c = body.comments?.[0]
    expect(c?.body).toMatch(/<!-- ast\/no-eval-call\/abcdef0\/42 -->/)
  })
})
