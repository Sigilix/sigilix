// SIG-418 Phase 2 (Design B′) — the in-invocation multi-batch SHADOW phase (app
// layer): a dark, telemetry-only second pass that reviews the SPILLOVER batches
// (the files the posted single-batch path deferred) so we can measure what a
// multi-batch review WOULD cover before PR 3 makes it the posted output.
//
// Modes (`OPENCLAW_REVIEW_MULTIBATCH_MODE`, default off — read by the
// orchestrator, NOT here; this module only runs when the caller decided "shadow"):
//   off    — the orchestrator never schedules this phase (inert).
//   shadow — THIS module: review the spillover batches + emit telemetry, but the
//            POSTED review stays the current single-batch synth result. Zero
//            posted-output change — the rollout's first stop (mirrors resweep).
//   on     — DEFERRED to PR 3 (the enforce/output-union path + the cross-batch
//            seam pass + dedup-before-recall-floors). The orchestrator treats
//            `on` as inert in PR 2 and logs `multibatch-mode-unsupported`.
//
// RECALL-SAFETY: this phase returns NOTHING the synth/adjudicate/publish tail
// consumes. It cannot suppress, demote, or alter a posted finding. Batch 0 is
// NEVER re-run — its coverage is taken from the posted path's pass-1 verdicts;
// the loop spends the after-seam window ONLY on the spillover files this feature
// exists to recover. The synth-budgeted guard (`decideNextBatchLaunchWithBudget`)
// reserves the synth tail, so a launched spillover batch can never starve it.
//
// The whole-PR summary (changed-file list + dependency/seam hints) is injected
// into every spillover batch's specialist context so a batched specialist keeps
// whole-PR awareness — needed for the batches to be meaningful, harmless in shadow.
//
// Design + sign-off: docs/superpowers/specs/2026-06-15-sig418-phase2-sharded-review-spec.md
// (the "⛔ DECISION 2026-06-14" Design B′ block). Codex signed off the wiring plan.

import type { Env } from "@/src/shared/types/env"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { modelApiKeys, runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { SPECIALIST_PROMPTS } from "@/src/prompts/pr-review-specialists"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import { batchToDiff, type DiffFileBlock } from "@/src/lib/diff-packing"
import { decideNextBatchLaunchAfterSynthWithBudget } from "@/src/lib/ensemble/domain/multibatch-budget"
import { namespaceFindingId } from "@/src/lib/ensemble/domain/multibatch-finding-id"

/** The smallest remaining pre-synth window worth starting another batch in. A
 *  batch that can't get at least this much time would burn budget without a
 *  realistic chance of a useful verdict, so the guard stops instead. Sized to one
 *  realistic per-attempt cap so the launched batch can at least complete a single
 *  model attempt before the synth tail must run. */
const MIN_USEFUL_BATCH_MS = 60_000

export interface MultiBatchShadowArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  /** The orchestrator timer ORIGIN (epoch ms) — the same `startMs` the orch wall
   *  uses, so the synth-budgeted guard sees the true elapsed time (pre-flight +
   *  packing + the whole single-batch fan-out + synth already consumed). */
  startMs: number
  /** The EFFECTIVE spillover batches the posted single-batch path deferred (post
   *  cost-governor). Batch index k here maps to namespaced batch index k+1 (batch
   *  0 is the posted path, never re-run). */
  spilloverBatches: readonly DiffFileBlock[][]
  /** The specialist roles the posted path dispatched (same lineup per batch). */
  roles: readonly SpecialistRole[]
  /** The posted single-batch path's finding count — the batch-0 baseline of the
   *  would-be union (its ids are already `${role}-i` and are NOT re-namespaced). */
  singleBatchFindingCount: number
  /** The posted single-batch path's reviewed file set — for the coverage delta. */
  singleBatchFiles: readonly string[]
  /** A compact whole-PR summary (changed-file list + dependency/seam hints) the
   *  caller built once; injected into every spillover batch's specialist context. */
  prGlobalSummary: string
  /** Builds a spillover batch's per-role initial message from the batch diff + the
   *  whole-PR summary + the PR-global blocks (guidance/stack/graph). Supplied by
   *  the orchestrator so this module stays free of the prompt-assembly inputs. */
  buildBatchMessage: (role: SpecialistRole, batchDiff: string, prGlobalSummary: string) => string
}

