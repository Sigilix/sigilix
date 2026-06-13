import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyInvariantLens, type InvariantLensApplyResult } from "@/src/lib/ensemble/app/invariant-lens"
import {
  invariantLensResultForSynth,
  scheduleInvariantLensForSynth,
} from "@/src/lib/ensemble/app/invariant-lens-scheduler"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import type { InvariantLensHandle } from "@/src/lib/ensemble/app/invariant-lens"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"

vi.mock("@/src/lib/ensemble/app/invariant-lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/app/invariant-lens")>()
  return { ...actual, applyInvariantLens: vi.fn() }
})

const applyInvariantLensMock = vi.mocked(applyInvariantLens)
const PASS_THROUGH = [{ role: "logic", verdict: null, elapsedMs: 1 }] as unknown as readonly CollectedVerdict[]
const MERGED = [
  { role: "logic", verdict: { findings: [{ id: "logic-1", score: 4 }] }, elapsedMs: 1 },
] as unknown as readonly CollectedVerdict[]
const APPLIED: InvariantLensApplyResult = { verdicts: MERGED, lensFindingIds: ["logic-1"] }

function lens(mode: "off" | "shadow" | "on", dispatched: readonly string[] = ["units"]): InvariantLensHandle {
  return {
    mode,
    dispatched,
    skipped: [],
    startedAtMs: Date.now(),
    outcomes: Promise.resolve([]),
  }
}

function args(over: Partial<Parameters<typeof scheduleInvariantLensForSynth>[0]> = {}) {
  return {
    lens: lens("on"),
    recallContract: "blocking" as const,
    succeeded: PASS_THROUGH,
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 400,
    headSha: "abcdef123456",
    diff: "diff --git a/app.ts b/app.ts\n+++ b/app.ts\n+const amountCents = 1",
    ...over,
  }
}

