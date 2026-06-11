// SIG-119: thin typed wrappers for the single global ValidationMetricsDO.
// Resolves the fixed DO stub and forwards record/query RPCs. Callers own the
// non-fatal try/catch (telemetry must never break a review or a request).
//
// SIG-173: dismissal-reason rollups share the same DO (it's the natural
// per-reason counter surface) but flow through dedicated record/query
// helpers so callers don't have to know about the synthetic-gate encoding.

import type { Env } from "@/src/shared/types/env"
import type {
  ValidationMetricsDO,
  RecordBatchArgs,
  ValidationMetricsQuery,
  DismissalMetricsQuery,
  RecordRepeatFpArgs,
  RepeatFpMetricsQuery,
} from "@/src/do/validation-metrics"
export type { RepeatFpEvent } from "@/src/do/validation-metrics"
import type { DismissReason } from "./dismiss-reasons"

// All validator telemetry funnels into ONE DO instance — write volume is one
// row per rejected finding, nowhere near a sharding threshold.
const GLOBAL_INSTANCE = "global"

function metricsStub(env: Env): DurableObjectStub<ValidationMetricsDO> {
  const ns = env.VALIDATION_METRICS_DO as unknown as DurableObjectNamespace<ValidationMetricsDO>
  return ns.get(ns.idFromName(GLOBAL_INSTANCE))
}

export async function recordValidationMetrics(env: Env, args: RecordBatchArgs): Promise<void> {
  await metricsStub(env).recordBatch(args)
}

export function queryValidationMetrics(env: Env, windowDays: number): Promise<ValidationMetricsQuery> {
  // Direct return — no `async` because there's no `await` here. The DO RPC
  // already returns a Promise, so wrapping in `async` would only add a
  // microtask hop. Callers `await` either way (sync throws from
  // `metricsStub` still surface to the caller's `try/catch` around the
  // `await` call site).
  return metricsStub(env).query({ windowDays })
}

/**
 * SIG-173: record one `@sigilix dismiss <reason>` event. The DO's
 * `recordBatch` skips the `last_seen_pr` update for the dismissal path so
 * a dismiss never pollutes the validator-rejection PR-head tracker; the
 * synthetic owner/repo/prNumber placeholders below exist only to satisfy
 * `RecordBatchArgs`'s shape.
 */
export async function recordDismissalMetric(env: Env, args: { reason: DismissReason }): Promise<void> {
  await metricsStub(env).recordBatch({
    owner: "",
    repo: "",
    prNumber: 0,
    headSha: "",
    events: [{ kind: "dismissal-reason", reason: args.reason }],
  })
}

export function queryDismissalMetrics(env: Env, windowDays: number): Promise<DismissalMetricsQuery> {
  // Direct return — see `queryValidationMetrics` for the no-async rationale.
  return metricsStub(env).queryDismissals({ windowDays })
}

/**
 * SIG-217: record a batch of repeat-FP events (content-fingerprint re-fires,
 * severity-escalation attempts, decay-window expiries) for one PR review.
 * Caller owns the non-fatal try/catch — telemetry must never break a review.
 */
export async function recordRepeatFpMetrics(env: Env, args: RecordRepeatFpArgs): Promise<void> {
  await metricsStub(env).recordRepeatFps(args)
}

export function queryRepeatFpMetrics(env: Env, windowDays: number): Promise<RepeatFpMetricsQuery> {
  // Direct return — see `queryValidationMetrics` for the no-async rationale.
  return metricsStub(env).queryRepeatFps({ windowDays })
}
