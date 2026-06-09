// SIG-318 (PR 12b) — the shadow-bakeoff GRACE primitives (domain layer).
//
// PURE control-flow helpers for the ARC-283 shadow tail: the two race
// sentinels, the AbortSignal composer, the run-failed wrapper + its type-guard,
// and the wall-clock grace race. No env / network / storage — only Web globals
// (AbortController, setTimeout, Date, Symbol). Moved verbatim from
// triage-pr-review-ensemble.ts and re-exported there, so existing importers (the
// shadow-grace-race test + the orchestrator) are unaffected. Lives in the domain
// so the app-layer shadow-settle phase can import it without reaching back into
// the orchestrator god-file (the dependency rule).

/**
 * Sentinels returned by `raceWithShadowGrace`.
 *
 *  - `SHADOW_GRACE_EXPIRED` — the wall-clock grace deadline fired OR the
 *    parent `orchCtrl.signal` aborted before the shadow promise settled.
 *    Caller emits `shadow-cut-short` with the reason it detected.
 *  - `SHADOW_RUN_FAILED`    — the shadow promise itself REJECTED. The
 *    shadow runners catch every internal failure and return a structured
 *    `{verdictOk:false, ...}` shape, so a rejection means the runner
 *    threw outside its own try/catch (programming bug, OOM, runtime
 *    tear-down). Caller emits the dedicated `shadow-run-failed` event so
 *    dashboards don't mis-attribute a real crash to a benign timeout.
 *
 * Both are unique symbols so callers can discriminate via `===` and
 * TypeScript narrows the underlying `T` correctly. Exported so unit
 * tests assert without re-declaring the sentinel.
 */
export const SHADOW_GRACE_EXPIRED = Symbol("shadow_grace_expired")
export const SHADOW_RUN_FAILED = Symbol("shadow_run_failed")

/**
 * ARC-283 Phase B1b CR-2: compose multiple `AbortSignal`s into one
 * that aborts as soon as ANY input aborts. Used at each shadow
 * dispatch site so the finally block can cancel an in-flight shadow
 * request (per-shadow controller) WITHOUT giving up the existing
 * "orch timeout also kills shadow" behavior (orchCtrl).
 *
 * Returns a fresh `AbortSignal` from an internal `AbortController`.
 * The reason of the FIRST signal to fire is forwarded onto the
 * composed signal so listeners can see WHY it aborted (grace_deadline,
 * orch_aborted, run_failed, ...). Pre-aborted inputs are honored
 * synchronously — the returned signal will already be aborted.
 *
 * No-op when no signals are provided — returns a never-aborting
 * signal (the AbortController is GC'd alongside the signal it owns).
 */
export function composeSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const ctrl = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      return ctrl.signal
    }
    s.addEventListener(
      "abort",
      () => {
        if (!ctrl.signal.aborted) ctrl.abort(s.reason)
      },
      { once: true },
    )
  }
  return ctrl.signal
}

/**
 * Wrapper around the rejection from a shadow promise so the caller
 * can emit a `shadow-run-failed` event with the underlying message.
 * Carries the failure message alongside the sentinel; using a tagged
 * shape instead of throwing keeps `raceWithShadowGrace` resolve-only
 * and preserves the prod return path.
 *
 * The discriminator field is named `__shadowRunFailed` (mangled,
 * starting with underscores) so the type-guard `isShadowRunFailed`
 * narrows reliably even when `T` itself happens to be an object. We
 * can't use plain `"kind" in shadow` because `T = ShadowRunResult`
 * is a structurally-typed object too and TypeScript can't prove the
 * tag is unique to the failure variant.
 */
export interface ShadowRunFailedOutcome {
  readonly __shadowRunFailed: typeof SHADOW_RUN_FAILED
  readonly message: string
}

/** Type-guard for the run-failed sentinel-wrapper. */
export function isShadowRunFailed(value: unknown): value is ShadowRunFailedOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "__shadowRunFailed" in value &&
    (value as { __shadowRunFailed: unknown }).__shadowRunFailed === SHADOW_RUN_FAILED
  )
}

/**
 * Races `promise` against an absolute wall-clock `deadline` (ms since
 * epoch). Used by the `handlePrReviewEnsemble` finally block to cap
 * the shadow tail at `SHADOW_FINALIZE_GRACE_MS` so prod return +
 * shadow comparison stay inside the 900s CF Queues consumer ceiling.
 *
 * Resolution table:
 *   - promise resolves first → its value
 *   - promise rejects first  → `{kind: SHADOW_RUN_FAILED, message}`
 *   - deadline fires first   → `SHADOW_GRACE_EXPIRED`
 *   - signal aborted first   → `SHADOW_GRACE_EXPIRED`
 *
 * Never rejects. CR-1: the rejection branch used to resolve with
 * `SHADOW_GRACE_EXPIRED`, which caused the finally block to emit
 * `shadow-cut-short` on a runner crash — misclassifying real failure
 * signal as a timeout. Splitting the two sentinels keeps each event
 * accurate.
 */
export function raceWithShadowGrace<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T | typeof SHADOW_GRACE_EXPIRED | ShadowRunFailedOutcome> {
  if (signal.aborted) return Promise.resolve(SHADOW_GRACE_EXPIRED)
  const remaining = Math.max(0, deadline - Date.now())
  return new Promise<T | typeof SHADOW_GRACE_EXPIRED | ShadowRunFailedOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(SHADOW_GRACE_EXPIRED)
    }, remaining)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Orchestrator was torn down — treat the same as a grace
      // expiry from the comparison's perspective (we can no longer
      // wait for the shadow). The finally consumer reads
      // `orchCtrl.signal.aborted` to label the reason on the
      // emitted `shadow-cut-short` event.
      resolve(SHADOW_GRACE_EXPIRED)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        // Shadow runners catch internally and return structured
        // failure — a rejection here means something exploded outside
        // the runner's own catch. Surface as the FAILED sentinel so
        // the finally consumer can emit `shadow-run-failed`, not
        // `shadow-cut-short`. Pre-CR-1 we incorrectly mapped this to
        // `SHADOW_GRACE_EXPIRED`, hiding runner crashes in the
        // cut-short bucket.
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        resolve({
          __shadowRunFailed: SHADOW_RUN_FAILED,
          message: err instanceof Error ? err.message : String(err),
        })
      },
    )
  })
}
