// SIG-395 — invariant-lens phase wiring tests (mocked model). Pins the
// mode contract (off = settled no-op handle with zero calls; shadow runs +
// telemeters but NEVER merges; on merges into the LOGIC verdict with
// pass-1 stable ids preserved), the anchored-to-diff guard, and the
// logic-failed merge-target fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyInvariantLens, startInvariantLens } from "@/src/lib/ensemble/app/invariant-lens"
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
const ENV = { OLLAMA_API_KEY: "k", OLLAMA_CHAT_ENABLE: "on" } as unknown as Env

// Breadth + several family preconditions (units, scoping, error, crypto).
const DIFF = [
  "diff --git a/server/payments.ts b/server/payments.ts",
  "+++ b/server/payments.ts",
  "@@ -0,0 +1,3 @@",
  "+const amountCents = 1",
  '+payments.get("/x", h) // customer_id',
  "+res.status(404); createHmac()",
  "diff --git a/server/refunds.ts b/server/refunds.ts",
  "+++ b/server/refunds.ts",
  "@@ -0,0 +1,1 @@",
  "+refund()",
].join("\n")

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "server/payments.ts",
    line: 2,
    score: 4,
    category: "logic",
    headline: "lens catch",
    body: "…",
    ...over,
  } as PrReviewFinding
}

function verdictOf(role: CollectedVerdict["role"], findings: PrReviewFinding[]): CollectedVerdict {
  return { role, verdict: assignStableFindingIds(role, { findings } as unknown as PrReviewVerdict), elapsedMs: 1 }
}

const SUCCEEDED: CollectedVerdict[] = [
  verdictOf("logic", [finding({ headline: "pass-1" })]),
  verdictOf("security", [finding({ path: "server/refunds.ts", category: "security" })]),
]

function start(mode: "off" | "shadow" | "on") {
  return startInvariantLens({
    env: ENV,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    mode,
    perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) },
    orchCtrl: new AbortController(),
    diff: DIFF,
    userMessage: "msg",
  })
}

async function apply(lens: ReturnType<typeof start>, succeeded = SUCCEEDED) {
  return applyInvariantLens({
    lens,
    succeeded,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    diff: DIFF,
  })
}

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  mockedRunSpecialist.mockReset()
})
afterEach(() => logSpy.mockRestore())

const loggedEvents = () => logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))

describe("invariant lens — mode contract", () => {
  it("off: settled no-op handle, zero calls, zero telemetry, passthrough by reference", async () => {
    const lens = start("off")
    const r = await apply(lens)
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(loggedEvents()).toHaveLength(0)
    expect(r.verdicts).toBe(SUCCEEDED)
  })

  it("shadow: dispatched families run + decision/summary telemetry, but NEVER merges", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding()] } as unknown as PrReviewVerdict,
      elapsedMs: 5,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const lens = start("shadow")
    expect(lens.dispatched.length).toBeGreaterThanOrEqual(3)
    const r = await apply(lens)
    const events = loggedEvents()
    expect(events[0]).toMatchObject({ event: "invariant-lens-decision", fired: true })
    expect(events.find((e) => e["event"] === "invariant-lens-shadow-summary")).toMatchObject({
      executionLane: "default",
      recallContract: "blocking",
      mergedIntoSynth: false,
      highSeverityCandidates: lens.dispatched.length,
      highSeverityKeptCandidates: lens.dispatched.length,
    })
    expect(r.verdicts).toBe(SUCCEEDED)
    expect(r.lensFindingIds).toEqual([])
  })

  it("on: kept candidates merge into the LOGIC verdict; pass-1 ids stable; additions tracked", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding()] } as unknown as PrReviewVerdict,
      elapsedMs: 5,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const lens = start("on")
    const r = await apply(lens)
    const logicVerdict = r.verdicts.find((v) => v.role === "logic")!.verdict!
    expect(logicVerdict.findings[0]!.id).toBe("logic-0")
    expect(logicVerdict.findings.length).toBe(1 + lens.dispatched.length)
    expect(r.lensFindingIds).toEqual(Array.from({ length: lens.dispatched.length }, (_, i) => `logic-${i + 1}`))
    // Non-target verdicts untouched by reference.
    expect(r.verdicts.find((v) => v.role === "security")).toBe(SUCCEEDED[1])
    expect(loggedEvents().find((e) => e["event"] === "invariant-lens-summary")).toMatchObject({
      executionLane: "default",
      recallContract: "blocking",
      mergedIntoSynth: true,
      highSeverityCandidates: lens.dispatched.length,
      highSeverityKeptCandidates: lens.dispatched.length,
    })
  })

  it("anchored-to-diff guard: candidates outside the changed files are dropped, not merged", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding({ path: "src/not-in-diff.ts" })] } as unknown as PrReviewVerdict,
      elapsedMs: 5,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const lens = start("on")
    const r = await apply(lens)
    expect(r.verdicts).toBe(SUCCEEDED)
    const summary = loggedEvents().find((e) => e["event"] === "invariant-lens-summary")
    expect(summary).toMatchObject({ keptCandidates: 0 })
    expect(summary!["outOfDiffDropped"]).toBeGreaterThan(0)
  })

  it("logic-failed fallback: merges into the first succeeded role instead", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: { findings: [finding({ path: "server/refunds.ts" })] } as unknown as PrReviewVerdict,
      elapsedMs: 5,
      modelUsed: "m",
      attemptsUsed: 1,
    })
    const onlySecurity: CollectedVerdict[] = [verdictOf("security", [finding({ path: "server/refunds.ts" })])]
    const lens = start("on")
    const r = await apply(lens, onlySecurity)
    const sec = r.verdicts.find((v) => v.role === "security")!.verdict!
    expect(sec.findings.length).toBeGreaterThan(1)
    expect(sec.findings[0]!.id).toBe("security-0")
  })

  it("an errored family contributes nothing and is counted per family", async () => {
    mockedRunSpecialist.mockResolvedValue({
      verdict: null,
      failureReason: "parse_fail",
      elapsedMs: 1,
      modelUsed: "m",
      attemptsUsed: 2,
    })
    const lens = start("on")
    const r = await apply(lens)
    expect(r.verdicts).toBe(SUCCEEDED)
    const summary = loggedEvents().find((e) => e["event"] === "invariant-lens-summary")
    const perFamily = summary!["perFamily"] as Array<{ errored: boolean }>
    expect(perFamily.every((f) => f.errored)).toBe(true)
  })
})
