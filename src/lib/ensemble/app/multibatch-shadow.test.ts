// SIG-418 Phase 2 (Design B′) — the in-invocation multi-batch SHADOW phase tests
// (mocked model). Pins the PR-2 contract:
//   - shadow over a multi-batch fixture: every spillover batch runs, telemetry is
//     emitted, the result is TELEMETRY-ONLY (no value the posted path consumes),
//     and batch 0 is NEVER re-run (the loop only touches spillover batches);
//   - the synth-budgeted guard halts batch launches when the synth tail wouldn't
//     fit — driven to its boundary via the real budget constants + a stale startMs;
//   - per-batch finding ids are role-FIRST and unique, starting at batch index 1
//     (`logic-b1-0`), so the batch-0 baseline ids (`logic-0`) never collide.
//
// Mirrors resweep.test.ts: `runSpecialist` is mocked at the model-provider boundary
// and the phase is driven directly with a constructed `spilloverBatches` array (no
// giant diff needed — the orchestrator hands the batches in).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMultiBatchShadow, type MultiBatchShadowArgs } from "@/src/lib/ensemble/app/multibatch-shadow"
import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { namespaceFindingId } from "@/src/lib/ensemble/domain/multibatch-finding-id"
import { ORCHESTRATOR_TIMEOUT_MS, RESERVED_HEADROOM_MS } from "@/src/lib/ensemble/domain/budget"
import type { DiffFileBlock } from "@/src/lib/diff-packing"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { Env } from "@/src/shared/types/env"

vi.mock("@/src/lib/ensemble/adapters/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/adapters/model-provider")>()
  return { ...actual, runSpecialist: vi.fn() }
})

const mockedRunSpecialist = vi.mocked(runSpecialist)

const ENV = { OLLAMA_API_KEY: "test-key", OLLAMA_CHAT_ENABLE: "on" } as unknown as Env

function block(path: string): DiffFileBlock {
  const body = `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+x()`
  return { path, body, charCount: body.length }
}

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "server/spill.ts",
    line: 1,
    score: 4,
    category: "logic",
    headline: "spillover finding",
    body: "…",
    ...over,
  } as PrReviewFinding
}

const ROLES: SpecialistRole[] = ["logic", "security"]

function args(over: Partial<MultiBatchShadowArgs> = {}): MultiBatchShadowArgs {
  return {
    env: ENV,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
    orchCtrl: new AbortController(),
    // Fresh origin → the whole pre-synth window is available, so the guard launches.
    startMs: Date.now(),
    spilloverBatches: [[block("server/spill1.ts")], [block("server/spill2.ts")]],
    roles: ROLES,
    singleBatchFindingCount: 3,
    singleBatchFiles: ["server/reviewed.ts"],
    prGlobalSummary: "[WHOLE-PR CONTEXT] Changed files (3): a.ts, b.ts, server/reviewed.ts",
    buildBatchMessage: (role, batchDiff, summary) => `${role}\n${summary}\n${batchDiff}`,
    ...over,
  }
}

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  mockedRunSpecialist.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
}

