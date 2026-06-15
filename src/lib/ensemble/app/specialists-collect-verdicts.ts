// SIG-318 / SIG-369(b) — `collectSpecialistVerdicts` (+ its telemetry slice),
// lifted verbatim out of `./specialists.ts` to keep that file under the 1k
// COMPLIANCE.md §4 size budget (the SIG-386 spill-sibling pattern). Relocation
// only — the function body is byte-identical to the private helper it replaces;
// `specialists.ts` imports it. ZERO behavior change.
//
// It zips the dispatched roles with their settled `runSpecialist` results into
// `CollectedVerdict[]` (assigning stable finding ids) and pushes a per-role entry
// into the telemetry slice it's handed by reference.

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { PrReviewVerdictWithIds } from "@/src/lib/ensemble/domain/findings"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import { SPECIALIST_MODELS, type SpecialistRunResult } from "@/src/lib/ensemble/adapters/model-provider"

/**
 * The telemetry slice `collectSpecialistVerdicts` writes by reference (the
 * orchestrator's telemetry object satisfies it). It only pushes per-role entries
 * into `specialistVerdicts`; the entry shape mirrors `EnsembleTelemetry`'s.
 */
export interface CollectSpecialistVerdictsTelemetry {
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

export function collectSpecialistVerdicts(
  roles: SpecialistRole[],
  results: Array<PromiseSettledResult<SpecialistRunResult>>,
  telemetry: CollectSpecialistVerdictsTelemetry,
): CollectedVerdict[] {
  const out: CollectedVerdict[] = []
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!
    const settled = results[i]
    if (!settled || settled.status === "rejected") {
      const reason =
        settled?.status === "rejected"
          ? settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason)
          : "unknown_settlement"
      const collected: CollectedVerdict = {
        role,
        verdict: null,
        elapsedMs: 0,
        failureReason: reason,
      }
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
