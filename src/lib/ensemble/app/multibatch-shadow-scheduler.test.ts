// SIG-418 Phase 2 (Design B′) — the multi-batch SHADOW scheduler tests.
// Pins the detachment contract (mirrors the resweep-scheduler guarantee):
//   - off / on → no-op (zero shadow model calls; `on` is handled by enforce);
//   - shadow → detached run via setTimeout + backgroundWaitUntil; the background
//     promise NEVER rejects (a thrown run resolves after logging), so a shadow
//     failure can't convert a posted review into a queue failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  scheduleMultiBatchShadow,
  maybeScheduleMultiBatchShadow,
} from "@/src/lib/ensemble/app/multibatch-shadow-scheduler"
import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import type { DiffFileBlock } from "@/src/lib/diff-packing"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { Env } from "@/src/shared/types/env"
import type {
  ScheduleMultiBatchShadowArgs,
  MaybeScheduleMultiBatchShadowArgs,
} from "@/src/lib/ensemble/app/multibatch-shadow-scheduler"

vi.mock("@/src/lib/ensemble/adapters/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/adapters/model-provider")>()
  return { ...actual, runSpecialist: vi.fn() }
})

const mockedRunSpecialist = vi.mocked(runSpecialist)
const ENV = { OLLAMA_API_KEY: "test-key", OLLAMA_CHAT_ENABLE: "on" } as unknown as Env
const ROLES: SpecialistRole[] = ["logic"]

function block(path: string): DiffFileBlock {
  const body = `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+x()`
  return { path, body, charCount: body.length }
}

