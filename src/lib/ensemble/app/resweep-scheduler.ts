import { runResweepPhase, type ResweepArgs, type ResweepResult } from "./resweep"
import type { ResweepMode } from "@/src/lib/ensemble/domain/resweep"

type BackgroundWaitUntil = (promise: Promise<void>) => void

interface ResweepForSynthArgs<T> {
  mode: ResweepMode
  passthrough: T
  run: () => Promise<T>
  onShadowComplete?: (result: T) => void
  onShadowError?: (err: unknown) => void
  backgroundWaitUntil?: BackgroundWaitUntil
}

export type ResweepForSynthResult<T> =
  | { kind: "resolved"; result: T }
  | { kind: "shadow-scheduled"; passthrough: T; shadowWork: Promise<void> }

export function resweepResultForSynth<T>(resweep: ResweepForSynthResult<T>): T {
  return resweep.kind === "shadow-scheduled" ? resweep.passthrough : resweep.result
}

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

  // Deliberately resolves after logging failures: shadow telemetry must not
  // reject through waitUntil and convert a posted review into a queue failure.
  const shadowWork = new Promise<void>((resolve) => {
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
        .finally(resolve)
    }, 0)
  })
  // In production queue runs this pins the background task to the Worker
  // lifetime; test and legacy callers can omit it and still inspect shadowWork.
  try {
    args.backgroundWaitUntil?.(shadowWork)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "resweep-shadow-background-registration-failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return { kind: "shadow-scheduled", passthrough: args.passthrough, shadowWork }
}

export type ScheduleResweepArgs = ResweepArgs & { backgroundWaitUntil?: BackgroundWaitUntil }

export function scheduleResweepForSynth(args: ScheduleResweepArgs): Promise<ResweepForSynthResult<ResweepResult>> {
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
    ...(args.backgroundWaitUntil !== undefined ? { backgroundWaitUntil: args.backgroundWaitUntil } : {}),
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
