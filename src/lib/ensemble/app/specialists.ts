// SIG-318 (PR 12c) — the SPECIALISTS+SYNTH seam of the PR-review orchestrator
// (app layer). This is the believability heart of `handlePrReviewEnsemble`,
// carved verbatim: the ARC-283 shadow specialist fan-out, the prod specialist
// fan-out + the SIG-235 quorum collector (a CR-hardened custom `Promise.race`
// drain whose microtask semantics are load-bearing), `collectSpecialistVerdicts`,
// the SIG-282/SIG-308 dismissal/cleared telemetry, the prod-snapshot writes for
// the shadow comparison, the ARC-284 fanout summary, and the ARC-277 coverage
// gate. It then delegates the synthesize phase to `./synthesize` and the recall
// floors to `./recall-floors`, returning either a skip-notice `exit` arm or the
// `ok` arm the adjudicate + render phases downstream consume.
//
// EXTRACT-METHOD discipline: the moved statements are byte-identical apart from
// the plumbing — the one coverage-gate bail wraps `bailWithSkipNotice` in the
// `{ kind: "exit" }` arm, and `shadowState.` container prefixes were already in
// place from PR 12b. The two god-file-private helpers it owned (`appendRoleRule`,
// `collectSpecialistVerdicts`) move with it (both private; `collectSpecialistVerdicts`
// reads the model-provider adapter, which only the app layer may import). ZERO
// behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home.
// It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { type RouterDecision } from "@/src/lib/ensemble-router"
import { type SigilixConfig, resolveAstRulesConfig, resolvePathInstructionsForChangedPaths } from "@/src/lib/sigilix-config"
import { buildSecurityFactManifest } from "@/src/lib/security-evidence-manifest"
import { evaluateScanFactDismissal } from "@/src/lib/ensemble/domain/gates/validate-security-finding"
import { buildClearedLogicCandidateTelemetry } from "@/src/lib/triage-pr-review"
import { applyLogicPromptBudget } from "@/src/lib/logic-prompt-budget"
import { withComposedTimeout } from "@/src/lib/agent-loop"
import { type SarifFinding, runSarifEvidence } from "@/src/features/sarif-evidence"
import { runAstRules } from "@/src/features/ast-rules"
import { SPECIALIST_PROMPTS } from "@/src/prompts/pr-review-specialists"
import {
  type EnsembleRunCtx,
  computeSpecialistFanoutSummary,
  emitPhaseCompleted,
  emitSpecialistFanoutSummary,
} from "@/src/lib/ensemble-perf-telemetry"
import { type SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import {
  parseShadowEnabledRoles,
  resolveShadowConfig,
} from "@/src/lib/shadow-bakeoff-config"
import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { type FindingForOverlap } from "@/src/lib/shadow-bakeoff-telemetry"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import {
  SPECIALIST_CONFIGS,
  SPECIALIST_MODELS,
  runSpecialist,
  type SpecialistRunResult,
} from "@/src/lib/ensemble/adapters/model-provider"
import {
  SPECIALIST_TIMEOUT_MS,
} from "@/src/lib/ensemble/domain/budget"
import { decideEarlyExitAction, computeDegradedCoverage } from "@/src/lib/ensemble/domain/policy"
import { assignStableFindingIds, type PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict, SynthesizerProvenance } from "@/src/lib/ensemble/domain/validation"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import { buildSynthInputVerdicts } from "@/src/lib/ensemble/domain/synth"
import type { ShadowBakeoffState } from "./shadow-settle"
import { runSynthPhase, type SynthesizeTelemetry } from "./synthesize"
import { applyRecallFloors } from "./recall-floors"
import type { ReviewMemoryFinding } from "@/src/lib/review-memory/types"

type SecurityManifest = Awaited<ReturnType<typeof buildSecurityFactManifest>>
type AstResult = Awaited<ReturnType<typeof runAstRules>>
type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
type SarifResult = Awaited<ReturnType<typeof runSarifEvidence>>
type MatchedPathInstructions = ReturnType<typeof resolvePathInstructionsForChangedPaths>
/** The synth-input verdicts produced by `buildSynthInputVerdicts(succeeded)`. */
type SynthInputVerdict = CollectedVerdict & { verdict: PrReviewVerdictWithIds }

/**
 * The telemetry slice `collectSpecialistVerdicts` writes by reference (the
 * orchestrator's telemetry object satisfies it). It only pushes per-role entries
 * into `specialistVerdicts`; the entry shape mirrors `EnsembleTelemetry`'s.
 */
interface CollectSpecialistVerdictsTelemetry {
  specialistVerdicts: Array<{
    role: SpecialistRole
    model: string
    modelUsed?: string
    attemptsUsed?: number
    verdict: PrReviewVerdictWithIds | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  }>
}

/**
 * The full telemetry slice the specialists phase mutates by reference: its own
 * writes (`specialistVerdicts`, `degradedCoverage`, `fellBack*`) plus everything
 * the delegated synthesize phase writes (it shares the same object).
 */
export interface SpecialistsTelemetry extends SynthesizeTelemetry, CollectSpecialistVerdictsTelemetry {
  degradedCoverage?: {
    rolesReturned: SpecialistRole[]
    rolesMissing: SpecialistRole[]
  }
}

export interface SpecialistsArgs<R> {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** SIG-247 Phase 1: the immutable repo.id threaded into the review-memory lookup. */
  repoId?: number
  ensembleConfig: EnsembleConfig
  /** Mutated by reference across the specialists + delegated synthesize phases. */
  telemetry: SpecialistsTelemetry
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  /** By-reference holder: the shadow fan-out + shadow-synth kick-off write into it. */
  shadowState: ShadowBakeoffState
  /** The skip-notice bail closure; returns the orchestrator's `EnsembleResult` as `R`. */
  bailWithSkipNotice: (reason: SkipNoticeReason, opts?: { dispatchedRoles?: readonly string[] }) => Promise<R>
  sigilixConfig: SigilixConfig
  router: RouterDecision
  /** Per-role initial specialist message (cached by the orchestrator). */
  messageForRole: (role: SpecialistRole) => string
  securityManifest: SecurityManifest
  diff: string
  matchedPathInstructions: MatchedPathInstructions
  stackBlock: string
  graphCtxForPrompt: string
  dynamicEvidenceBlockForPrompt: string
  astResult: AstResult
  astRulesConfig: AstRulesConfig
  sarifFindings: readonly SarifFinding[]
  sarifResult: SarifResult
  filePaths: string[]
}

export type SpecialistsPhaseResult<R> =
  | { kind: "exit"; result: R }
  | {
      kind: "ok"
      succeeded: CollectedVerdict[]
      degradedCoverage: { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } | null
      synthInputVerdicts: SynthInputVerdict[]
      /** NON-NULL narrowed: the synth produced a usable verdict + provenance. */
      synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
      shadowMemoriesForPhase3: ReviewMemoryFinding[]
      effectiveSynthVerdict: PrReviewVerdict
      effectiveSynthProvenance: SynthesizerProvenance
    }

export async function runSpecialistsAndSynthesize<R>(a: SpecialistsArgs<R>): Promise<SpecialistsPhaseResult<R>> {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
    repoId,
    ensembleConfig,
    telemetry,
    perfCtx,
    orchCtrl,
    shadowState,
    bailWithSkipNotice,
    sigilixConfig,
    router,
    messageForRole,
    securityManifest,
    diff,
    matchedPathInstructions,
    stackBlock,
    graphCtxForPrompt,
    dynamicEvidenceBlockForPrompt,
    astResult,
    astRulesConfig,
    sarifFindings,
    sarifResult,
    filePaths,
  } = a
    // ARC-283 Phase B1b — shadow specialist fan-out. Fires BEFORE the
    // prod Promise.allSettled below so both lineups run in parallel
    // (NOT serially). Shadow shares prod's `orchCtrl.signal` — when
    // the outer orchestrator times out, shadow aborts with it. No
    // new wall-clock budget. The shadow promise never throws (the
    // runner catches + structures every failure path) but the
    // `finally`-block consumer still wraps the await in try/catch
    // to defend the prod return path.
    const shadowEnabledRoles = parseShadowEnabledRoles(env.SHADOW_BAKEOFF_ROLES)
    for (const role of router.specialists) {
      const shadowConfig = resolveShadowConfig(role, shadowEnabledRoles)
      if (shadowConfig === null) continue
      // ARC-283 Phase B1b CR-2: per-shadow AbortController, composed
      // with orchCtrl. Either source can abort the in-flight HTTP
      // request: orchCtrl when the outer 895s wall fires, the
      // per-shadow controller when the finally block decides the
      // shadow is past its grace cap. Without the per-shadow
      // controller, the cut-short emit was a pure log line and the
      // request kept consuming provider capacity.
      const shadowCtrl = new AbortController()
      shadowState.abortControllers.set(role, shadowCtrl)
      const composedSignal = composeSignals(orchCtrl.signal, shadowCtrl.signal)
      const shadowPromise = runShadowSpecialist({
        role,
        shadowConfig,
        apiKey: env.OLLAMA_API_KEY,
        systemPrompt: SPECIALIST_PROMPTS[role],
        // SIG-113: pick per-role initial message — tests specialist
        // gets the testing-evidence block, others get the
        // classification block.
        userMessage: appendRoleRule(messageForRole(role), role, sigilixConfig),
        chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
        signal: composedSignal,
        perfCtx,
      }).finally(() => {
        // Settled (success OR runner-caught failure) — clear the
        // controller so the finally block's still-pending sweep
        // doesn't re-abort an already-finished call. Doesn't drop
        // the promise itself; the finally block still awaits to
        // emit comparison telemetry.
        shadowState.abortControllers.delete(role)
      })
      shadowState.specialistPromises.set(role, shadowPromise)
    }

    // ARC-284: track per-specialist start time so the fanout summary
    // can name the slowest role. The fan-out below waits for ALL to
    // settle by default; SIG-235 quorum collector below opt-in
    // early-exits when `N-1` of `N` succeed.
    const fanoutStartMs = Date.now()
    const perSpecialistStart = new Map<string, number>()
    const perSpecialistEnd = new Map<string, number>()
    for (const role of router.specialists) perSpecialistStart.set(role, Date.now())

    // SIG-236 — parse the logic-prompt-budget mode once per ensemble
    // so the per-role map below doesn't re-read env. `off` (the
    // default) skips the measurement+emit entirely. `shadow` /
    // `enforce` emit `logic-prompt-budget` telemetry once per
    // ensemble run with the logic role's full prompt size + per-
    // section breakdown.
    const logicPromptBudgetMode = ensembleConfig.flags.logicPromptBudgetMode

    // SIG-235 — min-specialists early exit. Build per-role
    // AbortControllers (mirroring the shadow path above) so the
    // quorum collector can cancel a single laggard's outstanding
    // attempts without affecting the others. composeSignals fires on
    // EITHER orchCtrl OR the per-role controller — same pattern as
    // the shadow path so the ladder cancels cleanly mid-attempt.
    const earlyExitMode = ensembleConfig.flags.minSpecialistsEarlyExitMode
    const prodSpecialistAbortControllers = new Map<SpecialistRole, AbortController>()
    // Tracks roles whose perSpecialistEnd has been frozen at the early-
    // exit cancel point. Used by the `.finally()` below to skip
    // overwriting an already-recorded end-time if the cancelled
    // promise eventually settles (race-hardening for any future await
    // between fan-out and `computeSpecialistFanoutSummary`).
    const earlyExitCancelledRoles = new Set<SpecialistRole>()
    type RolePromise = {
      role: SpecialistRole
      ctrl: AbortController
      promise: Promise<PromiseSettledResult<SpecialistRunResult>>
    }
    const rolePromises: RolePromise[] = router.specialists.map((role) => {
      const ctrl = new AbortController()
      prodSpecialistAbortControllers.set(role, ctrl)
      const composedSignal = composeSignals(orchCtrl.signal, ctrl.signal)
      // SIG-236: build the initialMessage ONCE per role so the
      // logic-prompt-budget measurement sees exactly what runSpecialist
      // sees, and we don't waste a second messageForRole + appendRoleRule
      // pass.
      let initialMessage = appendRoleRule(messageForRole(role), role, sigilixConfig)
      if (role === "logic") {
        // SIG-287/SIG-236: off→passthrough, shadow→measure-only, enforce→TRIM
        // the logic prompt to the cap (returns the prompt the model receives)
        // so logic stops timing out on its uniquely-large prompt. Belt-and-
        // suspenders try/catch (CR catch on PR #191): `applyLogicPromptBudget`
        // already fails open internally, but instrumentation MUST NOT break the
        // fan-out even if a future refactor removes the inner guard — on any
        // throw, fall back to the un-trimmed prompt (logic still runs).
        try {
          initialMessage = applyLogicPromptBudget({
            mode: logicPromptBudgetMode,
            prompt: initialMessage,
            owner, repo, prNumber, headSha,
          })
        } catch (err) {
          console.warn(JSON.stringify({
            event: "logic-prompt-budget-call-site-error",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            message: err instanceof Error ? err.message : String(err),
          }))
        }
      }
      const promise = withComposedTimeout(
        // Use the composed signal `withComposedTimeout` provides — it
        // aborts on EITHER the per-specialist 270s timer OR the outer
        // orch abort OR the per-role early-exit abort. Passing
        // `orchCtrl.signal` directly only cancels the await wrapper,
        // leaving the in-flight model fetch alive until the outer
        // 490s wall fires (CR catch on PR #42).
        (signal) => runSpecialist({
          role,
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: SPECIALIST_PROMPTS[role],
          // SIG-113: tests specialist gets the testing-evidence
          // block; other specialists get the classification block.
          initialMessage,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal,
          // ARC-283 Phase B1b: thread the orchestrator's perfCtx
          // through so per-attempt `model-attempt-completed` events
          // share correlation fields with the surrounding ensemble
          // telemetry.
          perfCtx,
        }),
        SPECIALIST_TIMEOUT_MS,
        composedSignal,
      ).finally(() => {
        // M2 race-hardening: only record end-time if the role's
        // end-time wasn't already frozen by the early-exit synthetic
        // entry. Today's flow is synchronous from fan-out to fanout-
        // summary so the race doesn't fire, but this prevents a
        // future await from triggering a late-set overwrite.
        if (!earlyExitCancelledRoles.has(role)) {
          perSpecialistEnd.set(role, Date.now())
        }
        prodSpecialistAbortControllers.delete(role)
      }).then(
        (value): PromiseSettledResult<SpecialistRunResult> => ({ status: "fulfilled", value }),
        (reason): PromiseSettledResult<SpecialistRunResult> => ({ status: "rejected", reason }),
      )
      return { role, ctrl, promise }
    })

    // SIG-235 quorum collector. Drains role promises one at a time;
    // when `N-1` of `N` have returned a non-null verdict AND mode is
    // "on", cancels the remaining role(s) and continues to synth.
    // Late verdicts from cancelled roles are logged + discarded.
    //
    // Modes:
    //   off    — pure Promise.all (legacy semantics, default)
    //   shadow — wait for all, but log when early-exit WOULD have fired
    //   on     — cancel laggard + proceed to synth as soon as N-1 succeed
    let specialistResults: PromiseSettledResult<SpecialistRunResult>[]
    let earlyExitFiredAtMs: number | null = null
    let cancelledRolesAtExit: SpecialistRole[] = []
    let earlyExitWouldFireAtMs: number | null = null
    // SIG-236: log the protected-role early-exit suppression at most once.
    let earlyExitProtectedLogged = false
    if (earlyExitMode === "off") {
      // Legacy: wait for everyone.
      specialistResults = await Promise.all(rolePromises.map((rp) => rp.promise))
    } else {
      const settledResults = new Map<SpecialistRole, PromiseSettledResult<SpecialistRunResult>>()
      // Each pending promise carries its role so Promise.race can
      // identify which one resolved without an index lookup.
      //
      // CodeRabbit catch (Major): the tracked-promise SELF-REMOVES
      // from `pending` in its `.then(...)` (microtask 1) so by the
      // time `Promise.race(...)` resumes the loop (microtask 2),
      // `pending` accurately reflects "still in-flight" — never
      // "in-flight OR just-settled-this-tick-but-not-yet-consumed."
      // Without this, a microtask burst where multiple specialists
      // resolve simultaneously can race-pick role A, leave already-
      // resolved roles B/C in `pending`, hit the early-exit threshold,
      // abort B/C via their AbortControllers, and synthesize null
      // verdicts for them — silently dropping real verdicts.
      const pending = new Map<SpecialistRole, Promise<{ role: SpecialistRole; result: PromiseSettledResult<SpecialistRunResult> }>>()
      for (const rp of rolePromises) {
        const tracked = rp.promise.then((result) => {
          pending.delete(rp.role)
          return { role: rp.role, result }
        })
        pending.set(rp.role, tracked)
      }
      const N = router.specialists.length
      const quorumThreshold = N - 1
      while (pending.size > 0) {
        const settled = await Promise.race(pending.values())
        // `pending.delete(settled.role)` already happened in the
        // `.then` above — `settledResults.set` records the result.
        settledResults.set(settled.role, settled.result)

        const succeededCount = Array.from(settledResults.values()).filter(
          (r) => r.status === "fulfilled" && r.value.verdict !== null,
        ).length

        // SIG-236: logic is the intentional long-pole (rich graph+symbol context,
        // ~110s per-attempt). It is a PROTECTED role — early-exit must NOT cancel
        // it, or flipping early-exit to "on" would silently re-break logic
        // availability (the regression this fix closes). Early-exit can still fire
        // to drop a genuinely stuck non-logic role. decideEarlyExitAction is the
        // pure, unit-tested decision.
        const logicProtectedPending =
          router.specialists.includes("logic") && pending.has("logic")
        const earlyExitAction = decideEarlyExitAction({
          mode: earlyExitMode,
          succeededCount,
          quorumThreshold,
          pendingCount: pending.size,
          logicProtectedPending,
        })
        if (earlyExitAction !== "none") {
          const nowMs = Date.now()
          if (earlyExitAction === "suppress-protected") {
            // Keep awaiting logic — its 110s per-attempt cap bounds it, not
            // early-exit. Fall through (no break) to the next Promise.race.
            if (!earlyExitProtectedLogged) {
              earlyExitProtectedLogged = true
              console.log(JSON.stringify({
                event: "ensemble-early-exit-suppressed-protected-role",
                owner, repo, prNumber,
                mode: "on",
                protectedRole: "logic",
                succeededRoles: Array.from(settledResults.entries())
                  .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
                  .map(([role]) => role),
                pendingRoles: Array.from(pending.keys()),
                elapsedMsSinceFanoutStart: nowMs - fanoutStartMs,
              }))
            }
          } else if (earlyExitAction === "cancel") {
            earlyExitFiredAtMs = nowMs
            cancelledRolesAtExit = Array.from(pending.keys())
            // Abort the laggards' AbortControllers — composedSignal
            // propagates the cancel into the in-flight attempt.
            for (const rp of rolePromises) {
              if (pending.has(rp.role)) {
                rp.ctrl.abort()
                // Background watcher for the late-verdict-discard
                // event. Doesn't block the synth path.
                rp.promise
                  .then((result) => {
                    if (result.status === "fulfilled" && result.value.verdict !== null) {
                      console.log(JSON.stringify({
                        event: "ensemble-late-verdict-discarded",
                        owner, repo, prNumber,
                        role: rp.role,
                        attemptsUsed: result.value.attemptsUsed,
                        modelUsed: result.value.modelUsed,
                      }))
                    }
                  })
                  .catch(() => { /* discard cancellation errors */ })
              }
            }
            break
          } else if (earlyExitAction === "shadow-mark" && earlyExitWouldFireAtMs === null) {
            // Shadow: log the would-fire and keep awaiting. Only the
            // FIRST time the threshold is crossed (subsequent settles
            // would also satisfy `>= quorumThreshold` and we don't
            // need duplicate events).
            earlyExitWouldFireAtMs = nowMs
            console.log(JSON.stringify({
              event: "ensemble-min-specialists-early-exit-would-fire",
              owner, repo, prNumber,
              mode: "shadow",
              succeededRoles: Array.from(settledResults.entries())
                .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
                .map(([role]) => role),
              pendingRoles: Array.from(pending.keys()),
              dispatchedRoles: router.specialists,
              elapsedMsSinceFanoutStart: nowMs - fanoutStartMs,
            }))
          }
        }
      }

      // Reassemble into router.specialists order so downstream
      // `collectSpecialistVerdicts(roles, results, ...)` zips correctly.
      // Cancelled-but-not-settled roles (only possible in "on" mode
      // after early-exit) get a synthetic null-verdict entry so the
      // [DEGRADED COVERAGE] block fires the same way as a legitimate
      // ladder-exhaust failure.
      //
      // `failureReason: "early_exit_aborted"` is intentional — the
      // collector's `timedOut: /abort/i || /timeout/i` regex at
      // `collectSpecialistVerdicts` line ~6327 catches it, so these
      // cancellations land in the same telemetry bucket as legitimate
      // timer/parent-signal aborts. Lets the `/metrics/validation`
      // dashboard treat early-exit cancels like timeouts (which they
      // structurally are — primary started but was forcibly stopped).
      //
      // `attemptsUsed: 1` is a conservative MINIMUM (CR catch). The
      // cancelled promise may have spent 1-3 attempts (primary +
      // optional retry + optional fallback) before the cancel
      // propagated, but synth-firing immediately means we can't
      // await the real count without losing the wall-time win that
      // motivates early-exit. Charging 1 acknowledges the primary
      // definitely started; undercount risk on retry/fallback paths
      // is bounded by the role's `maxAttempts()` and the daily-budget
      // gate already has slack from the worst-case
      // `MAX_CALLS_PER_ENSEMBLE_RUN` reservation.
      specialistResults = router.specialists.map((role) => {
        const r = settledResults.get(role)
        if (r !== undefined) return r
        earlyExitCancelledRoles.add(role)
        const startMs = perSpecialistStart.get(role) ?? Date.now()
        const nowMs = Date.now()
        perSpecialistEnd.set(role, nowMs)
        return {
          status: "fulfilled" as const,
          value: {
            verdict: null,
            modelUsed: SPECIALIST_CONFIGS[role].primary,
            attemptsUsed: 1,
            elapsedMs: nowMs - startMs,
            failureReason: "early_exit_aborted",
          } satisfies SpecialistRunResult,
        }
      })

      if (earlyExitFiredAtMs !== null) {
        const succeededRoles = Array.from(settledResults.entries())
          .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
          .map(([role]) => role)
        console.log(JSON.stringify({
          event: "ensemble-min-specialists-early-exit-fired",
          owner, repo, prNumber,
          mode: "on",
          succeededRoles,
          cancelledRoles: cancelledRolesAtExit,
          dispatchedRoles: router.specialists,
          elapsedMsAtFire: earlyExitFiredAtMs - fanoutStartMs,
        }))
      }
    }
    const fanoutEndMs = Date.now()
    emitPhaseCompleted(perfCtx, "specialist_fanout", fanoutStartMs, fanoutEndMs)

    // Collect specialist verdicts (with stable IDs assigned).
    const specialistVerdicts = collectSpecialistVerdicts(
      router.specialists,
      specialistResults,
      telemetry,
    )

    // SIG-282 Phase 2: reconcile the security specialist's explicit
    // false-positive dismissals against the manifest and emit telemetry.
    // A dismissal is ACCEPTED only when its evidenceId resolves AND the
    // underlying fact is a dismissible (warn-level) candidate; a dismissal
    // aimed at a high-confidence provider hit is REJECTED + logged — a
    // possible real-secret wave-off worth a human's attention. This is
    // observability + a safety rail; Phase 1's framing already keeps the
    // false-positive finding from being emitted.
    const securityDismissals =
      specialistVerdicts.find((v) => v.role === "security")?.verdict?.dismissedScanFacts ?? []
    for (const d of securityDismissals) {
      const decision = evaluateScanFactDismissal(d, securityManifest.manifest)
      console.log(JSON.stringify({
        event: "pr-review-scan-fact-dismissed",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        evidenceId: d.evidenceId,
        ruleId: decision.ruleId,
        accepted: decision.accepted,
        rejectReason: decision.accepted ? null : decision.reason,
      }))
    }

    // SIG-308 Phase 2: telemeter the logic specialist's cleared candidates —
    // correctness concerns it refuted against an in-code mitigation instead of
    // emitting a finding. There is no manifest to reconcile against (logic
    // candidates are self-generated), so this is pure observability of the
    // cleared-rate; the recall safety rail is the Phase 3 backstop. Phase 1's
    // framing already keeps the refuted finding from being emitted.
    const clearedLogicCandidates =
      specialistVerdicts.find((v) => v.role === "logic")?.verdict?.clearedLogicCandidates ?? []
    for (const ev of buildClearedLogicCandidateTelemetry(clearedLogicCandidates, {
      owner, repo, prNumber, headSha,
    })) {
      console.log(JSON.stringify(ev))
    }

    // ARC-283 Phase B1b — snapshot per-role prod outcomes for the
    // shadow comparison emit in `finally`. Only writes for roles
    // that have a shadow promise queued; for everyone else we'd
    // never emit a comparison anyway. Reading from `specialistVerdicts`
    // (not `specialistResults`) so we get the same shape downstream
    // telemetry sees (stable-id-assigned verdict, dedupe-corrected
    // modelUsed). Findings are projected to the overlap-helper's
    // shape so the `finally` block stays a thin wrapper.
    for (const v of specialistVerdicts) {
      if (!shadowState.specialistPromises.has(v.role)) continue
      const findings: FindingForOverlap[] = v.verdict
        ? v.verdict.findings.map((f) => ({
            path: f.path,
            line: f.line,
            category: f.category,
            score: f.score,
          }))
        : []
      shadowState.prodSnapshots.set(v.role, {
        verdictOk: v.verdict !== null,
        modelUsed: v.modelUsed ?? SPECIALIST_CONFIGS[v.role].primary,
        attemptsUsed: v.attemptsUsed ?? 0,
        elapsedMs: v.elapsedMs,
        findings,
      })
    }

    // ARC-284 (Sigilix PR #95 catch): specialist-fanout-summary
    // computation moved into `computeSpecialistFanoutSummary` so the
    // slowestRole / fallbacksUsed / totalAttemptsUsed logic is unit-
    // testable. The orchestrator just maps its CollectedVerdict[] +
    // per-role timing into the helper's input shape.
    //
    // Emitted BEFORE the coverage / quorum gate below so the event
    // fires even on the "all specialists failed" bail path.
    {
      const summary = computeSpecialistFanoutSummary({
        dispatchedRoles: router.specialists,
        inputs: specialistVerdicts.map((v) => ({
          role: v.role,
          verdictOk: v.verdict !== null,
          attemptsUsed: v.attemptsUsed,
          modelUsed: v.modelUsed,
          fallbackModel: SPECIALIST_CONFIGS[v.role].fallback,
        })),
        perRoleStartMs: perSpecialistStart,
        perRoleEndMs: perSpecialistEnd,
        fanoutStartMs,
        fanoutEndMs,
      })
      emitSpecialistFanoutSummary(perfCtx, summary)
    }

    // ─── Coverage check (ARC-277) ──────────────────────────────
    //
    // Pre-ARC-277, this was a quorum gate that bailed to `skipped`
    // whenever fewer than min(2, dispatched.length) specialists
    // returned. The fall-back to Phase 3 plus the silent-success
    // bug chain that ARC-258 / ARC-275 chased made that gate the
    // single biggest contributor to "Sigilix went silent" reports.
    //
    // New contract:
    //   - 0/N succeeded: still bail to `skipped` (synth has
    //     nothing to merge from; will revisit in ARC-278 once
    //     synth retry + comment fallback land).
    //   - 1 ≤ succeeded < dispatched: continue to synth with a
    //     `[DEGRADED COVERAGE]` prompt block + structured
    //     telemetry. `checkQuorum` is no longer the gate.
    //   - succeeded === dispatched: full coverage, no prompt
    //     change, no degraded-coverage telemetry.
    const succeeded = specialistVerdicts.filter((v) => v.verdict !== null)
    if (succeeded.length === 0) {
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "specialists_all_failed"
      // CR Minor catch on PR #92: name the roles the router
      // actually dispatched, since `specialists_all_failed` fires
      // whether 4/4 or 1/1 specialists failed.
      return { kind: "exit" as const, result: await bailWithSkipNotice("specialists_all_failed", {
        dispatchedRoles: router.specialists,
      }) }
    }
    const degradedCoverage = succeeded.length < router.specialists.length
      ? computeDegradedCoverage(router.specialists, succeeded.map((v) => v.role))
      : null
    if (degradedCoverage) {
      // Record the partial-coverage telemetry but DON'T bail. Synth
      // runs on the partial input + a degraded-coverage block in
      // the prompt.
      telemetry.fellBackReason = "specialists_degraded"
      telemetry.degradedCoverage = degradedCoverage
      console.log(JSON.stringify({
        event: "ensemble-specialists-degraded",
        owner, repo, prNumber,
        roles_returned: degradedCoverage.rolesReturned,
        roles_missing: degradedCoverage.rolesMissing,
      }))
    }

    // ─── SIG-228 Phase 3c: synth-bypass single-specialist hot path ─
    //
    // When the dispatcher returns exactly 1 specialist AND none of
    // that specialist's findings have `score >= 4` (major/critical),
    // skip the synthesizer LLM round-trip entirely. The specialist's
    // verdict IS the submission verdict — there's no cross-specialist
    // consensus to compute, and no major-severity finding that
    // benefits from synth-level rewriting.
    //
    // Saves ~15-25s on the hot path (the typical synth elapsed window
    // on `gpt-oss:120b-cloud`). Flag-gated behind
    // `OPENCLAW_SYNTH_BYPASS_ENABLED`; default-off in dev/test,
    // default-on in production (wrangler.toml).
    //
    // Reaches here only AFTER the `succeeded.length === 0` bail above
    // (line ~2894) — the bypass branch's `synthInputVerdicts[0]!`
    // assertion is safe by construction. If the order is ever flipped,
    // re-add a guard on the bypass branch.
    //
    // `synthInputVerdicts` is hoisted out so both the bypass path AND
    // the synth path read the same truncated verdicts. `truncateVerdictToTokens`
    // sorts findings by score DESC and pops from the end, so major
    // findings always survive truncation as long as any space remains.
    // The bypass eligibility check below intentionally reads from the
    // UNTRUNCATED `succeeded` array (not `synthInputVerdicts`) so that a
    // hypothetical extreme-token-pressure case dropping a `score >= 4`
    // finding can't sneak past the bypass gate — CR phase-end catch on
    // PR #188.
    const synthInputVerdicts = buildSynthInputVerdicts(succeeded)

    // SIG-318 (PR 12c): the SYNTHESIZE phase (synth-bypass / synth + retry ladder
    // + telemetry + parse-fail bail + summary) moved to ensemble/app/synthesize.
    // It mutates `telemetry` + `shadowState` by reference; on any of its three
    // skip-notice bails it returns the `exit` arm, which we forward.
    const synthPhase = await runSynthPhase({
      env,
      owner,
      repo,
      prNumber,
      ...(repoId !== undefined ? { repoId } : {}),
      telemetry,
      perfCtx,
      orchCtrl,
      shadowState,
      bailWithSkipNotice,
      sigilixConfig,
      diff,
      matchedPathInstructions,
      stackBlock,
      graphCtxForPrompt,
      dynamicEvidenceBlockForPrompt,
      astResult,
      astRulesConfig,
      sarifFindings,
      sarifResult,
      filePaths,
      shadowEnabledRoles,
      router,
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthBypassEnabled: ensembleConfig.flags.synthBypassEnabled,
    })
    if (synthPhase.kind === "exit") return { kind: "exit", result: synthPhase.result }

    // SIG-318 (PR 12c): the recall floors (SIG-317 truncation recovery / SIG-351
    // source floor / SIG-287 degraded floor / SIG-317-step-6 AST-emit floor)
    // moved to ensemble/app/recall-floors. They take the NON-NULL synth verdict +
    // provenance the synth phase produced and return the (still non-null)
    // effective pair the adjudicate phase downstream consumes.
    const { effectiveSynthVerdict, effectiveSynthProvenance } = applyRecallFloors({
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      synthVerdict: synthPhase.synthVerdict,
      synthProvenance: synthPhase.synthProvenance,
      synthInputVerdicts,
      astResult,
      degradedCoverage,
    })

    return {
      kind: "ok" as const,
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthOutput: { verdict: synthPhase.synthVerdict, provenance: synthPhase.synthProvenance },
      shadowMemoriesForPhase3: synthPhase.shadowMemoriesForPhase3,
      effectiveSynthVerdict,
      effectiveSynthProvenance,
    }
}

