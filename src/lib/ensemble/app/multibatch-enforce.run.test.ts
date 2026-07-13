import { describe, expect, it, vi } from "vitest"
import { ORCHESTRATOR_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { estimateTokens } from "@/src/lib/diff-packing"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import { runMultiBatchEnforce } from "./multibatch-enforce"

const diffBlock = (path: string, line: number): { path: string; body: string; charCount: number } => {
  const body = `diff --git a/${path} b/${path}
index 0000000..1111111 100644
--- a/${path}
+++ b/${path}
@@ -${line},0 +${line},1 @@
+const value${line} = ${line}
`
  return { path, body, charCount: body.length }
}

const paddedDiffBlock = (
  path: string,
  line: number,
  paddingChars: number,
): { path: string; body: string; charCount: number } => {
  const padding = "x".repeat(paddingChars)
  const body = `diff --git a/${path} b/${path}
index 0000000..1111111 100644
--- a/${path}
+++ b/${path}
@@ -${line},0 +${line},1 @@
+const value${line} = "${padding}"
`
  return { path, body, charCount: body.length }
}

const verdictWithFinding = (path: string, line: number): PrReviewVerdict => ({
  summary: "found issue",
  confidence: 4,
  confidenceReason: "test fixture",
  findings: [
    {
      path,
      line,
      score: 4,
      category: "logic",
      headline: "batch one bug",
      body: "Concrete issue body.",
    },
  ],
})

describe("runMultiBatchEnforce", () => {
  it("launches spillover before synth and returns namespaced source findings", async () => {
    const recordTokens = vi.fn()
    const runRole = vi.fn(async () => verdictWithFinding("src/b.ts", 20))

    const result = await runMultiBatchEnforce({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 418,
      headSha: "deadbeefdeadbeef",
      perfCtx: { owner: "Sigilix", repo: "sigilix", prNumber: 418, headSha: "deadbeefdeadbeef", recordTokens },
      orchCtrl: new AbortController(),
      startMs: Date.now(),
      spilloverBatches: [[diffBlock("src/b.ts", 20)]],
      roles: ["logic"],
      currentSourceJsonChars: 0,
      maxSynthInputChars: 100_000,
      maxReviewContextTokens: 10_000_000,
      priorInputTokensEst: 0,
      runRole,
    })

    expect(result.batchesLaunched).toBe(1)
    expect(result.haltReason).toBeNull()
    expect(result.launchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/b.ts"]])
    expect(result.collected).toHaveLength(1)
    expect(result.collected[0]?.verdict?.findings[0]?.id).toBe("logic-b1-0")
    expect(runRole).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "logic",
        batchIdx: 1,
        batchDiff: expect.stringContaining("diff --git a/src/b.ts b/src/b.ts"),
        perfCtx: expect.objectContaining({ recordTokens }),
      }),
    )
  })

  it("halts before launching when the pre-synth budget is already spent", async () => {
    const runRole = vi.fn(async () => verdictWithFinding("src/b.ts", 20))

    const result = await runMultiBatchEnforce({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 418,
      headSha: "deadbeefdeadbeef",
      perfCtx: { owner: "Sigilix", repo: "sigilix", prNumber: 418, headSha: "deadbeefdeadbeef" },
      orchCtrl: new AbortController(),
      startMs: Date.now() - ORCHESTRATOR_TIMEOUT_MS,
      spilloverBatches: [[diffBlock("src/b.ts", 20)]],
      roles: ["logic"],
      currentSourceJsonChars: 0,
      maxSynthInputChars: 100_000,
      maxReviewContextTokens: 10_000_000,
      priorInputTokensEst: 0,
      runRole,
    })

    expect(result.batchesLaunched).toBe(0)
    expect(result.haltedEarly).toBe(true)
    expect(result.haltReason).toBe("deadline")
    expect(result.unlaunchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/b.ts"]])
    expect(runRole).not.toHaveBeenCalled()
  })

  it("counts launched batch diff chars toward the synth-input cap before considering the next batch", async () => {
    const first = paddedDiffBlock("src/b.ts", 20, 1_000)
    const second = paddedDiffBlock("src/c.ts", 30, 1_000)
    const runRole = vi.fn(async () => ({
      summary: "no findings",
      confidence: 5,
      confidenceReason: "test fixture",
      findings: [],
    }))

    const result = await runMultiBatchEnforce({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 418,
      headSha: "deadbeefdeadbeef",
      perfCtx: { owner: "Sigilix", repo: "sigilix", prNumber: 418, headSha: "deadbeefdeadbeef" },
      orchCtrl: new AbortController(),
      startMs: Date.now(),
      spilloverBatches: [[first], [second]],
      roles: ["logic"],
      currentSourceJsonChars: 0,
      maxSynthInputChars: first.charCount + Math.floor(second.charCount / 2),
      maxReviewContextTokens: 10_000_000,
      priorInputTokensEst: 0,
      runRole,
    })

    expect(result.batchesLaunched).toBe(1)
    expect(result.haltedEarly).toBe(true)
    expect(result.haltReason).toBe("synth-input-cap")
    expect(result.launchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/b.ts"]])
    expect(result.unlaunchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/c.ts"]])
    expect(runRole).toHaveBeenCalledTimes(1)
  })

  it("halts spillover on the giant-PR total-context ceiling before launching the batch that would cross it", async () => {
    const first = paddedDiffBlock("src/b.ts", 20, 1_000)
    const second = paddedDiffBlock("src/c.ts", 30, 1_000)
    const runRole = vi.fn(async () => ({
      summary: "no findings",
      confidence: 5,
      confidenceReason: "test fixture",
      findings: [],
    }))

    // Roomy synth-input cap + deadline so ONLY the token ceiling can halt. The prior
    // spend plus batch-1's per-role diff estimate sits under the ceiling; adding
    // batch-2 crosses it, so the loop launches batch 1 and stops before batch 2.
    const perBatchTokensEst = estimateTokens(first.body) // roles.length === 1
    const result = await runMultiBatchEnforce({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 418,
      headSha: "deadbeefdeadbeef",
      perfCtx: { owner: "Sigilix", repo: "sigilix", prNumber: 418, headSha: "deadbeefdeadbeef" },
      orchCtrl: new AbortController(),
      startMs: Date.now(),
      spilloverBatches: [[first], [second]],
      roles: ["logic"],
      currentSourceJsonChars: 0,
      maxSynthInputChars: 10_000_000,
      priorInputTokensEst: 100_000,
      maxReviewContextTokens: 100_000 + perBatchTokensEst + Math.floor(perBatchTokensEst / 2),
      runRole,
    })

    expect(result.batchesLaunched).toBe(1)
    expect(result.haltedEarly).toBe(true)
    expect(result.haltReason).toBe("context-token-cap")
    expect(result.launchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/b.ts"]])
    expect(result.unlaunchedBatches.map((batch) => batch.map((file) => file.path))).toEqual([["src/c.ts"]])
    expect(runRole).toHaveBeenCalledTimes(1)
  })
})
