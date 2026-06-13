import { describe, expect, it, vi } from "vitest"
import { resolveResweepForSynth } from "@/src/lib/ensemble/app/resweep-scheduler"

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

    expect(result).toEqual({ kind: "shadow-scheduled", passthrough })
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    finish({ verdicts: ["shadow-only"], resweepFindingIds: [] })
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

    expect(result).toEqual({ kind: "shadow-scheduled", passthrough })
    await vi.waitFor(() => expect(onShadowError).toHaveBeenCalledWith(err))
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
})