function appendRoleRule(
  baseMessage: string,
  role: SpecialistRole,
  config: SigilixConfig,
): string {
  const rule = config.rules?.[role]
  if (!rule) return baseMessage
  return `${baseMessage}\n\n[REPO RULES — ${role.toUpperCase()} (from sigilix.json)]\n${rule}`
}

function collectSpecialistVerdicts(
  roles: SpecialistRole[],
  results: Array<PromiseSettledResult<SpecialistRunResult>>,
  telemetry: CollectSpecialistVerdictsTelemetry,
): CollectedVerdict[] {
  const out: CollectedVerdict[] = []
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!
    const settled = results[i]
    if (!settled || settled.status === "rejected") {
      const reason = settled?.status === "rejected"
        ? (settled.reason instanceof Error ? settled.reason.message : String(settled.reason))
        : "unknown_settlement"
      const collected: CollectedVerdict = { role, verdict: null, elapsedMs: 0, failureReason: reason }
      out.push(collected)
      // No attemptsUsed available — the wrapper threw before runSpecialist
      // returned, so we don't know how many attempts ran. Leave undefined
      // so finalize()'s defensive `?? 1` kicks in.
      telemetry.specialistVerdicts.push({
        role,
        model: SPECIALIST_MODELS[role],
        verdict: null,
        failureReason: reason,
        elapsedMs: 0,
        timedOut: reason.includes("timeout") || reason.includes("aborted"),
      })
      continue
    }
    const value = settled.value
    if (!value.verdict) {
      const collected: CollectedVerdict = {
        role,
        verdict: null,
        elapsedMs: value.elapsedMs,
        attemptsUsed: value.attemptsUsed,
        modelUsed: value.modelUsed,
      }
      if (value.failureReason) collected.failureReason = value.failureReason
      if (value.failureRawAnswer) collected.failureRawAnswer = value.failureRawAnswer
      out.push(collected)
      // Phase 4a.2: aborts (timer- or parent-signal-driven) now reach
      // this branch via withComposedTimeout's grace window — the
      // factory's structured wrapFailure(reason="aborted", ...) flows
      // through Promise.allSettled as a fulfilled value with verdict
      // null. Derive timedOut from the reason string so timer-driven
      // aborts stay visible in telemetry. The reason can be the
      // canonical "aborted" (signal.aborted check between attempts),
      // a DOMException message like "The operation was aborted." (when
      // fetch threw mid-attempt), or `fallback_failed: ... aborted`
      // (primary AND fallback both aborted) — a single /abort/i regex
      // captures all three.
      const reason = value.failureReason ?? ""
      const telEntry: CollectSpecialistVerdictsTelemetry["specialistVerdicts"][number] = {
        role,
        model: SPECIALIST_MODELS[role],
        modelUsed: value.modelUsed,
        attemptsUsed: value.attemptsUsed,
        verdict: null,
        elapsedMs: value.elapsedMs,
        timedOut: /abort/i.test(reason) || /timeout/i.test(reason),
      }
      if (value.failureReason) telEntry.failureReason = value.failureReason
      if (value.failureRawAnswer) telEntry.failureRawAnswer = value.failureRawAnswer
      telemetry.specialistVerdicts.push(telEntry)
      continue
    }
    const withIds = assignStableFindingIds(role, value.verdict)
    out.push({
      role,
      verdict: withIds,
      elapsedMs: value.elapsedMs,
      attemptsUsed: value.attemptsUsed,
      modelUsed: value.modelUsed,
    })
    telemetry.specialistVerdicts.push({
      role,
      model: SPECIALIST_MODELS[role],
      modelUsed: value.modelUsed,
      attemptsUsed: value.attemptsUsed,
      verdict: withIds,
      elapsedMs: value.elapsedMs,
      timedOut: false,
    })
  }
  return out
}
