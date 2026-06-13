import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyInvariantLens, type InvariantLensApplyResult } from "@/src/lib/ensemble/app/invariant-lens"
import {
  invariantLensResultForSynth,
  scheduleInvariantLensForSynth,
} from "@/src/lib/ensemble/app/invariant-lens-scheduler"
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
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "invariant-lens-background-refused",
        mode: "on",
        recallContract: "shadow-background",
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
