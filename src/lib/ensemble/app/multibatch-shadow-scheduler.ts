// SIG-418 Phase 2 (Design B′) — the multi-batch SHADOW scheduler (app layer).
//
// Detaches the dark `runMultiBatchShadow` pass from the posted critical path,
// mirroring `resweep-scheduler.ts`: the shadow work runs via `setTimeout(0)` +
// `backgroundWaitUntil` (pins it to the Worker lifetime) and NEVER rejects through
// waitUntil — a shadow failure must not convert a posted review into a queue
// failure. The orchestrator calls `scheduleMultiBatchShadow` AFTER stale-head
// guard #2 (so it never spends model calls on a head that moved post-synth) and
// continues to render→publish→finalize unblocked; the posted output + latency are
// byte-identical to today.
//
//   off / on — no-op (`on` is handled by the pre-synth enforce path, not shadow).
//   shadow   — detached, never-reject background run.

import type { Env } from "@/src/shared/types/env"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import { buildMultiBatchPrSummary } from "@/src/lib/ensemble/domain/multibatch-pr-summary"
import type { MultiBatchMode } from "@/src/lib/ensemble/domain/multibatch-budget"
import type { DiffFileBlock } from "@/src/lib/diff-packing"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import { runMultiBatchShadow, type MultiBatchShadowArgs, type MultiBatchShadowResult } from "./multibatch-shadow"

/** The identity/env/lifetime fields the shadow phase shares with the handler —
 *  passed as one object so the orchestrator call site stays a thin delegation
 *  (it spreads its own `EnsembleHandlerArgs`, which is a superset). */
export interface MultiBatchShadowIdentity {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  backgroundWaitUntil?: (promise: Promise<void>) => void
}

type BackgroundWaitUntil = (promise: Promise<void>) => void

export type ScheduleMultiBatchShadowArgs = MultiBatchShadowArgs & {
  /** The effective rollout mode. Only "shadow" schedules the run; "off"/"on" no-op. */
  mode: MultiBatchMode
  backgroundWaitUntil?: BackgroundWaitUntil
}

export type MultiBatchShadowSchedule = { kind: "noop" } | { kind: "shadow-scheduled"; shadowWork: Promise<void> }

/**
 * Schedule the dark multi-batch shadow pass off the critical path. Synchronous
 * (returns immediately); the run happens on a detached task. Returns the handle
 * so tests can await the background work; production callers ignore it.
 */
