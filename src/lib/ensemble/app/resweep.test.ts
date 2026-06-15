// SIG-393 — re-sweep phase wiring tests (mocked model). Pins the mode
// contract: off = inert (zero model calls), shadow = runs + telemeters but
// NEVER merges (zero posted-output change — the rollout guarantee), on =
// merges with pass-1 stable ids preserved + additions tracked, and the
// region-scope guard drops findings anchored outside the region the call
// actually saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runResweepPhase } from "@/src/lib/ensemble/app/resweep"
import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { Env } from "@/src/shared/types/env"

vi.mock("@/src/lib/ensemble/adapters/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/adapters/model-provider")>()
  return { ...actual, runSpecialist: vi.fn() }
})

const mockedRunSpecialist = vi.mocked(runSpecialist)

const ENV = { OLLAMA_API_KEY: "test-key", OLLAMA_CHAT_ENABLE: "on" } as unknown as Env

// The dense shape: payments (clustered, high-risk) + refunds — fires the gate.
const DIFF = [
  "diff --git a/server/payments.ts b/server/payments.ts",
  "+++ b/server/payments.ts",
  "@@ -0,0 +1,3 @@",
  "+pay()",
  "+pay2()",
  "+pay3()",
  "diff --git a/server/refunds.ts b/server/refunds.ts",
  "+++ b/server/refunds.ts",
  "@@ -0,0 +1,2 @@",
  "+refund()",
  "+refund2()",
].join("\n")

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "server/payments.ts",
    line: 1,
    score: 4,
    category: "logic",
    headline: "pass-1 finding",
    body: "…",
    ...over,
  } as PrReviewFinding
}

function verdictOf(role: CollectedVerdict["role"], findings: PrReviewFinding[]): CollectedVerdict {
  return {
    role,
    verdict: assignStableFindingIds(role, { findings } as unknown as PrReviewVerdict),
    elapsedMs: 100,
  }
}

function args(mode: "off" | "shadow" | "on", succeeded: CollectedVerdict[]) {
  return {
    env: ENV,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    mode,
    maxRegions: 6,
    perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
    orchCtrl: new AbortController(),
    diff: DIFF,
    succeeded,
  } as const
}

// Gate-firing pass-1 shape: 2 findings in payments + 1 in refunds.
const SUCCEEDED: CollectedVerdict[] = [
  verdictOf("logic", [finding({ line: 1 }), finding({ line: 2 })]),
  verdictOf("security", [finding({ path: "server/refunds.ts", category: "security" })]),
]

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  mockedRunSpecialist.mockReset()
})

afterEach(() => {
  logSpy.mockRestore()
})

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
}

