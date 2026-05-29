// SIG-287 / SIG-114 — recall alarm (the smoke detector).
//
// The bare-approve regression (#207–#218) ran for ~12 consecutive PRs
// because we measure PRECISION (zero P0/P1 false positives) but never
// RECALL — a bot that silently stops finding things scores a *perfect*
// precision the whole time. This detector watches recent review
// telemetry for the signature of a silently-degraded reviewer and fires
// a loud `review-recall-alarm` so the next regression is caught in one
// cron tick (≤6h) instead of a dozen PRs.
//
// Two streak signals, both read straight off `ensemble-review-telemetry`:
//   - logic-degraded streak  — consecutive recent PRs whose review ran
//     with `logic` (the primary bug-finder) missing from coverage. This
//     is the SIG-287 root signature (logic timing out every review).
//   - synth-zero-finding streak — consecutive recent PRs where the synth
//     emitted zero findings. A healthy reviewer finds *something* across
//     several substantive PRs; a long shutout is suspicious.
//
// Pure: the cron supplies already-parsed, deduped-by-PR, newest-first
// outcomes; this decides whether to alarm. No I/O.

/** Consecutive logic-degraded PRs that trips the alarm. */
export const RECALL_LOGIC_DEGRADED_ALARM_STREAK = 3
/** Consecutive zero-finding-synth PRs that trips the alarm. */
export const RECALL_SYNTH_ZERO_FINDING_ALARM_STREAK = 5

export interface RecallReviewOutcome {
  prNumber: number
  /** `logic` was in the dispatched set but not in coverage (degraded). */
  logicMissing: boolean
  /** Findings the synthesizer emitted (pre-floor/validation). */
  synthFindingCount: number
}

export interface RecallAlarmFiring {
  kind: "logic-degraded-streak" | "synth-zero-finding-streak"
  streak: number
  threshold: number
  prNumbers: number[]
}

export interface RecallAlarmConfig {
  logicDegradedStreak?: number
  synthZeroFindingStreak?: number
}

export interface RecallAlarmResult {
  logicDegradedStreak: number
  synthZeroFindingStreak: number
  alarms: RecallAlarmFiring[]
}

/** The subset of an `ensemble-review-telemetry` record this detector reads. */
export interface RawReviewTelemetry {
  prNumber?: unknown
  synthesizer?: { verdict?: { findings?: unknown } } | null
  degradedCoverage?: { rolesMissing?: unknown } | null
}

/**
 * Map a raw telemetry record to a recall outcome, or `null` if it isn't a
 * real completed ensemble review (merge-guard / pre-synth bail records have
 * no `synthesizer.verdict.findings` and are skipped — they aren't reviews
 * whose recall we can judge).
 */
export function recallOutcomeFromTelemetry(rec: RawReviewTelemetry): RecallReviewOutcome | null {
  if (typeof rec.prNumber !== "number") return null
  const synthFindings = rec.synthesizer?.verdict?.findings
  if (!Array.isArray(synthFindings)) return null
  const rolesMissing = rec.degradedCoverage?.rolesMissing
  const logicMissing = Array.isArray(rolesMissing) && rolesMissing.includes("logic")
  return { prNumber: rec.prNumber, logicMissing, synthFindingCount: synthFindings.length }
}

/**
 * Count the leading run of `outcomes` (newest-first) for which `pred`
 * holds, returning the count + the PR numbers in the run.
 */
function leadingStreak(
  outcomes: readonly RecallReviewOutcome[],
  pred: (o: RecallReviewOutcome) => boolean,
): { streak: number; prNumbers: number[] } {
  const prNumbers: number[] = []
  for (const o of outcomes) {
    if (!pred(o)) break
    prNumbers.push(o.prNumber)
  }
  return { streak: prNumbers.length, prNumbers }
}

/**
 * Decide whether recent reviews look like a silently-degraded reviewer.
 * `outcomes` MUST be newest-first and deduped to one entry per PR.
 */
export function detectRecallAlarm(
  outcomes: readonly RecallReviewOutcome[],
  config: RecallAlarmConfig = {},
): RecallAlarmResult {
  const logicThreshold = config.logicDegradedStreak ?? RECALL_LOGIC_DEGRADED_ALARM_STREAK
  const synthThreshold = config.synthZeroFindingStreak ?? RECALL_SYNTH_ZERO_FINDING_ALARM_STREAK

  const logic = leadingStreak(outcomes, (o) => o.logicMissing)
  const synth = leadingStreak(outcomes, (o) => o.synthFindingCount === 0)

  const alarms: RecallAlarmFiring[] = []
  if (logic.streak >= logicThreshold) {
    alarms.push({
      kind: "logic-degraded-streak",
      streak: logic.streak,
      threshold: logicThreshold,
      prNumbers: logic.prNumbers,
    })
  }
  if (synth.streak >= synthThreshold) {
    alarms.push({
      kind: "synth-zero-finding-streak",
      streak: synth.streak,
      threshold: synthThreshold,
      prNumbers: synth.prNumbers,
    })
  }

  return { logicDegradedStreak: logic.streak, synthZeroFindingStreak: synth.streak, alarms }
}

// SIG-287 validation: temporary marker to trigger an open-PR review with the
// enforce logic-prompt trim live. This PR is throwaway — do not merge.
