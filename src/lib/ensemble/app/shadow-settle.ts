// SIG-318 (PR 12b) — the shadow-bakeoff SETTLE phase of the PR-review
// orchestrator (app layer). Carved from `handlePrReviewEnsemble`'s outer
// `finally` body (everything after `clearTimeout(orchTimer)`): the ARC-283
// shadow-comparison emit that, on every return path, races each pending shadow
// promise against the grace deadline and emits the cut-short / run-failed /
// comparison telemetry. The moved statements are byte-identical apart from the
// `shadowState.` container prefixes (the four loose pre-try containers are now
// one `ShadowBakeoffState` holder) and the function wrapper. ZERO behavior change.
//
// Dependency rule: this module imports each dependency from its canonical NON-
// god-file home (domain/shadow-grace, the shadow-bakeoff-* lib siblings, the
// model-provider adapter). It never imports the orchestrator god-file.

import type { SpecialistRole } from "@/src/lib/ensemble-router"
import type { ShadowRunResult } from "@/src/lib/shadow-bakeoff-runner"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import {
  buildShadowVerdictComparison,
  emitShadowCutShort,
  emitShadowRunFailed,
  emitShadowVerdictComparison,
  type FindingForOverlap,
} from "@/src/lib/shadow-bakeoff-telemetry"
import { SPECIALIST_CONFIGS, SYNTHESIZER_CONFIG } from "@/src/lib/ensemble/adapters/model-provider"
import {
  SHADOW_GRACE_EXPIRED,
  isShadowRunFailed,
  raceWithShadowGrace,
} from "@/src/lib/ensemble/domain/shadow-grace"

/**
 * Prod-side snapshot of a specialist (or the synth) outcome, captured by the
 * orchestrator as soon as it settles, so the finally-phase shadow comparison can
 * fire even on prod-error return paths. Moved verbatim with the holder.
 */
export type ProdSpecialistSnapshot = {
  verdictOk: boolean
  modelUsed: string
  attemptsUsed: number
  elapsedMs: number
  findings: readonly FindingForOverlap[]
}

/**
 * ARC-283 Phase B1b shadow-mode bake-off state, lifted out of the orchestrator's
 * try block so the settle phase can read it on every return path. The four loose
 * containers (specialist promises, prod snapshots, abort controllers, synth
 * promise) are bundled into one holder threaded by reference. `SHADOW_BAKEOFF_ROLES`
 * unset/empty → the maps stay empty + `synthPromise` stays null + the settle is a
 * zero-cost no-op.
 */
export interface ShadowBakeoffState {
  specialistPromises: Map<SpecialistRole, Promise<ShadowRunResult>>
  prodSnapshots: Map<SpecialistRole, ProdSpecialistSnapshot>
  abortControllers: Map<SpecialistRole | "synth", AbortController>
  synthPromise: Promise<ShadowRunResult> | null
}

/** The synthesizer telemetry slice the settle phase reads (by reference). */
interface SettleTelemetry {
  synthesizer: {
    verdict: PrReviewVerdict | null
    modelUsed?: string
    attemptsUsed?: number
    elapsedMs: number
  } | null
}

export interface SettleArgs {
  shadowState: ShadowBakeoffState
  /** Read-only here: the prod synth snapshot is derived from `telemetry.synthesizer`. */
  telemetry: SettleTelemetry
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  /** Absolute wall-clock cap on the shadow tail (finally-start + SHADOW_FINALIZE_GRACE_MS). */
  shadowFinalizeGraceMs: number
  owner: string
  repo: string
  prNumber: number
  headSha: string
}

