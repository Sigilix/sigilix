// SIG-487 — security K-union phase wiring tests (mocked model). Pins the mode
// contract (off / security-not-dispatched = settled no-op handle with zero calls;
// shadow runs + telemeters but NEVER merges; on unions the 2nd pass into the
// SECURITY verdict with pass-1 stable ids preserved), the full-strength
// recall-suffixed 2nd-pass prompt + reasoning parity, and the degrade-to-pass-1 contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  startSecurityKUnion,
  applySecurityKUnion,
  type SecurityKUnionContext,
} from "@/src/lib/ensemble/app/security-kunion"
import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { specialistSystemPrompt, SECURITY_RECALL_SUFFIX } from "@/src/prompts/pr-review-specialists"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { Env } from "@/src/shared/types/env"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import type { RouterDecision } from "@/src/lib/ensemble-router"
import type { SigilixConfig } from "@/src/lib/sigilix-config"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

vi.mock("@/src/lib/ensemble/adapters/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/adapters/model-provider")>()
  return { ...actual, runSpecialist: vi.fn() }
})

const mockedRunSpecialist = vi.mocked(runSpecialist)
const ENV = { OLLAMA_API_KEY: "k", OPENROUTER_API_KEY: "k", OLLAMA_CHAT_ENABLE: "on" } as unknown as Env

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "server/auth.ts",
    line: 2,
    score: 4,
    category: "security",
    headline: "missing authz check",
    body: "…",
    ...over,
  } as PrReviewFinding
}

function verdictOf(role: CollectedVerdict["role"], findings: PrReviewFinding[]): CollectedVerdict {
  return { role, verdict: assignStableFindingIds(role, { findings } as unknown as PrReviewVerdict), elapsedMs: 1 }
}

const SUCCEEDED: CollectedVerdict[] = [
  verdictOf("security", [finding({ headline: "pass-1 secret-in-log" })]),
  verdictOf("logic", [finding({ path: "server/x.ts", category: "logic", headline: "logic-pass-1" })]),
]

function ctx(
  mode: EnsembleConfig["flags"]["securityKUnionMode"],
  opts: { security?: boolean; reasoning?: Map<SpecialistRole, "high" | "medium" | "low"> } = {},
): SecurityKUnionContext {
  return {
    env: ENV,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) } as unknown as EnsembleRunCtx,
    orchCtrl: new AbortController(),
    ensembleConfig: {
      flags: {
        securityKUnionMode: mode,
        reasoningPromptRoles: new Set<SpecialistRole>(),
        reasoningByRole: opts.reasoning ?? new Map<SpecialistRole, "high" | "medium" | "low">(),
      },
    } as unknown as EnsembleConfig,
    router: {
      specialists: opts.security === false ? ["logic"] : ["security", "logic"],
    } as unknown as RouterDecision,
    sigilixConfig: {} as unknown as SigilixConfig,
    messageForRole: () => "security user message",
  }
}

function apply(handle: ReturnType<typeof startSecurityKUnion>, succeeded = SUCCEEDED) {
  return applySecurityKUnion(handle, succeeded, { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) })
}

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  mockedRunSpecialist.mockReset()
})
afterEach(() => logSpy.mockRestore())

const loggedEvents = () => logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
const okVerdict = (findings: PrReviewFinding[]) => ({
  verdict: { findings } as unknown as PrReviewVerdict,
  elapsedMs: 5,
  modelUsed: "m",
  attemptsUsed: 1,
})