describe("runMultiBatchShadow — PR 2 shadow contract", () => {
  it("no spillover → no model calls, no summary, baseline-only would-be union", async () => {
    const r = await runMultiBatchShadow(args({ spilloverBatches: [] }))
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(loggedEvents()).toHaveLength(0)
    expect(r.batchesLaunched).toBe(0)
    expect(r.wouldBeUnionSize).toBe(3) // singleBatchFindingCount, untouched
  })

  it("shadow over 2 spillover batches: every batch runs, summary emitted, telemetry-only", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding()] } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const r = await runMultiBatchShadow(args())
    // 2 spillover batches × 2 roles = 4 calls. Batch 0 is NOT among them — the
    // loop only ever touches the spillover batches handed in.
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(4)
    expect(r.batchesLaunched).toBe(2)
    expect(r.haltedEarly).toBe(false)
    const summary = loggedEvents().find((e) => e["event"] === "multibatch-summary")
    expect(summary).toMatchObject({
      mode: "shadow",
      spilloverBatchesAvailable: 2,
      batchesLaunched: 2,
      haltedEarly: false,
      singleBatchFindingCount: 3,
    })
    // would-be union = baseline 3 + 4 spillover findings (1 per call × 4 calls).
    expect(r.wouldBeUnionSize).toBe(7)
    // The result is telemetry-only: no verdict / finding array the posted path consumes.
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining([
        "spilloverBatchesAvailable",
        "batchesLaunched",
        "haltedEarly",
        "haltedAtBatch",
        "wouldBeUnionSize",
        "erroredBatches",
      ]),
    )
    expect(r).not.toHaveProperty("verdicts")
    expect(r).not.toHaveProperty("findings")
  })

  it("budget guard HALTS launches when the post-synth tail wouldn't fit (boundary)", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding()] } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    // POST-synth reserve = RESERVED_HEADROOM_MS only (synth already ran). Put the
    // orchestrator origin so `now` is PAST the post-synth deadline:
    // startMs = now - (ORCH - RESERVED_HEADROOM) - 1ms → remaining < 0 →
    // canLaunchNextBatch false on the FIRST spillover batch → halt immediately.
    const staleStartMs = Date.now() - (ORCHESTRATOR_TIMEOUT_MS - RESERVED_HEADROOM_MS) - 1
    const r = await runMultiBatchShadow(args({ startMs: staleStartMs }))
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(r.batchesLaunched).toBe(0)
    expect(r.haltedEarly).toBe(true)
    expect(r.haltedAtBatch).toBe(0)
    const decision = loggedEvents().find((e) => e["event"] === "multibatch-decision")
    expect(decision).toMatchObject({ canLaunchNextBatch: false, batchIdx: 1 })
    const summary = loggedEvents().find((e) => e["event"] === "multibatch-summary")
    expect(summary).toMatchObject({ haltedEarly: true, batchesLaunched: 0 })
  })

  it("budget guard LAUNCHES at a REALISTIC post-synth elapsed (the synth budget is not double-reserved)", async () => {
    // The bug the post-synth variant fixes: the pre-synth guard reserves
    // SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS = 520s, so a post-synth call
    // (elapsed ~600s after specialists+synth ran) ALWAYS halts → measures nothing.
    // With synth already spent, a review that finished in ~600s still has window:
    // deadline = startMs + ORCH(895s) - RESERVED_HEADROOM(195s) = startMs + 700s,
    // so at elapsed 600s there is ~100s left ≥ minUseful(60s) → it launches.
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding()] } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const realisticStartMs = Date.now() - 600_000
    const r = await runMultiBatchShadow(
      args({ startMs: realisticStartMs, spilloverBatches: [[block("server/spill1.ts")]] }),
    )
    // The whole point: at a realistic post-synth elapsed, the shadow ACTUALLY runs.
    expect(r.batchesLaunched).toBe(1)
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(ROLES.length)
    const decision = loggedEvents().find((e) => e["event"] === "multibatch-decision")
    expect(decision).toMatchObject({ canLaunchNextBatch: true })
  })

  it("per-batch finding ids are role-FIRST + unique, starting at batch index 1", async () => {
    // The namespaced ids the loop sizes the union with: assert the helper the
    // module uses produces role-first, batch-1+, collision-free ids vs batch 0.
    const id0 = "logic-0" // batch-0 baseline id (assignStableFindingIds, untouched)
    const idB1 = namespaceFindingId("logic", 1, 0) // first spillover batch
    const idB2 = namespaceFindingId("logic", 2, 0) // second spillover batch
    expect(idB1).toBe("logic-b1-0")
    expect(idB2).toBe("logic-b2-0")
    // role-FIRST → existing prefix role inference (`id.startsWith("logic-")`) holds.
    expect(idB1.startsWith("logic-")).toBe(true)
    // No collision across batches or with the batch-0 baseline.
    expect(new Set([id0, idB1, idB2]).size).toBe(3)
  })

  it("an errored batch call contributes nothing and is counted (never throws)", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: null,
      failureReason: "parse_fail",
      elapsedMs: 10,
      modelUsed: "m",
      attemptsUsed: 2,
    })
    const r = await runMultiBatchShadow(args())
    // Both batches launch (the guard is fine), every call errors → zero findings.
    expect(r.batchesLaunched).toBe(2)
    expect(r.erroredBatches).toBe(2)
    expect(r.wouldBeUnionSize).toBe(3) // baseline only; no spillover findings added
  })
})
