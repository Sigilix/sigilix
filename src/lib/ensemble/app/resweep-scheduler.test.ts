import { beforeEach, describe, expect, it, vi } from "vitest"
import { runResweepPhase, type ResweepArgs, type ResweepResult } from "@/src/lib/ensemble/app/resweep"
import {
  resolveResweepForSynth,
  resweepResultForSynth,
  scheduleResweepForSynth,
} from "@/src/lib/ensemble/app/resweep-scheduler"

vi.mock("@/src/lib/ensemble/app/resweep", () => ({
  runResweepPhase: vi.fn(),
}))

const runResweepPhaseMock = vi.mocked(runResweepPhase)
const PASS_1_VERDICTS = [{ role: "logic" }] as unknown as ResweepResult["verdicts"]
const MERGED_VERDICTS = [{ role: "logic" }, { role: "security" }] as unknown as ResweepResult["verdicts"]

function scheduleArgs(mode: ResweepArgs["mode"]): ResweepArgs {
  return {
    env: {} as ResweepArgs["env"],
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 520,
    headSha: "abcdef123456",
    mode,
    maxRegions: 2,
    perfCtx: {} as ResweepArgs["perfCtx"],
    orchCtrl: new AbortController(),
    diff: "diff --git a/app.ts b/app.ts",
    succeeded: PASS_1_VERDICTS,
    providerByRole: new Map(),
  }
}

beforeEach(() => {
  runResweepPhaseMock.mockReset()
})