describe("security K-union — mode contract", () => {
  it("off: settled no-op handle, zero calls, zero telemetry, passthrough by reference", async () => {
    const handle = startSecurityKUnion(ctx("off"))
    expect(handle.dispatched).toBe(false)
    const verdicts = await apply(handle)
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(loggedEvents()).toHaveLength(0)
    expect(verdicts).toBe(SUCCEEDED)
  })

  it("security-not-dispatched: no-op even in `on` (zero calls)", async () => {
    const handle = startSecurityKUnion(ctx("on", { security: false }))
    expect(handle.dispatched).toBe(false)
    const verdicts = await apply(handle)
    expect(mockedRunSpecialist).not.toHaveBeenCalled()
    expect(verdicts).toBe(SUCCEEDED)
  })

  it("shadow: 2nd pass runs + telemeters overlap/new, but NEVER merges", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([finding({ headline: "brand new IDOR" })]))
    const handle = startSecurityKUnion(ctx("shadow"))
    expect(handle.dispatched).toBe(true)
    const verdicts = await apply(handle)
    expect(mockedRunSpecialist).toHaveBeenCalledTimes(1)
    const ev = loggedEvents().find((e) => e["event"] === "security-kunion-result")
    expect(ev).toMatchObject({
      mode: "shadow",
      merged: false,
      secondPassFindings: 1,
      newFindings: 1,
      overlap: 0,
      errored: false,
    })
    expect(verdicts).toBe(SUCCEEDED) // no merge → same array reference
  })

  it("on: 2nd-pass findings union into the SECURITY verdict; pass-1 ids stable; non-security untouched", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([finding({ headline: "brand new IDOR" })]))
    const handle = startSecurityKUnion(ctx("on"))
    const verdicts = await apply(handle)
    const sec = verdicts.find((v) => v.role === "security")!.verdict!
    expect(sec.findings.map((f) => f.id)).toEqual(["security-0", "security-1"])
    expect(sec.findings[0]!.headline).toBe("pass-1 secret-in-log") // pass-1 preserved
    // Non-target verdict untouched by reference.
    expect(verdicts.find((v) => v.role === "logic")).toBe(SUCCEEDED[1])
    expect(loggedEvents().find((e) => e["event"] === "security-kunion-result")).toMatchObject({ merged: true })
  })

  it("on + overlapping headline: telemetry counts the overlap (still unioned; synth dedups downstream)", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([finding({ headline: "pass-1 secret-in-log" })]))
    const handle = startSecurityKUnion(ctx("on"))
    await apply(handle)
    expect(loggedEvents().find((e) => e["event"] === "security-kunion-result")).toMatchObject({
      overlap: 1,
      newFindings: 0,
      merged: true,
    })
  })
})

describe("security K-union — full-strength 2nd pass + degradation", () => {
  it("runs the recall-suffixed security prompt on the 2nd pass (the recall variant, forced on)", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([]))
    const c = ctx("shadow")
    const handle = startSecurityKUnion(c)
    await apply(handle)
    const call = mockedRunSpecialist.mock.calls[0]![0]
    // The 2nd pass carries the real recall content — identical to the prod pass-1
    // security prompt when OPENCLAW_SECURITY_RECALL_MODE=on (faithful K=2 draw).
    expect(call.systemPrompt).toContain(SECURITY_RECALL_SUFFIX)
    expect(call.systemPrompt).toBe(
      specialistSystemPrompt(
        "security",
        new Set<SpecialistRole>(["security"]),
        c.ensembleConfig.flags.reasoningPromptRoles,
      ),
    )
  })

  it("mirrors pass-1 reasoning level (parity) when security has a configured effort", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([]))
    const handle = startSecurityKUnion(ctx("shadow", { reasoning: new Map([["security", "high"]]) }))
    await apply(handle)
    expect(mockedRunSpecialist.mock.calls[0]![0].reasoning).toBe("high")
  })

  it("on + 2nd pass throws: degrades to pass-1 (passthrough), telemeters errored, never throws", async () => {
    mockedRunSpecialist.mockRejectedValue(new Error("provider 500"))
    const handle = startSecurityKUnion(ctx("on"))
    const verdicts = await apply(handle)
    expect(verdicts).toBe(SUCCEEDED)
    expect(loggedEvents().find((e) => e["event"] === "security-kunion-result")).toMatchObject({
      errored: true,
      merged: false,
    })
  })

  it("on + null verdict: degrades to pass-1 (passthrough), errored telemetry", async () => {
    mockedRunSpecialist.mockResolvedValue({ verdict: null, elapsedMs: 5, modelUsed: "m", attemptsUsed: 1 })
    const handle = startSecurityKUnion(ctx("on"))
    const verdicts = await apply(handle)
    expect(verdicts).toBe(SUCCEEDED)
    expect(loggedEvents().find((e) => e["event"] === "security-kunion-result")).toMatchObject({
      errored: true,
      merged: false,
    })
  })

  it("on + 2nd pass empty (no findings): no merge, passthrough", async () => {
    mockedRunSpecialist.mockResolvedValue(okVerdict([]))
    const handle = startSecurityKUnion(ctx("on"))
    const verdicts = await apply(handle)
    expect(verdicts).toBe(SUCCEEDED)
    expect(loggedEvents().find((e) => e["event"] === "security-kunion-result")).toMatchObject({
      merged: false,
      secondPassFindings: 0,
    })
  })
})