/** Telemetry-only result. NOTHING here flows into synth/adjudicate/publish — the
 *  posted review is unchanged. Returned so the scheduler can log a completion
 *  summary (and tests can assert), never to mutate the posted output. */
export interface MultiBatchShadowResult {
  spilloverBatchesAvailable: number
  batchesLaunched: number
  haltedEarly: boolean
  /** The spillover batch index (0-based within `spilloverBatches`) the guard
   *  halted at, or null if every spillover batch was launched. */
  haltedAtBatch: number | null
  /** singleBatchFindingCount + the spillover findings (the would-be union size if
   *  PR 3's enforce path merged them). Size only — nothing is merged here. */
  wouldBeUnionSize: number
  erroredBatches: number
}

function correlation(a: MultiBatchShadowArgs): Record<string, string | number> {
  return { owner: a.owner, repo: a.repo, prNumber: a.prNumber, headSha: a.headSha.slice(0, 7) }
}

/**
 * Run the dark multi-batch SHADOW pass over the spillover batches. Top-level
 * no-throw (any unexpected error degrades to the telemetry-only summary the
 * caller already has) — a shadow failure must NEVER perturb the posted review.
 */
export async function runMultiBatchShadow(a: MultiBatchShadowArgs): Promise<MultiBatchShadowResult> {
  const startedAtMs = Date.now()
  const result: MultiBatchShadowResult = {
    spilloverBatchesAvailable: a.spilloverBatches.length,
    batchesLaunched: 0,
    haltedEarly: false,
    haltedAtBatch: null,
    wouldBeUnionSize: a.singleBatchFindingCount,
    erroredBatches: 0,
  }
  // Nothing deferred → nothing to measure (the common single-batch PR).
  if (a.spilloverBatches.length === 0) return result

  const chatEnabled = a.env.OLLAMA_CHAT_ENABLE === "on" ? ("on" as const) : ("off" as const)
  const coveredFiles = new Set(a.singleBatchFiles)
  const perBatch: Array<{ batchIdx: number; elapsedMs: number; findings: number; errored: boolean }> = []
  // The per-batch namespaced finding ids (role-FIRST `${role}-b${n}-${idx}`). A
  // Set proves they're collision-free across spillover batches — the PR-3 enforce
  // path will merge on exactly these ids, so exercising the namespace here (not
  // discarding it) is the dark validation this shadow pass exists for.
  const namespacedFindingIds = new Set<string>()

  try {
    for (let k = 0; k < a.spilloverBatches.length; k++) {
      // Namespaced batch index: batch 0 is the posted single-batch path (never
      // re-run here), so the first spillover batch is namespaced batch 1.
      const namespacedBatchIdx = k + 1
      const batch = a.spilloverBatches[k]!

      // The synth-budgeted guard, read against the REAL wall-clock. This pass runs
      // AFTER the single-batch synth, so the synth budget is already spent — the
      // POST-synth variant reserves only the render→publish→finalize tail (not the
      // synth budget again, which would halt immediately every run). A spillover
      // batch launches only inside the remaining window, timeout clamped to it, so
      // the posted review's finalize is never starved (recall-safe).
      const decision = decideNextBatchLaunchAfterSynthWithBudget({
        startMs: a.startMs,
        now: Date.now(),
        minUsefulBatchMs: MIN_USEFUL_BATCH_MS,
      })
      console.log(
        JSON.stringify({
          event: "multibatch-decision",
          ...correlation(a),
          batchIdx: namespacedBatchIdx,
          canLaunchNextBatch: decision.canLaunchNextBatch,
          batchTimeoutMs: decision.batchTimeoutMs,
          preSynthDeadline: decision.preSynthDeadline,
          launched: decision.canLaunchNextBatch,
        }),
      )
      if (!decision.canLaunchNextBatch) {
        // The remaining tail wouldn't fit alongside another batch — stop launching.
        result.haltedEarly = true
        result.haltedAtBatch = k
        break
      }

      const batchDiff = batchToDiff([...batch])
      const batchStartMs = Date.now()
      // Fan out the same role lineup over this spillover batch. Per-call try/catch
      // (like resweep) — a failed batch contributes nothing, never throws upward.
      const roleResults = await Promise.all(
        a.roles.map(async (role) => {
          try {
            const r = await runSpecialist({
              role,
              apiKeys: modelApiKeys(a.env),
              systemPrompt: SPECIALIST_PROMPTS[role],
              initialMessage: a.buildBatchMessage(role, batchDiff, a.prGlobalSummary),
              chatEnabled,
              // Composed: the orch wall OR the per-batch budget clamp aborts the
              // in-flight call. The guard guarantees `batchTimeoutMs` leaves the
              // post-synth tail (render→publish→finalize) its room.
              signal: composeSignals(a.orchCtrl.signal, AbortSignal.timeout(decision.batchTimeoutMs)),
              perfCtx: a.perfCtx,
            })
            return { role, findings: r.verdict?.findings ?? [], errored: r.verdict === null }
          } catch {
            return { role, findings: [], errored: true }
          }
        }),
      )

      let batchFindings = 0
      let batchErrored = false
      for (const rr of roleResults) {
        if (rr.errored) batchErrored = true
        for (let idx = 0; idx < rr.findings.length; idx++) {
          const f = rr.findings[idx]!
          // Namespace the id (role-FIRST `logic-b1-0` — role inference unchanged)
          // and collect it; the Set is the would-be union's spillover keys. Nothing
          // is merged into the posted output — sizing + namespace validation only.
          namespacedFindingIds.add(namespaceFindingId(rr.role, namespacedBatchIdx, idx))
          batchFindings += 1
          result.wouldBeUnionSize += 1
          coveredFiles.add(f.path)
        }
      }
      if (batchErrored) result.erroredBatches += 1
      result.batchesLaunched += 1
      perBatch.push({
        batchIdx: namespacedBatchIdx,
        elapsedMs: Date.now() - batchStartMs,
        findings: batchFindings,
        errored: batchErrored,
      })
    }
  } catch (err) {
    // Defense in depth: the per-call catches already structure model failures;
    // this guards any unexpected throw so the shadow can never break the run.
    console.error(
      JSON.stringify({
        event: "multibatch-shadow-error",
        ...correlation(a),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  console.log(
    JSON.stringify({
      event: "multibatch-summary",
      ...correlation(a),
      mode: "shadow",
      spilloverBatchesAvailable: result.spilloverBatchesAvailable,
      batchesLaunched: result.batchesLaunched,
      haltedEarly: result.haltedEarly,
      haltedAtBatch: result.haltedAtBatch,
      wouldBeUnionSize: result.wouldBeUnionSize,
      singleBatchFindingCount: a.singleBatchFindingCount,
      // How many MORE files the multi-batch pass covered vs the posted single-batch
      // path — the recovered-coverage signal that decides enforce in PR 3.
      coverageDeltaFiles: coveredFiles.size - a.singleBatchFiles.length,
      erroredBatches: result.erroredBatches,
      // The namespaced spillover finding ids (collision-free across batches by
      // construction) the PR-3 enforce merge will key on — count + a small sample.
      spilloverFindingIdCount: namespacedFindingIds.size,
      spilloverFindingIdSample: [...namespacedFindingIds].slice(0, 10),
      perBatch,
      elapsedMs: Date.now() - startedAtMs,
    }),
  )

  return result
}
