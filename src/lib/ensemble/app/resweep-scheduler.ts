import { runResweepPhase, type ResweepArgs, type ResweepResult } from "./resweep"
import type { ResweepMode } from "@/src/lib/ensemble/domain/resweep"

interface ResweepForSynthArgs<T> {
  mode: ResweepMode
  passthrough: T
  run: () => Promise<T>
  onShadowComplete?: (result: T) => void
  onShadowError?: (err: unknown) => void
}

export type ResweepForSynthResult<T> = { kind: "resolved"; result: T } | { kind: "shadow-scheduled"; passthrough: T }

export async function resolveResweepForSynth<T>(args: ResweepForSynthArgs<T>): Promise<ResweepForSynthResult<T>> {
  if (args.mode === "off") return { kind: "resolved", result: args.passthrough }
  if (args.mode === "on") return { kind: "resolved", result: await args.run() }

  const reportShadowError = (err: unknown): void => {
    if (args.onShadowError === undefined) {
      console.error(JSON.stringify({ event: "resweep-shadow-background-unhandled", error: String(err) }))
      return
    }
    try {
      args.onShadowError(err)
    } catch (handlerErr) {
      console.error(
        JSON.stringify({
          event: "resweep-shadow-background-error-handler-failed",
          originalError: err instanceof Error ? err.message : String(err),
          handlerError: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
        }),
      )
    }
  }

  setTimeout(() => {
    void Promise.resolve()
      .then(args.run)
      .then((result) => {
        try {
          args.onShadowComplete?.(result)
        } catch (err) {
          reportShadowError(err)
        }
      }, reportShadowError)
      .catch(reportShadowError)
  }, 0)
  return { kind: "shadow-scheduled", passthrough: args.passthrough }
}

export async function scheduleResweepForSynth(args: ResweepArgs): Promise<ResweepForSynthResult<ResweepResult>> {
  const startedAtMs = Date.now()
  const correlation = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha.slice(0, 7),
  }
  return resolveResweepForSynth({
    mode: args.mode,
    passthrough: { verdicts: args.succeeded, resweepFindingIds: [] },
    run: () => runResweepPhase(args),
    onShadowComplete: (result) => {
      console.log(
        JSON.stringify({
          event: "resweep-shadow-background-completed",
          ...correlation,
          elapsedMs: Date.now() - startedAtMs,
          verdictsForSynth: result.verdicts.length,
          resweepFindingIds: result.resweepFindingIds.length,
        }),
      )
    },
    onShadowError: (err) => {
      console.error(
        JSON.stringify({
          event: "resweep-shadow-background-failed",
          ...correlation,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    },
  })
}
