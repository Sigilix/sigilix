// SIG-119: thin typed wrappers for the single global ValidationMetricsDO.
// Resolves the fixed DO stub and forwards record/query RPCs. Callers own the
// non-fatal try/catch (telemetry must never break a review or a request).
//
// SIG-173: dismissal-reason rollups share the same DO (it's the natural
// per-reason counter surface) but flow through dedicated record/query
// helpers so callers don't have to know about the synthetic-gate encoding.

import type { Env } from "../index"
import type {
  ValidationMetricsDO,
  RecordBatchArgs,
  ValidationMetricsQuery,
  DismissalMetricsQuery,
} from "../do/validation-metrics"
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

export async function queryValidationMetrics(
  env: Env,
  windowDays: number,
): Promise<ValidationMetricsQuery> {
  return metricsStub(env).query({ windowDays })
}

/**
 * SIG-173: record one `@sigilix dismiss <reason>` event. `owner/repo/prNumber`
 * are accepted but unused for dismissal events inside the DO — `recordBatch`
 * skips the `last_seen_pr` update for the dismissal path so a dismiss never
 * pollutes the validator-rejection PR-head tracker. The placeholders here
 * keep the DO's `RecordBatchArgs` signature uniform across both event kinds.
 */
export async function recordDismissalMetric(
  env: Env,
  args: { reason: DismissReason; owner?: string; repo?: string; prNumber?: number },
): Promise<void> {
  await metricsStub(env).recordBatch({
    owner: args.owner ?? "",
    repo: args.repo ?? "",
    prNumber: args.prNumber ?? 0,
    headSha: "",
    events: [{ kind: "dismissal-reason", reason: args.reason }],
  })
}

export async function queryDismissalMetrics(
  env: Env,
  windowDays: number,
): Promise<DismissalMetricsQuery> {
  return metricsStub(env).queryDismissals({ windowDays })
}