function loggedEvent(logSpy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown> {
  const parsed = logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
  const found = parsed.find((entry) => entry["event"] === event)
  if (!found) throw new Error(`missing log event ${event}`)
  return found
}

beforeEach(() => {
  applyInvariantLensMock.mockReset()
})

describe("scheduleInvariantLensForSynth", () => {
  it("blocking contract awaits and feeds merged lens candidates to synth", async () => {
    applyInvariantLensMock.mockResolvedValueOnce(APPLIED)

    const scheduled = await scheduleInvariantLensForSynth(args())

    expect(scheduled).toEqual({ kind: "resolved", result: APPLIED })
    expect(invariantLensResultForSynth(scheduled)).toBe(APPLIED)
    expect(applyInvariantLensMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionLane: "default", recallContract: "blocking" }),
    )
  })

  it("shadow-background contract returns passthrough without awaiting shadow work", async () => {
    const backgroundWaitUntil = vi.fn()
    let resolveBackground: (result: InvariantLensApplyResult) => void = () => {
      throw new Error("background resolver was not assigned")
    }
    applyInvariantLensMock.mockReturnValueOnce(
      new Promise<InvariantLensApplyResult>((resolve) => {
        resolveBackground = resolve
      }),
    )

    const scheduled = await scheduleInvariantLensForSynth(
      args({ lens: lens("shadow"), recallContract: "shadow-background", backgroundWaitUntil }),
    )

    expect(scheduled.kind).toBe("background-scheduled")
    expect(invariantLensResultForSynth(scheduled)).toEqual({ verdicts: PASS_THROUGH, lensFindingIds: [] })
    expect(applyInvariantLensMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionLane: "background", recallContract: "shadow-background" }),
    )
    if (scheduled.kind === "background-scheduled") {
      expect(backgroundWaitUntil).toHaveBeenCalledWith(scheduled.backgroundWork)
      let completed = false
      scheduled.backgroundWork.then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      resolveBackground(APPLIED)
      await scheduled.backgroundWork
    }
  })

  it("shadow-background contract refuses to detach on mode and fails closed to blocking", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    applyInvariantLensMock.mockResolvedValueOnce(APPLIED)

    try {
      const scheduled = await scheduleInvariantLensForSynth(args({ recallContract: "shadow-background" }))

      expect(scheduled).toEqual({ kind: "resolved", result: APPLIED })
      expect(loggedEvent(logSpy, "invariant-lens-background-refused")).toMatchObject({
        event: "invariant-lens-background-refused",
        mode: "on",
        recallContract: "shadow-background",
        effectiveRecallContract: "blocking",
        refusalReason: "mode-on-requires-blocking",
      })
      expect(applyInvariantLensMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionLane: "default", recallContract: "blocking" }),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it("pending-check amendment contract refuses to detach until the merge-gated follow-up lane exists", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    applyInvariantLensMock.mockResolvedValueOnce(APPLIED)

    try {
      const scheduled = await scheduleInvariantLensForSynth(args({ recallContract: "pending-check-amendment" }))

      expect(scheduled).toEqual({ kind: "resolved", result: APPLIED })
      expect(loggedEvent(logSpy, "invariant-lens-background-refused")).toMatchObject({
        event: "invariant-lens-background-refused",
        mode: "on",
        recallContract: "pending-check-amendment",
        effectiveRecallContract: "blocking",
        refusalReason: "pending-check-amendment-unavailable",
      })
      expect(applyInvariantLensMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionLane: "default", recallContract: "blocking" }),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it("pending-check amendment contract returns passthrough and schedules amendment work when lane exists", async () => {
    let resolveAmendment: (result: InvariantLensApplyResult) => void = () => {
      throw new Error("amendment resolver was not assigned")
    }
    applyInvariantLensMock.mockReturnValueOnce(
      new Promise<InvariantLensApplyResult>((resolve) => {
        resolveAmendment = resolve
      }),
    )
    const supportedArgs = args({ recallContract: "pending-check-amendment" }) as Parameters<
      typeof scheduleInvariantLensForSynth
    >[0] & { pendingCheckAmendmentAvailable: true }
    supportedArgs.pendingCheckAmendmentAvailable = true

    const scheduled = await scheduleInvariantLensForSynth(supportedArgs)

    expect((scheduled as { kind: string }).kind).toBe("amendment-scheduled")
    expect(invariantLensResultForSynth(scheduled)).toEqual({ verdicts: PASS_THROUGH, lensFindingIds: [] })
    expect(applyInvariantLensMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionLane: "amendment", recallContract: "pending-check-amendment" }),
    )
    if ((scheduled as { kind: string }).kind === "amendment-scheduled") {
      const amendmentWork = (scheduled as { amendmentWork: Promise<InvariantLensApplyResult> }).amendmentWork
      let completed = false
      amendmentWork.then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      resolveAmendment(APPLIED)
      await expect(amendmentWork).resolves.toBe(APPLIED)
    }
  })

  it("parser-to-config-to-scheduler keeps pending-check amendments blocking", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const config = parseEnsembleConfig({
      OPENCLAW_INVARIANT_LENS_MODE: "on",
      OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT: " Pending-Check-Amendment ",
    })
    applyInvariantLensMock.mockResolvedValueOnce(APPLIED)

    try {
      const scheduled = await scheduleInvariantLensForSynth(
        args({
          lens: lens(config.flags.invariantLensMode),
          recallContract: config.flags.invariantLensRecallContract,
        }),
      )

      expect(config.flags.invariantLensRecallContract).toBe("pending-check-amendment")
      expect(scheduled).toEqual({ kind: "resolved", result: APPLIED })
      expect(loggedEvent(logSpy, "invariant-lens-background-refused")).toMatchObject({
        mode: "on",
        recallContract: "pending-check-amendment",
        effectiveRecallContract: "blocking",
        refusalReason: "pending-check-amendment-unavailable",
      })
      expect(applyInvariantLensMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionLane: "default", recallContract: "blocking" }),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it("background failures resolve and log without failing synth", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    applyInvariantLensMock.mockRejectedValueOnce(new Error("lens timeout"))

    try {
      const scheduled = await scheduleInvariantLensForSynth(
        args({ lens: lens("shadow"), recallContract: "shadow-background" }),
      )

      if (scheduled.kind === "background-scheduled") await scheduled.backgroundWork
      expect(invariantLensResultForSynth(scheduled)).toEqual({ verdicts: PASS_THROUGH, lensFindingIds: [] })
      expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "invariant-lens-background-failed",
        error: "lens timeout",
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("waitUntil registration failures log and await shadow work inline", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const backgroundWaitUntil = vi.fn(() => {
      throw new Error("waitUntil unavailable")
    })
    applyInvariantLensMock.mockResolvedValueOnce(APPLIED)

    try {
      const scheduled = await scheduleInvariantLensForSynth(
        args({ lens: lens("shadow"), recallContract: "shadow-background", backgroundWaitUntil }),
      )

      expect(scheduled.kind).toBe("background-scheduled")
      expect(applyInvariantLensMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "invariant-lens-background-registration-failed",
        error: "waitUntil unavailable",
        fallback: "awaited-inline",
      })
      if (scheduled.kind === "background-scheduled") await scheduled.backgroundWork
      expect(invariantLensResultForSynth(scheduled)).toEqual({ verdicts: PASS_THROUGH, lensFindingIds: [] })
    } finally {
      errorSpy.mockRestore()
    }
  })
})