describe("runResweepPhase — mode contract", () => {
  it("off: inert — zero model calls, zero telemetry, verdicts passed through by reference", async () => {
    const r = await runResweepPhase(args("off", SUCCEEDED))
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(loggedEvents()).toHaveLength(0)
    expect(r.verdicts).toBe(SUCCEEDED)
    expect(r.resweepFindingIds).toEqual([])
  })

  it("shadow: runs the fan-out + emits gate-decision and shadow-summary, but NEVER merges", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding({ line: 3, headline: "resweep catch" })] } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const r = await runResweepPhase(args("shadow", SUCCEEDED))
    // regions(2) × succeeded roles(2)
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(4)
    const events = loggedEvents()
    expect(events[0]).toMatchObject({ event: "resweep-gate-decision", fired: true, mode: "shadow" })
    const summary = events.find((e) => e["event"] === "resweep-shadow-summary")
    expect(summary).toMatchObject({ extraCalls: 4, erroredCalls: 0 })
    // The rollout guarantee: shadow changes NOTHING downstream.
    expect(r.verdicts).toBe(SUCCEEDED)
    expect(r.resweepFindingIds).toEqual([])
  })

  it("on: merges kept candidates per role; pass-1 ids stay stable; additions tracked", async () => {
    mockedRunSpecialist.mockImplementation(async (callArgs) => ({
      verdict: {
        findings:
          callArgs.role === "logic"
            ? [finding({ path: extractRegion(callArgs.initialMessage), line: 9, headline: "resweep catch" })]
            : [],
      } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    }))
    const r = await runResweepPhase(args("on", SUCCEEDED))
    const logicVerdict = r.verdicts.find((v) => v.role === "logic")!.verdict!
    // pass-1 ids unchanged (positional), additions take the next indices.
    expect(logicVerdict.findings[0]!.id).toBe("logic-0")
    expect(logicVerdict.findings[1]!.id).toBe("logic-1")
    expect(logicVerdict.findings.length).toBe(2 + 2) // one kept catch per region
    expect(r.resweepFindingIds).toEqual(["logic-2", "logic-3"])
    // Security had no resweep findings → untouched entry.
    expect(r.verdicts.find((v) => v.role === "security")).toBe(SUCCEEDED[1])
    const summary = loggedEvents().find((e) => e["event"] === "resweep-summary")
    expect(summary).toMatchObject({ keptCandidates: 2 })
  })

  it("region-scope guard: a finding anchored outside the region's file is dropped, not merged", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: {
        findings: [finding({ path: "server/somewhere-else.ts", line: 1, headline: "out of region" })],
      } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const r = await runResweepPhase(args("on", SUCCEEDED))
    expect(r.verdicts).toBe(SUCCEEDED)
    const summary = loggedEvents().find((e) => e["event"] === "resweep-summary")
    expect(summary).toMatchObject({ outOfRegionDropped: 4, keptCandidates: 0 })
  })

  it("gate not fired (single small low-risk region): no model calls, decision telemetry only", async () => {
    const single = [verdictOf("logic", [finding({ path: "src/render.ts" })])]
    const diff = ["diff --git a/src/render.ts b/src/render.ts", "+++ b/src/render.ts", "@@ -0,0 +1,1 @@", "+x()"].join(
      "\n",
    )
    const r = await runResweepPhase({ ...args("on", single), diff })
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(loggedEvents()[0]).toMatchObject({ event: "resweep-gate-decision", fired: false })
    expect(r.verdicts).toBe(single)
  })

  it("an errored re-sweep call contributes nothing and is counted", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: null,
      failureReason: "parse_fail",
      elapsedMs: 10,
      modelUsed: "m",
      attemptsUsed: 2,
    })
    const r = await runResweepPhase(args("on", SUCCEEDED))
    expect(r.verdicts).toBe(SUCCEEDED)
    const summary = loggedEvents().find((e) => e["event"] === "resweep-summary")
    expect(summary).toMatchObject({ erroredCalls: 4, candidates: 0 })
  })
})

// SIG-369(b): the re-sweep honors the default-off second-pass model override,
// applied to the LOGIC role ONLY. Off (default) → no override anywhere
// (byte-identical o3 path); on → only the logic-role calls carry the v4-pro
// override, security/perf/tests keep their own configs (no modelOverride).
describe("runResweepPhase — SIG-369(b) second-pass reasoner override", () => {
  beforeEach(() => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [] } as unknown as PrReviewVerdict,
      elapsedMs: 50,
      modelUsed: "m",
      attemptsUsed: 1,
    })
  })

  it("flag unset (default off): NO call carries modelOverride — byte-identical o3 path", async () => {
    await runResweepPhase(args("on", SUCCEEDED))
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(4)
    for (const call of mockedRunSpecialist.mock.calls) {
      expect(call[0]).not.toHaveProperty("modelOverride")
    }
  })

  it('flag "on": ONLY the logic-role calls get the v4-pro override; other roles untouched', async () => {
    const env = { ...ENV, OPENCLAW_SECONDPASS_REASONER_MODE: "on" } as unknown as Env
    await runResweepPhase({ ...args("on", SUCCEEDED), env })
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(4)
    const byRole = new Map<string, Array<(typeof mockedRunSpecialist.mock.calls)[number][0]>>()
    for (const call of mockedRunSpecialist.mock.calls) {
      const list = byRole.get(call[0].role) ?? []
      list.push(call[0])
      byRole.set(call[0].role, list)
    }
    // regions(2) × {logic, security}: 2 logic calls (overridden), 2 security (not).
    expect(byRole.get("logic")!.length).toBe(2)
    for (const c of byRole.get("logic")!) {
      expect(c.modelOverride?.primary).toBe("deepseek/deepseek-v4-pro")
    }
    expect(byRole.get("security")!.length).toBe(2)
    for (const c of byRole.get("security")!) {
      expect(c).not.toHaveProperty("modelOverride")
    }
  })
})

/** Pull the region path back out of the prompt (the focused-re-review title). */
function extractRegion(initialMessage: string): string {
  const m = /Focused re-review: (\S+)/.exec(initialMessage)
  return m?.[1] ?? "unknown"
}