export function scheduleMultiBatchShadow(args: ScheduleMultiBatchShadowArgs): MultiBatchShadowSchedule {
  // Only "shadow" schedules this telemetry-only pass. The enforce/output-union
  // path handles `on` before synth and must not also schedule shadow work here.
  if (args.mode !== "shadow") return { kind: "noop" }

  const startedAtMs = Date.now()
  const correlation = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha.slice(0, 7),
  }
  const reportError = (err: unknown): void => {
    console.error(
      JSON.stringify({
        event: "multibatch-shadow-background-failed",
        ...correlation,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  const onComplete = (result: MultiBatchShadowResult): void => {
    console.log(
      JSON.stringify({
        event: "multibatch-shadow-background-completed",
        ...correlation,
        elapsedMs: Date.now() - startedAtMs,
        batchesLaunched: result.batchesLaunched,
        haltedEarly: result.haltedEarly,
        wouldBeUnionSize: result.wouldBeUnionSize,
      }),
    )
  }

  // Deliberately resolves after logging failures: shadow telemetry must not
  // reject through waitUntil and convert a posted review into a queue failure
  // (the resweep-scheduler contract). `runMultiBatchShadow` is already top-level
  // no-throw; the extra guards here are belt-and-suspenders.
  const shadowWork = new Promise<void>((resolve) => {
    setTimeout(() => {
      void Promise.resolve()
        .then(() => runMultiBatchShadow(args))
        .then((result) => {
          try {
            onComplete(result)
          } catch (err) {
            reportError(err)
          }
        }, reportError)
        .catch(reportError)
        .finally(resolve)
    }, 0)
  })

  // In production queue runs this pins the background task to the Worker lifetime;
  // test/legacy callers can omit it and still inspect `shadowWork`.
  try {
    args.backgroundWaitUntil?.(shadowWork)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "multibatch-shadow-background-registration-failed",
        ...correlation,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return { kind: "shadow-scheduled", shadowWork }
}

/** The orchestrator-side inputs the multi-batch shadow decision needs. Takes the
 *  orchestrator's already-in-scope OBJECTS (router / meta / synth verdicts) and
 *  derives `roles` / title / body / baseline counts internally, so the call site
 *  stays a thin delegation (the orchestrator is at its 1k-line cap). */
export interface MaybeScheduleMultiBatchShadowArgs {
  mode: MultiBatchMode
  /** Identity/env/lifetime — the orchestrator spreads its `EnsembleHandlerArgs`. */
  identity: MultiBatchShadowIdentity
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  /** The orchestrator timer ORIGIN — so the synth-budgeted guard sees true elapsed. */
  startMs: number
  /** The EFFECTIVE spillover batches (post cost-governor) the posted path deferred. */
  spilloverBatches: readonly DiffFileBlock[][]
  /** The dispatched specialist roles (same lineup per spillover batch). */
  roles: readonly SpecialistRole[]
  /** The posted single-batch synth-input verdicts — their findings are the
   *  batch-0 baseline of the would-be union (count derived here). */
  synthInputVerdicts: ReadonlyArray<{ verdict: PrReviewVerdictWithIds }>
  /** The posted single-batch reviewed file set (the coverage-delta baseline).
   *  Field names below match the orchestrator's locals so the call site uses
   *  object shorthand and stays a thin delegation (the orch is at its 1k cap). */
  filePaths: readonly string[]
  /** The files the posted path deferred — combined with `filePaths` for the
   *  whole-PR summary so a batched specialist sees the FULL changed-file set
   *  (reviewed + spillover), not just batch-0's. */
  filesNotReviewed: readonly string[]
  graphBlastCallerPaths: readonly string[]
  graphBlastDependentPaths: readonly string[]
  /** PR metadata — title/body for the per-batch message. */
  meta: { title: string; body?: string | null }
  namespace: string
  guidance?: string
  stackBlock: string
  graphCtxForPrompt: string
  /** GitHub client — used to build the pre-launch head re-check closure so the
   *  detached shadow never spends model calls on a head that moved after guard #2. */
  client: Pick<GitHubClient, "getPullRequest">
}

/**
 * The orchestrator's single entry point for the dark multi-batch shadow phase.
 * Owns the mode decision (off/on → inert, shadow → schedule), the whole-PR
 * summary build, and the per-batch message builder — so the orchestrator stays a
 * thin coordinator. Synchronous; returns the schedule handle (ignored in prod,
 * awaited in tests).
 *   off    — no-op.
 *   on     — no-op here; handled by the pre-synth enforce/output-union path.
 *   shadow — schedule the detached spillover pass (only when there IS spillover).
 *
 * MUST be called only AFTER the post-synth stale-head guard (so it never spends
 * model calls on a head that moved) — see this module's header (Codex sign-off).
 */
export function maybeScheduleMultiBatchShadow(a: MaybeScheduleMultiBatchShadowArgs): MultiBatchShadowSchedule {
  const { owner, repo, prNumber, headSha } = a.identity
  if (a.mode !== "shadow" || a.spilloverBatches.length === 0) return { kind: "noop" }

  // The whole-PR summary injected into every spillover batch's specialist context
  // so a batched specialist keeps whole-PR awareness (changed files + dependency/
  // seam hints from the already-computed graph blast paths).
  const prGlobalSummary = buildMultiBatchPrSummary({
    // The FULL changed-file set (reviewed batch-0 ∪ the deferred spillover), so a
    // batched specialist sees the whole PR — not just batch-0's files.
    changedFiles: [...a.filePaths, ...a.filesNotReviewed],
    callerPaths: a.graphBlastCallerPaths,
    dependentPaths: a.graphBlastDependentPaths,
  })
  // Per-batch message reuses the same PR-global blocks the posted path used
  // (guidance / stack / graph), with the batch diff + the whole-PR summary folded
  // into guidance so a batched specialist still sees the full picture.
  const buildBatchMessage = (role: SpecialistRole, batchDiff: string, summary: string): string =>
    buildSpecialistInitialMessage({
      prNumber,
      title: a.meta.title,
      body: a.meta.body ?? "",
      diff: batchDiff,
      retrievalSnapshot: "",
      namespace: a.namespace,
      guidance: a.guidance ? `${a.guidance}\n\n${summary}` : summary,
      ...(a.stackBlock.length > 0 ? { stackBlock: a.stackBlock } : {}),
      ...(a.graphCtxForPrompt.length > 0 && (role === "logic" || role === "tests")
        ? { graphContext: a.graphCtxForPrompt }
        : {}),
    })

  // Pre-launch head re-check: the detached shadow fires after the posted tail's
  // own freshness boundary, so re-read the PR head and compare to the queued SHA.
  // Bails the whole pass (zero model calls) if it moved — the shadow never spends
  // on a superseded head (Codex review).
  const checkHeadFresh = async (): Promise<boolean> => {
    const live = await a.client.getPullRequest(owner, repo, prNumber)
    return live.head?.sha === undefined || live.head.sha === headSha
  }

  return scheduleMultiBatchShadow({
    env: a.identity.env,
    owner,
    repo,
    prNumber,
    headSha,
    perfCtx: a.perfCtx,
    orchCtrl: a.orchCtrl,
    startMs: a.startMs,
    mode: "shadow",
    spilloverBatches: a.spilloverBatches,
    roles: a.roles,
    singleBatchFindingCount: a.synthInputVerdicts.reduce((n, v) => n + v.verdict.findings.length, 0),
    singleBatchFiles: a.filePaths,
    prGlobalSummary,
    buildBatchMessage,
    checkHeadFresh,
    ...(a.identity.backgroundWaitUntil !== undefined ? { backgroundWaitUntil: a.identity.backgroundWaitUntil } : {}),
  })
}
