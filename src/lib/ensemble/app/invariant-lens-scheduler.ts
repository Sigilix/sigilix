import { applyInvariantLens, type InvariantLensApplyResult, type InvariantLensHandle } from "./invariant-lens"
import { decideInvariantExecution, type InvariantLensRecallContract } from "@/src/lib/ensemble/domain/invariant-lens"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"

type BackgroundWaitUntil = (promise: Promise<void>) => void

export type ScheduledInvariantLensResult =
  | { kind: "resolved"; result: InvariantLensApplyResult }
  | {
      kind: "amendment-scheduled"
      passthrough: InvariantLensApplyResult
      amendmentWork: Promise<InvariantLensApplyResult>
    }
  | { kind: "background-scheduled"; passthrough: InvariantLensApplyResult; backgroundWork: Promise<void> }

export function invariantLensResultForSynth(result: ScheduledInvariantLensResult): InvariantLensApplyResult {
  return result.kind === "resolved" ? result.result : result.passthrough
}

export async function scheduleInvariantLensForSynth(args: {
  lens: InvariantLensHandle
  recallContract: InvariantLensRecallContract
  succeeded: readonly CollectedVerdict[]
  owner: string
  repo: string
  prNumber: number
  headSha: string
  diff: string
  backgroundWaitUntil?: BackgroundWaitUntil
  pendingCheckAmendmentAvailable?: boolean
}): Promise<ScheduledInvariantLensResult> {
  const passthrough: InvariantLensApplyResult = { verdicts: args.succeeded, lensFindingIds: [] }
  const decision = decideInvariantExecution({
    mode: args.lens.mode,
    recallContract: args.recallContract,
    ...(args.pendingCheckAmendmentAvailable !== undefined
      ? { amendmentLaneAvailable: args.pendingCheckAmendmentAvailable }
      : {}),
  })
  if (decision.kind === "blocking") {
    if (decision.refusalReason !== undefined) {
      console.log(
        JSON.stringify({
          event: "invariant-lens-background-refused",
          owner: args.owner,
          repo: args.repo,
          prNumber: args.prNumber,
          headSha: args.headSha.slice(0, 7),
          mode: args.lens.mode,
          recallContract: args.recallContract,
          effectiveRecallContract: decision.effectiveRecallContract,
          refusalReason: decision.refusalReason,
        }),
      )
    }
    return {
      kind: "resolved",
      result: await applyInvariantLens({
        ...args,
        executionLane: "default",
        recallContract: decision.effectiveRecallContract,
      }),
    }
  }
  if (decision.kind === "amendment") {
    const amendmentWork = Promise.resolve().then(() =>
      applyInvariantLens({
        ...args,
        executionLane: "amendment",
        recallContract: decision.effectiveRecallContract,
      }),
    )
    void amendmentWork.catch(() => {
      /* the orchestrator awaits and reports this as merge-gated amendment failure */
    })
    return { kind: "amendment-scheduled", passthrough, amendmentWork }
  }

  const backgroundWork = Promise.resolve()
    .then(() =>
      applyInvariantLens({
        ...args,
        executionLane: "background",
        recallContract: "shadow-background",
      }),
    )
    .then(
      (result) => {
        console.log(
          JSON.stringify({
            event: "invariant-lens-background-completed",
            owner: args.owner,
            repo: args.repo,
            prNumber: args.prNumber,
            headSha: args.headSha.slice(0, 7),
            lensFindingIds: result.lensFindingIds.length,
            verdictsForSynth: result.verdicts.length,
          }),
        )
      },
      (err: unknown) => {
        console.error(
          JSON.stringify({
            event: "invariant-lens-background-failed",
            owner: args.owner,
            repo: args.repo,
            prNumber: args.prNumber,
            headSha: args.headSha.slice(0, 7),
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      },
    )
  try {
    args.backgroundWaitUntil?.(backgroundWork)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "invariant-lens-background-registration-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        headSha: args.headSha.slice(0, 7),
        error: err instanceof Error ? err.message : String(err),
        fallback: "awaited-inline",
      }),
    )
    await backgroundWork
  }
  return { kind: "background-scheduled", passthrough, backgroundWork }
}