describe("resolveResweepForSynth", () => {
  it("off: returns passthrough without starting resweep work", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    const run = vi.fn(async () => ({ verdicts: ["unexpected"], resweepFindingIds: ["logic-1"] }))

    const result = await resolveResweepForSynth({ mode: "off", passthrough, run })

    expect(result).toEqual({ kind: "resolved", result: passthrough })
    expect(run).not.toHaveBeenCalled()
  })

  it("shadow: starts resweep work but returns passthrough immediately for synth", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    let finish!: (value: typeof passthrough) => void
    const run = vi.fn(
      () =>
        new Promise<typeof passthrough>((resolve) => {
          finish = resolve
        }),
    )

    const result = await resolveResweepForSynth({ mode: "shadow", passthrough, run })

    expect(result.kind).toBe("shadow-scheduled")
    expect(resweepResultForSynth(result)).toBe(passthrough)
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    finish({ verdicts: ["shadow-only"], resweepFindingIds: [] })
    if (result.kind === "shadow-scheduled") await result.shadowWork
  })

  it("on: awaits resweep output before synth so merged candidates can affect recall", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    const merged = { verdicts: ["pass-1", "resweep"], resweepFindingIds: ["logic-1"] }

    const result = await resolveResweepForSynth({ mode: "on", passthrough, run: async () => merged })

    expect(result).toEqual({ kind: "resolved", result: merged })
  })

  it("on: propagates resweep failures because merged mode is recall-affecting", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }

    await expect(
      resolveResweepForSynth({
        mode: "on",
        passthrough,
        run: async () => {
          throw new Error("resweep failed")
        },
      }),
    ).rejects.toThrow("resweep failed")
  })

  it("shadow: reports resweep errors without failing synth", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    const err = new Error("provider timeout")
    const onShadowError = vi.fn()

    const result = await resolveResweepForSynth({
      mode: "shadow",
      passthrough,
      run: async () => {
        throw err
      },
      onShadowError,
    })

    expect(result.kind).toBe("shadow-scheduled")
    expect(resweepResultForSynth(result)).toBe(passthrough)
    await vi.waitFor(() => expect(onShadowError).toHaveBeenCalledWith(err))
    if (result.kind === "shadow-scheduled") await result.shadowWork
  })

  it("shadow: reports completion so scheduled/completed loss can be measured", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    const shadowResult = { verdicts: ["shadow-only"], resweepFindingIds: [] as string[] }
    const onShadowComplete = vi.fn()

    await resolveResweepForSynth({
      mode: "shadow",
      passthrough,
      run: async () => shadowResult,
      onShadowComplete,
    })

    expect(onShadowComplete).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onShadowComplete).toHaveBeenCalledWith(shadowResult))
  })

  it("shadow: logs a fallback when the shadow error reporter throws", async () => {
    const passthrough = { verdicts: ["pass-1"], resweepFindingIds: [] as string[] }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await resolveResweepForSynth({
        mode: "shadow",
        passthrough,
        run: async () => {
          throw new Error("provider timeout")
        },
        onShadowError: () => {
          throw new Error("logger failed")
        },
      })

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      expect(errorSpy.mock.calls[0]?.[0]).toContain("resweep-shadow-background-error-handler-failed")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("scheduleResweepForSynth off: returns pass-1 inputs without scheduling work", async () => {
    const backgroundWaitUntil = vi.fn()

    const result = await scheduleResweepForSynth({ ...scheduleArgs("off"), backgroundWaitUntil })

    expect(result).toEqual({ kind: "resolved", result: { verdicts: PASS_1_VERDICTS, resweepFindingIds: [] } })
    expect(resweepResultForSynth(result)).toEqual({ verdicts: PASS_1_VERDICTS, resweepFindingIds: [] })
    expect(runResweepPhaseMock).not.toHaveBeenCalled()
    expect(backgroundWaitUntil).not.toHaveBeenCalled()
  })

  it("scheduleResweepForSynth on: awaits merged output before synth inputs are read", async () => {
    const merged = { verdicts: MERGED_VERDICTS, resweepFindingIds: ["logic-1"] }
    const backgroundWaitUntil = vi.fn()
    runResweepPhaseMock.mockResolvedValueOnce(merged)

    const result = await scheduleResweepForSynth({ ...scheduleArgs("on"), backgroundWaitUntil })

    expect(result).toEqual({ kind: "resolved", result: merged })
    expect(resweepResultForSynth(result)).toBe(merged)
    expect(backgroundWaitUntil).not.toHaveBeenCalled()
  })

  it("scheduleResweepForSynth shadow: registers explicit background work and feeds pass-1 synth inputs", async () => {
    const shadowOnly = { verdicts: MERGED_VERDICTS, resweepFindingIds: ["logic-1"] }
    const backgroundWaitUntil = vi.fn()
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    runResweepPhaseMock.mockResolvedValueOnce(shadowOnly)

    try {
      const result = await scheduleResweepForSynth({ ...scheduleArgs("shadow"), backgroundWaitUntil })

      expect(result.kind).toBe("shadow-scheduled")
      expect(resweepResultForSynth(result)).toEqual({ verdicts: PASS_1_VERDICTS, resweepFindingIds: [] })
      expect(runResweepPhaseMock).not.toHaveBeenCalled()
      if (result.kind === "shadow-scheduled") {
        expect(backgroundWaitUntil).toHaveBeenCalledWith(result.shadowWork)
        await result.shadowWork
      }
      expect(runResweepPhaseMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "resweep-shadow-background-completed",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 520,
        headSha: "abcdef1",
        verdictsForSynth: 2,
        resweepFindingIds: 1,
      })
    } finally {
      logSpy.mockRestore()
    }
  })

  it("scheduleResweepForSynth shadow: background failures resolve and are logged", async () => {
    const backgroundWaitUntil = vi.fn()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    runResweepPhaseMock.mockRejectedValueOnce(new Error("provider timeout"))

    try {
      const result = await scheduleResweepForSynth({ ...scheduleArgs("shadow"), backgroundWaitUntil })

      if (result.kind === "shadow-scheduled") await result.shadowWork
      expect(backgroundWaitUntil).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "resweep-shadow-background-failed",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 520,
        headSha: "abcdef1",
        error: "provider timeout",
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("scheduleResweepForSynth shadow: registration failures do not fail synth", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    runResweepPhaseMock.mockResolvedValueOnce({ verdicts: MERGED_VERDICTS, resweepFindingIds: [] })

    try {
      const result = await scheduleResweepForSynth({
        ...scheduleArgs("shadow"),
        backgroundWaitUntil: () => {
          throw new Error("waitUntil unavailable")
        },
      })

      expect(result.kind).toBe("shadow-scheduled")
      if (result.kind === "shadow-scheduled") await result.shadowWork
      expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
        event: "resweep-shadow-background-registration-failed",
        error: "waitUntil unavailable",
      })
    } finally {
      errorSpy.mockRestore()
    }
  })
})