export async function settleShadowBakeoff(a: SettleArgs): Promise<void> {
  const {
    shadowState,
    telemetry,
    perfCtx,
    orchCtrl,
    shadowFinalizeGraceMs: SHADOW_FINALIZE_GRACE_MS,
    owner,
    repo,
    prNumber,
    headSha,
  } = a
    // ARC-283 Phase B1b — shadow comparison emit. Runs on EVERY
    // return path (success, skip-notice bail, outer-catch
    // internal_error). When shadow was disabled the maps stay empty
    // and this block is a zero-cost no-op. Each await is individually
    // try/wrap'd — a shadow-side crash MUST NOT take down the prod
    // return value the function already produced.
    //
    // ARC-283 review pass: a pathologically slow shadow can no longer
    // hold the queue consumer past the 900s CF Queues ceiling. Each
    // shadow await is raced against `shadowDeadline` (finally-start +
    // SHADOW_FINALIZE_GRACE_MS). On grace expiry we emit
    // `shadow-cut-short` and skip the comparison emit for that role.
    const finallyStartMs = Date.now()
    const shadowDeadline = finallyStartMs + SHADOW_FINALIZE_GRACE_MS
    if (shadowState.specialistPromises.size > 0) {
      for (const [role, shadowPromise] of shadowState.specialistPromises) {
        try {
          // Shadow comparison is per-role + must serialize on the
          // same wall-clock; each await independently catches its own
          // failure so an early role error can't poison the rest. The
          // grace race shares one absolute deadline across all roles,
          // so a slow first role can't starve the others.
          const shadow = await raceWithShadowGrace(
            shadowPromise,
            shadowDeadline,
            orchCtrl.signal,
          )
          if (shadow === SHADOW_GRACE_EXPIRED) {
            // ARC-283 Phase B1b CR-2: abort the in-flight shadow
            // request BEFORE emitting the telemetry, so the underlying
            // HTTP call actually stops consuming provider capacity.
            // The controller is only present when the runner hasn't
            // settled yet (the .finally() in the dispatch site clears
            // it on settle).
            const reason: "grace_deadline" | "orch_aborted" =
              orchCtrl.signal.aborted ? "orch_aborted" : "grace_deadline"
            const ctrl = shadowState.abortControllers.get(role)
            if (ctrl && !ctrl.signal.aborted) ctrl.abort(reason)
            emitShadowCutShort(perfCtx, {
              role,
              elapsedAtCutMs: Date.now() - finallyStartMs,
              reason,
            })
            continue
          }
          if (isShadowRunFailed(shadow)) {
            // ARC-283 Phase B1b CR-1: shadow runner crashed outside
            // its own catch. Emit the dedicated `shadow-run-failed`
            // event so dashboards distinguish a runner crash from a
            // grace-deadline cut. Abort any controller that's still
            // around (defensive — the .finally() should have cleared
            // it already since the promise settled).
            const ctrl = shadowState.abortControllers.get(role)
            if (ctrl && !ctrl.signal.aborted) ctrl.abort("run_failed")
            emitShadowRunFailed(perfCtx, { role, message: shadow.message })
            continue
          }
          const prodSnapshot = shadowState.prodSnapshots.get(role)
          // When the prod path errored before the fan-out settled
          // (orchestrator caught an exception inside try{} before
          // `collectSpecialistVerdicts` ran), there's no prod
          // snapshot. Build a synthetic "prod did not run" entry so
          // the comparison still emits — operators can pivot on
          // `prodVerdictOk === false && prodAttemptsUsed === 0` to
          // filter these out of the bake-off analysis.
          const prod = prodSnapshot ?? {
            verdictOk: false,
            modelUsed: SPECIALIST_CONFIGS[role].primary,
            attemptsUsed: 0,
            elapsedMs: 0,
            findings: [] as readonly FindingForOverlap[],
          }
          const comparison = buildShadowVerdictComparison({
            role,
            prodModelDefault: SPECIALIST_CONFIGS[role].primary,
            prod,
            shadow: {
              verdictOk: shadow.verdictOk,
              modelUsed: shadow.modelUsed,
              attemptsUsed: shadow.attemptsUsed,
              elapsedMs: shadow.elapsedMs,
              findings: shadow.findings,
              ...(shadow.failureReason !== undefined
                ? { failureReason: shadow.failureReason }
                : {}),
            },
          })
          emitShadowVerdictComparison(perfCtx, comparison)
        } catch (err) {
          // Defensive: a shadow-side crash (shouldn't happen — the
          // runner catches every failure path internally) must NOT
          // corrupt the prod return value the function already
          // produced. Surface as a structured event for CF Logs
          // mirroring the Task-4 `model-attempt-emit-error` shape.
          console.warn(JSON.stringify({
            event: "shadow-specialist-emit-error",
            owner, repo, prNumber,
            headSha: headSha.slice(0, 7),
            role,
            message: err instanceof Error ? err.message : String(err),
          }))
        }
      }
    }
    if (shadowState.synthPromise !== null) {
      try {
        const shadow = await raceWithShadowGrace(
          shadowState.synthPromise,
          shadowDeadline,
          orchCtrl.signal,
        )
        if (shadow === SHADOW_GRACE_EXPIRED) {
          // ARC-283 Phase B1b CR-2: cancel in-flight synth before
          // emitting telemetry so the HTTP request actually stops.
          const reason: "grace_deadline" | "orch_aborted" =
            orchCtrl.signal.aborted ? "orch_aborted" : "grace_deadline"
          const ctrl = shadowState.abortControllers.get("synth")
          if (ctrl && !ctrl.signal.aborted) ctrl.abort(reason)
          emitShadowCutShort(perfCtx, {
            role: "synth",
            elapsedAtCutMs: Date.now() - finallyStartMs,
            reason,
          })
        } else if (isShadowRunFailed(shadow)) {
          // ARC-283 Phase B1b CR-1: shadow synth runner crashed.
          // Emit the dedicated `shadow-run-failed` event.
          const ctrl = shadowState.abortControllers.get("synth")
          if (ctrl && !ctrl.signal.aborted) ctrl.abort("run_failed")
          emitShadowRunFailed(perfCtx, { role: "synth", message: shadow.message })
        } else {
          // Build the prod synth snapshot from telemetry.synthesizer.
          // Every exit path that runs the synth populates this field;
          // the only case where it's null is the outer-catch path that
          // fired BEFORE the inner synth try ran. In that case prod
          // never produced any synth output — same synthetic "prod
          // did not run" shape as the specialist branch above.
          const prodSynthTel = telemetry.synthesizer
          const prodSynthFindings: FindingForOverlap[] = prodSynthTel?.verdict
            ? prodSynthTel.verdict.findings.map((f) => ({
                path: f.path,
                line: f.line,
                category: f.category,
                score: f.score,
              }))
            : []
          const prod: ProdSpecialistSnapshot = {
            verdictOk: prodSynthTel?.verdict != null,
            modelUsed: prodSynthTel?.modelUsed ?? SYNTHESIZER_CONFIG.primary,
            attemptsUsed: prodSynthTel?.attemptsUsed ?? 0,
            elapsedMs: prodSynthTel?.elapsedMs ?? 0,
            findings: prodSynthFindings,
          }
          const comparison = buildShadowVerdictComparison({
            role: "synth",
            prodModelDefault: SYNTHESIZER_CONFIG.primary,
            prod,
            shadow: {
              verdictOk: shadow.verdictOk,
              modelUsed: shadow.modelUsed,
              attemptsUsed: shadow.attemptsUsed,
              elapsedMs: shadow.elapsedMs,
              findings: shadow.findings,
              ...(shadow.failureReason !== undefined
                ? { failureReason: shadow.failureReason }
                : {}),
            },
          })
          emitShadowVerdictComparison(perfCtx, comparison)
        }
      } catch (err) {
        // Same defensive shape as the specialist branch above.
        console.warn(JSON.stringify({
          event: "shadow-synth-emit-error",
          owner, repo, prNumber,
          headSha: headSha.slice(0, 7),
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    }
}