function args(
  mode: "off" | "shadow" | "on",
  over: Partial<ScheduleMultiBatchShadowArgs> = {},
): ScheduleMultiBatchShadowArgs {
  return {
    mode,
    env: ENV,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
    orchCtrl: new AbortController(),
    startMs: Date.now(),
    spilloverBatches: [[block("server/spill1.ts")]],
    roles: ROLES,
    singleBatchFindingCount: 0,
    singleBatchFiles: ["server/reviewed.ts"],
    prGlobalSummary: "[WHOLE-PR CONTEXT]",
    buildBatchMessage: (role, batchDiff, summary) => `${role}\n${summary}\n${batchDiff}`,
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  mockedRunSpecialist.mockReset()
  mockedRunSpecialist.mockResolvedValue({
    verdict: { findings: [] } as unknown as PrReviewVerdict,
    elapsedMs: 5,
    modelUsed: "m",
    attemptsUsed: 1,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("scheduleMultiBatchShadow — detachment contract", () => {
  it("off → no-op (no run scheduled, zero model calls)", async () => {
    const s = scheduleMultiBatchShadow(args("off"))
    expect(s.kind).toBe("noop")
    await new Promise((r) => setTimeout(r, 0))
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
  })

  it("on → no-op in the shadow scheduler (enforce owns output union)", async () => {
    const s = scheduleMultiBatchShadow(args("on"))
    expect(s.kind).toBe("noop")
    await new Promise((r) => setTimeout(r, 0))
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
  })

  it("shadow → detached run; backgroundWaitUntil receives a never-rejecting promise", async () => {
    const registered: Array<Promise<void>> = []
    const s = scheduleMultiBatchShadow(args("shadow", { backgroundWaitUntil: (p) => registered.push(p) }))
    expect(s.kind).toBe("shadow-scheduled")
    expect(registered).toHaveLength(1)
    // The background work resolves (never rejects) and the run actually fired.
    await expect(registered[0]).resolves.toBeUndefined()
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(ROLES.length) // 1 spillover batch × 1 role
  })

  it("shadow → a THROWING run still resolves the background promise (no queue failure)", async () => {
    mockedRunSpecialist.mockRejectedValue(new Error("boom"))
    const registered: Array<Promise<void>> = []
    const s = scheduleMultiBatchShadow(args("shadow", { backgroundWaitUntil: (p) => registered.push(p) }))
    expect(s.kind).toBe("shadow-scheduled")
    // Even though every model call rejects, the phase is no-throw + the scheduler
    // never rejects through waitUntil — the background promise resolves cleanly.
    await expect(registered[0]).resolves.toBeUndefined()
  })

  it("shadow → a throwing backgroundWaitUntil registration is swallowed (still scheduled)", async () => {
    const s = scheduleMultiBatchShadow(
      args("shadow", {
        backgroundWaitUntil: () => {
          throw new Error("registration boom")
        },
      }),
    )
    // Registration failure is logged, never thrown — the run is still scheduled.
    expect(s.kind).toBe("shadow-scheduled")
    if (s.kind === "shadow-scheduled") await s.shadowWork
  })
})

// The orchestrator entry point — owns the mode decision, the whole-PR summary
// build, and the per-batch message builder. Driven
// directly (the orchestrator-boundary test can't reach the post-synth call site).
describe("maybeScheduleMultiBatchShadow — orchestrator entry point", () => {
  function vWithFindings(n: number): { verdict: PrReviewVerdictWithIds } {
    const findings = Array.from({ length: n }, (_, i) => ({
      path: "server/reviewed.ts",
      line: i + 1,
      score: 4,
      category: "logic",
      headline: `f${i}`,
      body: "",
      id: `logic-${i}`,
    })) as Array<PrReviewFinding & { id: string }>
    return { verdict: { findings } as unknown as PrReviewVerdictWithIds }
  }

  // A client whose head matches the queued SHA → checkHeadFresh() resolves true.
  function freshClient(headSha = "a".repeat(40)): MaybeScheduleMultiBatchShadowArgs["client"] {
    return { getPullRequest: async () => ({ head: { sha: headSha } }) as never }
  }

  function maybeArgs(
    mode: "off" | "shadow" | "on",
    over: Partial<MaybeScheduleMultiBatchShadowArgs> = {},
  ): MaybeScheduleMultiBatchShadowArgs {
    return {
      mode,
      identity: { env: ENV, owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
      perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
      orchCtrl: new AbortController(),
      startMs: Date.now(),
      spilloverBatches: [[block("server/spill1.ts")]],
      roles: ROLES,
      synthInputVerdicts: [vWithFindings(2)],
      filePaths: ["server/reviewed.ts"],
      filesNotReviewed: ["server/spill1.ts"],
      graphBlastCallerPaths: [],
      graphBlastDependentPaths: [],
      meta: { title: "t", body: "b" },
      namespace: "ns",
      stackBlock: "",
      graphCtxForPrompt: "",
      client: freshClient(),
      ...over,
    }
  }

  function loggedEvents(): Array<Record<string, unknown>> {
    const calls = vi.mocked(console.log).mock.calls
    return calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .filter((e) => typeof e["event"] === "string")
  }

  it("off → no-op, no log, no run", () => {
    const s = maybeScheduleMultiBatchShadow(maybeArgs("off"))
    expect(s.kind).toBe("noop")
    expect(loggedEvents().some((e) => String(e["event"]).startsWith("multibatch-"))).toBe(false)
  })

  it("on → no-op here with no unsupported log because enforce owns the mode", () => {
    const s = maybeScheduleMultiBatchShadow(maybeArgs("on"))
    expect(s.kind).toBe("noop")
    expect(loggedEvents().find((e) => e["event"] === "multibatch-mode-unsupported")).toBeUndefined()
  })

  it("shadow with empty spillover → no-op", () => {
    const s = maybeScheduleMultiBatchShadow(maybeArgs("shadow", { spilloverBatches: [] }))
    expect(s.kind).toBe("noop")
  })

  it("shadow with spillover → scheduled; the per-batch message carries the FULL changed set (reviewed ∪ spillover)", async () => {
    // Capture the message the spillover specialist actually receives so we can
    // assert the whole-PR summary lists the SPILLOVER file (the bug guard: it must
    // not list only the reviewed batch-0 files).
    let capturedMessage = ""
    mockedRunSpecialist.mockImplementation(async (callArgs) => {
      capturedMessage = callArgs.initialMessage
      return { verdict: { findings: [] } as unknown as PrReviewVerdict, elapsedMs: 5, modelUsed: "m", attemptsUsed: 1 }
    })
    const registered: Array<Promise<void>> = []
    const s = maybeScheduleMultiBatchShadow(
      maybeArgs("shadow", {
        filePaths: ["server/reviewed.ts"],
        filesNotReviewed: ["server/spill1.ts"],
        identity: {
          env: ENV,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "a".repeat(40),
          backgroundWaitUntil: (p) => registered.push(p),
        },
      }),
    )
    expect(s.kind).toBe("shadow-scheduled")
    await registered[0]
    // The whole-PR summary in the spillover specialist's prompt lists BOTH the
    // reviewed file AND the spillover file — not just batch-0's.
    expect(capturedMessage).toContain("server/reviewed.ts")
    expect(capturedMessage).toContain("server/spill1.ts")
  })

  it("shadow + head MOVED before the detached run → zero model calls (stale-head abort)", async () => {
    // The detached shadow re-checks the head via the client; a moved head bails
    // the whole pass with no spillover model calls (Codex review: the shadow must
    // never spend on a superseded SHA after guard #2).
    const registered: Array<Promise<void>> = []
    const s = maybeScheduleMultiBatchShadow(
      maybeArgs("shadow", {
        // client reports a DIFFERENT head than the queued one → not fresh.
        client: { getPullRequest: async () => ({ head: { sha: "b".repeat(40) } }) as never },
        identity: {
          env: ENV,
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "a".repeat(40),
          backgroundWaitUntil: (p) => registered.push(p),
        },
      }),
    )
    expect(s.kind).toBe("shadow-scheduled")
    await registered[0]
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    const ev = loggedEvents().find((e) => e["event"] === "multibatch-shadow-stale-head-abort")
    expect(ev).toBeDefined()
  })
})
